/* Referrals (2026-10-12), against the LOCAL test database only: codes, attribution at sign-up, who qualifies and when,
   rewards as personal coupons in the existing coupon engine, redemption, the customer's and the staff's views, and that
   nothing is rewarded twice however often or however simultaneously the check runs.
   Customer flows run as the real kitsyuu_website role, staff flows and the reward job as kitsyuu_admin; setup and checks as
   the owner. Run by apps/admin/tests/run-e2e.mjs, or:
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/referrals.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, placeOrderInput, settingUpdateInput} from '@kitsyuu/contracts';
import {
  addCartLine, attributeReferral, databaseDiscounts, defaultCommerceConfig, getCustomerCart, getMyReferral, listDiscounts, listReferrals, placeOrder, preparePayment,
  processReferralRewards, referralSettings, rejectReferral, removeCartLine, runReferralRewards, saveCustomerAddress, setCartCoupon, settingsShipping, submitPaymentResult,
  testPaymentProvider, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 8});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'referrals.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const key = () => randomBytes(16).toString('hex');
const DAY = 86_400_000;

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'referrals test passphrase', fullName: role}, ctx)).token);
}
const set = (k, value) => updateSetting(admin, root, settingUpdateInput.parse({key: k, value}), ctx);
/** A customer as sign-up leaves them: just created, email not confirmed yet. */
const signUp = async (email, phone = null) => P((await q(`insert into customers (email, full_name, phone) values ($1, 'Test Customer', $2) returning id`, [email, phone]))[0].id, email);
const confirm = p => q(`update customers set email_verified_at = now() where id = $1`, [p.customerId]);
const member = async (email, phone = null) => { const p = await signUp(email, phone); await confirm(p); return p; };
/** An order of the customer written directly, with its delivery time when delivered. */
async function order(p, status, {deliveredAgoDays = 0, createdAgoDays = 0, phone = null, paymentStatus = 'paid'} = {}) {
  const [o] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, created_at)
    values ('KTS-REF-' || upper(substr(md5(random()::text), 1, 8)), $1, $2, $3, 200000, 200000, $4, '{}', now() - make_interval(days => $5)) returning id`,
    [p.customerId, status, paymentStatus, JSON.stringify({phone}), createdAgoDays]);
  if (status === 'delivered') await q(`insert into order_status_history (order_id, from_status, to_status, created_at) values ($1, 'shipped', 'delivered', now() - make_interval(days => $2))`, [o.id, deliveredAgoDays]);
  return o.id;
}
const refer = async (referrer, email, phone = null) => {
  const code = (await getMyReferral(web, referrer)).code;
  const p = await signUp(email, phone);
  assert.deepEqual(await attributeReferral(web, {email, code}, ctx), {attributed: true});
  await confirm(p);
  return p;
};
const state = p => q(`select status, reject_reason from referrals where referred_id = $1`, [p.customerId]).then(r => r[0]);
const rewardsOf = p => q(`select w.role, d.code, d.value, d.min_order_paise, d.usage_limit, d.per_customer_limit, d.customer_id, d.is_active, d.ends_at from referral_rewards w join discounts d on d.id = w.discount_id where w.customer_id = $1 order by w.created_at`, [p.customerId]);

let root, support, marketer, prod, size, anu;

before(async () => {
  root = await staff('ref.root@test.local', 'super_admin');
  support = await staff('ref.support@test.local', 'support');                       // no marketing permission
  const [role] = await q(`insert into roles (code, name, description, is_system) values ('ref_marketing', 'Marketing only', 'test', false) returning id`);
  await q(`insert into role_permissions (role_id, permission_code) select $1, code from permissions where code in ('marketing.read')`, [role.id]);
  marketer = await staff('ref.marketing@test.local', 'ref_marketing');             // marketing.read, not customers.read, not marketing.manage
  [prod] = await q(`select id, price_paise from products where status = 'active' order by price_paise desc, id limit 1`);
  [size] = await q(`select id, size from product_variants where product_id = $1 and is_active order by sort_order limit 1`, [prod.id]);
  anu = await member('ref.anu@test.local', '9840011111');                           // the referrer in most tests
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('off until switched on: no code, no attribution, no reward; the approved values are settings, not code', async () => {
  assert.deepEqual(await referralSettings(web), {enabled: false, rewardPaise: 20000, validDays: 30, minOrderPaise: 100000}, 'the store\'s role reads the settings');
  assert.equal((await getMyReferral(web, anu)).code, null);
  const p = await signUp('ref.early@test.local');
  assert.deepEqual(await attributeReferral(web, {email: p.email, code: 'ABCDEFGH'}, ctx), {attributed: false, reason: 'off'});
  assert.deepEqual(await processReferralRewards(admin), {checked: 0, rewarded: 0, rejected: 0, waiting: 0, off: true});
  await set('referrals.enabled', 'on');
});

test('code: one per customer, however often or however simultaneously it is asked for', async () => {
  const many = await Promise.all(Array.from({length: 6}, () => getMyReferral(web, anu)));
  const codes = new Set(many.map(m => m.code));
  assert.equal(codes.size, 1); assert.match([...codes][0], /^[A-Z2-9]{8}$/);
  assert.equal((await q(`select count(*)::int n from referral_codes where customer_id = $1`, [anu.customerId]))[0].n, 1);
});

test('attribution: only the account just created, once, never oneself, never an existing account or customer', async () => {
  const code = (await getMyReferral(web, anu)).code;
  const bala = await signUp('ref.bala@test.local');
  assert.deepEqual(await attributeReferral(web, {email: 'REF.Bala@test.local ', code: ` ${code.toLowerCase()} `}, ctx), {attributed: true}, 'the code as typed, in any case');
  assert.deepEqual(await attributeReferral(web, {email: bala.email, code}, ctx), {attributed: false, reason: 'already_referred'});
  const other = await member('ref.other@test.local');
  assert.deepEqual(await attributeReferral(web, {email: bala.email, code: (await getMyReferral(web, other)).code}, ctx), {attributed: false, reason: 'already_referred'}, 'a second referrer cannot take them over');
  assert.equal((await q(`select count(*)::int n from referrals where referred_id = $1`, [bala.customerId]))[0].n, 1);
  for (const [email, c, reason] of [[anu.email, code, 'self'], ['ref.nobody@test.local', code, 'no_account'], [(await signUp('ref.badcode@test.local')).email, 'ZZZZZZZZ', 'unknown_code'],
    [(await signUp('ref.nocode@test.local')).email, 'x', 'no_code'], [(await member('ref.confirmed@test.local')).email, code, 'existing_account']])
    assert.deepEqual(await attributeReferral(web, {email, code: c}, ctx), {attributed: false, reason}, reason);
  const old = await signUp('ref.old@test.local');
  await q(`update customers set created_at = now() - interval '2 hours' where id = $1`, [old.customerId]);
  assert.deepEqual(await attributeReferral(web, {email: old.email, code}, ctx), {attributed: false, reason: 'existing_account'}, 'an account from earlier is not "just created"');
  const buyer = await signUp('ref.buyer@test.local'); await order(buyer, 'pending_payment', {paymentStatus: 'pending'});
  assert.deepEqual(await attributeReferral(web, {email: buyer.email, code}, ctx), {attributed: false, reason: 'existing_customer'});
  // The database itself refuses a self-referral and a second referral of the same customer, whatever the code path.
  await assert.rejects(q(`insert into referrals (referrer_id, referred_id, code) values ($1, $1, $2)`, [anu.customerId, code]), /referrals_not_self/);
  await assert.rejects(q(`insert into referrals (referrer_id, referred_id, code) values ($1, $2, $3)`, [other.customerId, bala.customerId, code]), /referrals_referred_id_key|duplicate/);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'referral.attributed'`))[0].n, 1, 'only the real attribution is in the audit log');
});

test('a reward is never given for entering a code: only for a delivered first order, after the return period', async () => {
  await set('returns.enabled', 'on'); await set('returns.window_days', '7');
  const chitra = await refer(anu, 'ref.chitra@test.local');
  const run = async now => { await processReferralRewards(admin, {now}); return (await state(chitra)).status; };
  assert.equal(await run(), 'pending', 'no order yet');
  const o = await order(chitra, 'pending_payment', {paymentStatus: 'pending'});
  assert.equal(await run(), 'pending', 'an unpaid order');
  for (const s of ['paid', 'processing', 'shipped']) { await q(`update orders set status = $2, payment_status = 'paid' where id = $1`, [o, s]); assert.equal(await run(), 'pending', `${s}: not delivered yet`); }
  await q(`update orders set status = 'delivered' where id = $1`, [o]);
  await q(`insert into order_status_history (order_id, from_status, to_status) values ($1, 'shipped', 'delivered')`, [o]);
  assert.equal(await run(), 'pending', 'delivered today: the 7-day return period is not over');
  assert.equal(await run(new Date(Date.now() + 6 * DAY)), 'pending', 'day 6');
  assert.equal((await q(`select count(*)::int n from referral_rewards`))[0].n, 0);
  assert.equal(await run(new Date(Date.now() + 8 * DAY)), 'rewarded', 'after the return period');
  const [mine, theirs] = [await rewardsOf(anu), await rewardsOf(chitra)];
  assert.deepEqual([mine.length, theirs.length, mine[0].role, theirs[0].role], [1, 1, 'referrer', 'referred'], 'one coupon each');
  for (const [r, who] of [[mine[0], anu], [theirs[0], chitra]]) {
    assert.deepEqual([r.value, r.min_order_paise, r.usage_limit, r.per_customer_limit, r.customer_id, r.is_active], [20000, 100000, 1, 1, who.customerId, true], 'the configured reward, single use, personal');
    assert.match(r.code, /^REF-[A-Z2-9]{10}$/);
    assert.ok(Math.abs(new Date(r.ends_at).getTime() - (Date.now() + 38 * DAY)) < DAY, 'valid for the configured 30 days from the day it was given');
  }
  assert.notEqual(mine[0].code, theirs[0].code);
  const [ref] = await q(`select qualifying_order_id, rewarded_at from referrals where referred_id = $1`, [chitra.customerId]);
  assert.deepEqual([ref.qualifying_order_id, !!ref.rewarded_at], [o, true]);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'referral.rewarded' and entity_id = (select id::text from referrals where referred_id = $1)`, [chitra.customerId]))[0].n, 1);
});

test('exactly one reward each: running the check again, or twice at the same moment, changes nothing', async () => {
  const before = (await q(`select count(*)::int n from referral_rewards`))[0].n;
  assert.deepEqual(await processReferralRewards(admin, {now: new Date(Date.now() + 30 * DAY)}).then(r => r.rewarded), 0, 'already rewarded referrals are not looked at again');
  const dev = await refer(anu, 'ref.dev@test.local');
  await order(dev, 'delivered', {deliveredAgoDays: 10});
  const later = new Date(Date.now() + DAY);
  const runs = await Promise.all(Array.from({length: 4}, () => processReferralRewards(admin, {now: later})));
  assert.equal(runs.reduce((n, r) => n + r.rewarded, 0), 1, 'four simultaneous runs: one of them rewarded it');
  assert.equal((await q(`select count(*)::int n from referral_rewards`))[0].n, before + 2, 'two coupons were added: one per party');
  assert.deepEqual([(await rewardsOf(dev)).length, (await rewardsOf(anu)).length], [1, 2]);
  // The table itself allows one reward per party per referral.
  const [r] = await q(`select w.referral_id, w.customer_id, w.discount_id from referral_rewards w where w.customer_id = $1`, [dev.customerId]);
  const [spare] = await q(`insert into discounts (name, code, kind, value, scope, is_active) values ('spare', 'SPARE01', 'fixed', 100, 'order', false) returning id`);
  await assert.rejects(q(`insert into referral_rewards (referral_id, customer_id, role, discount_id) values ($1, $2, 'referred', $3)`, [r.referral_id, r.customer_id, spare.id]), /duplicate|unique/);
});

test('not rewarded: cancelled, failed, refunded or returned orders; a customer who had ordered before; shared phone; disabled or unconfirmed accounts', async () => {
  const far = new Date(Date.now() + 60 * DAY);
  const check = async (p, expected, why) => { await processReferralRewards(admin, {now: far}); const s = await state(p); assert.equal(s.status, expected, why); return s; };
  const a = await refer(anu, 'ref.case-a@test.local'); await order(a, 'cancelled', {paymentStatus: 'unpaid'}); await order(a, 'payment_failed', {paymentStatus: 'failed'});
  await check(a, 'pending', 'cancelled and failed orders never qualify');
  const b = await refer(anu, 'ref.case-b@test.local'); const ob = await order(b, 'delivered', {deliveredAgoDays: 20});
  const [pb] = await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status) values ($1, 'test', 'pay_refb', 200000, 'captured') returning id`, [ob]);
  await q(`insert into refunds (payment_id, order_id, amount_paise, reason, status) values ($1, $2, 200000, 'returned', 'processed')`, [pb.id, ob]);
  await check(b, 'pending', 'a refunded order does not qualify');
  const c = await refer(anu, 'ref.case-c@test.local'); const oc = await order(c, 'delivered', {deliveredAgoDays: 20});
  await q(`insert into return_requests (order_id, customer_id, status, reason_code) values ($1, $2, 'requested', 'other')`, [oc, c.customerId]);
  await check(c, 'pending', 'an order with a return in progress does not qualify');
  // …but a later clean delivered order of the same customer does (their first ELIGIBLE order).
  await order(c, 'delivered', {deliveredAgoDays: 15});
  await check(c, 'rewarded', 'the first eligible order qualifies');
  const d = await refer(anu, 'ref.case-d@test.local'); await order(d, 'delivered', {deliveredAgoDays: 20});
  await q(`update referrals set attributed_at = now() - interval '1 day' where referred_id = $1`, [d.customerId]);
  await q(`update orders set created_at = now() - interval '3 days' where customer_id = $1`, [d.customerId]);
  assert.match((await check(d, 'rejected', 'ordered before the referral')).reject_reason, /already ordered before the referral/);
  const e = await refer(anu, 'ref.case-e@test.local', '+91 98400 11111'); await order(e, 'delivered', {deliveredAgoDays: 20});
  assert.match((await check(e, 'rejected', 'the referrer\'s own phone number')).reject_reason, /same phone number/);
  const f = await refer(anu, 'ref.case-f@test.local'); await order(f, 'delivered', {deliveredAgoDays: 20, phone: '9840011111'});
  assert.match((await check(f, 'rejected', 'the order was placed with the referrer\'s phone number')).reject_reason, /same phone number/);
  const g = await refer(anu, 'ref.case-g@test.local'); await order(g, 'delivered', {deliveredAgoDays: 20});
  await q(`update customers set email_verified_at = null where id = $1`, [g.customerId]);
  await check(g, 'pending', 'an unconfirmed account waits');
  const lost = await member('ref.lost@test.local'); const h = await refer(lost, 'ref.case-h@test.local'); await order(h, 'delivered', {deliveredAgoDays: 20});
  await q(`update customers set status = 'disabled' where id = $1`, [lost.customerId]);
  assert.match((await check(h, 'rejected', 'the referrer\'s account is disabled')).reject_reason, /disabled/);
  for (const p of [a, b, d, e, f, g, h]) assert.equal((await rewardsOf(p)).length, 0, `${p.email}: no coupon`);
  assert.equal((await q(`select count(*)::int n from referral_rewards w join referrals r on r.id = w.referral_id where r.status <> 'rewarded'`))[0].n, 0, 'no reward exists for a referral that is not rewarded');
});

test('with returns switched off there is no return period to wait for: a delivered first order qualifies', async () => {
  await set('returns.enabled', 'off');
  const p = await refer(anu, 'ref.noreturns@test.local'); await order(p, 'delivered', {deliveredAgoDays: 0});
  await processReferralRewards(admin);
  assert.equal((await state(p)).status, 'rewarded');
  await set('returns.enabled', 'on');
});

test('a reward is a coupon in the store\'s own coupon engine: the owner uses it once, within its minimum; nobody else can', async () => {
  await set('discounts.enabled', 'on');
  const [mine] = await rewardsOf(anu);
  const address = await saveCustomerAddress(web, anu, {fullName: 'Anu', phone: '9876543210', line1: '12 Test Street', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true}, ctx);
  const addressId = typeof address === 'string' ? address : (await q(`select id from addresses where customer_id = $1`, [anu.customerId]))[0].id;
  const a = (await q(`select state, pin, country from addresses where id = $1`, [addressId]))[0];
  const cartOf = async (p, qty) => { for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l); await addCartLine(web, p, {productId: prod.id, size: size.size, qty}); return getCustomerCart(web, p, config(), a); };
  const qty = Math.min(10, Math.ceil(100000 / prod.price_paise));
  assert.ok(prod.price_paise * qty >= 100000, 'the test cart reaches the coupon\'s minimum order');
  await setCartCoupon(web, anu, mine.code);
  const full = await cartOf(anu, qty);
  assert.deepEqual([full.totals.coupon.applied, full.totals.discountPaise], [true, 20000], 'the reward amount, as a coupon line on the bill');
  if (prod.price_paise < 100000) { const small = await cartOf(anu, 1); assert.deepEqual([small.totals.coupon.applied, /Spend .* or more/.test(small.totals.coupon.message)], [false, true], 'below the minimum order'); }
  // Somebody else types the code: refused. A cart with no signed-in customer: refused.
  const thief = await member('ref.thief@test.local');
  await assert.rejects(setCartCoupon(web, thief, mine.code), e => e instanceof DomainError && /belongs to another account/.test(e.message));
  const lines = [{productId: prod.id, variantId: size.id, qty, unitPaise: prod.price_paise, lineTotalPaise: prod.price_paise * qty}];
  const cartId = (await q(`select id from carts where customer_id = $1 and status = 'active'`, [anu.customerId]))[0].id;
  const guest = await databaseDiscounts.evaluate(web, {lines, subtotalPaise: prod.price_paise * qty, customerId: null, cartId});
  assert.deepEqual([guest.discounts.length, guest.coupon.message], [0, 'This coupon belongs to another account.']);
  // Used once on a paid order, then gone.
  const cart = await cartOf(anu, qty);
  const placed = await placeOrder(web, anu, placeOrderInput.parse({idempotencyKey: key(), addressId, expectedTotalPaise: String(cart.totals.totalPaise)}), ctx, config());
  const start = await preparePayment(web, pay, anu, placed.orderNumber);
  const [o] = await q(`select total_paise, currency, discount_paise from orders where order_number = $1`, [placed.orderNumber]);
  await submitPaymentResult(web, pay, anu, {orderNumber: placed.orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, o.currency, 'success')}, ctx);
  assert.equal(o.discount_paise, 20000);
  await assert.rejects(setCartCoupon(web, anu, mine.code), /fully used|already used/);
  const view = await getMyReferral(web, anu);
  assert.equal(view.rewards.find(r => r.code === mine.code).state, 'used');
  // An expired reward cannot be used.
  const second = (await rewardsOf(anu))[1];
  await q(`update discounts set ends_at = now() - interval '1 minute' where code = $1`, [second.code]);
  await assert.rejects(setCartCoupon(web, anu, second.code), /expired/);
  assert.equal((await getMyReferral(web, anu)).rewards.find(r => r.code === second.code).state, 'expired');
});

test('the customer sees their code, where each referral stands and their rewards; nothing about who the other people are', async () => {
  const view = await getMyReferral(web, anu);
  assert.ok(view.code && view.referrals.length >= 8 && view.rewards.length >= 3);
  assert.deepEqual([...new Set(view.referrals.map(r => r.status))].sort(), ['pending', 'rejected', 'rewarded']);
  assert.deepEqual(Object.keys(view.referrals[0]).sort(), ['attributed_at', 'id', 'rewarded_at', 'status']);
  assert.doesNotMatch(JSON.stringify(view), /@test\.local|referred_id|reject_reason|9840011111/, 'no email, id, phone or rejection reason of another person');
  const chitra = P((await q(`select id from customers where email = 'ref.chitra@test.local'`))[0].id, 'ref.chitra@test.local');
  const theirs = await getMyReferral(web, chitra);
  assert.deepEqual([theirs.referrals.length, theirs.rewards.length, theirs.rewards[0].role, theirs.rewards[0].state], [0, 1, 'referred', 'available'], 'the referred customer sees their own reward and nobody else\'s');
});

test('staff: Marketing sees the activity (customers only with customers.read); rejecting and running are marketing.manage, audited', async () => {
  await assert.rejects(listReferrals(admin, support, {status: 'all', page: 1}), ForbiddenError);
  const all = await listReferrals(admin, root, {status: 'all', page: 1});
  assert.ok(all.rows.length >= 10 && all.names && all.rows.every(r => /@test\.local$/.test(r.referrer_email) && r.referred_id));
  assert.deepEqual([all.settings.rewardPaise, all.rewards.issued, all.rewards.used, all.rewards.paise], [20000, (await q(`select count(*)::int n from referral_rewards`))[0].n, 1, all.rewards.issued * 20000]);
  assert.equal(Object.values(all.counts).reduce((n, x) => n + x, 0), (await q(`select count(*)::int n from referrals`))[0].n);
  const masked = await listReferrals(admin, marketer, {status: 'rewarded', page: 1});
  assert.ok(masked.rows.length >= 3 && !masked.names && masked.rows.every(r => r.status === 'rewarded' && r.referrer_email === null && r.referred_email === null && r.referrer_id === null), 'without customers.read: no customer is named');
  // The business's discount list is its own offers: personal reward coupons are not in it.
  const offers = await listDiscounts(admin, root);
  assert.ok(offers.every(d => !/^REF-/.test(d.code ?? '')));
  // Rejecting.
  const [pending] = await q(`select id from referrals where status = 'pending' limit 1`);
  await assert.rejects(rejectReferral(admin, marketer, {referralId: pending.id, reason: 'Looks like the same person'}, ctx), ForbiddenError);
  await assert.rejects(rejectReferral(admin, root, {referralId: pending.id, reason: ' '}, ctx), DomainError);
  await assert.rejects(rejectReferral(admin, root, {referralId: 'nope', reason: 'Not a referral'}, ctx), NotFoundError);
  await rejectReferral(admin, root, {referralId: pending.id, reason: 'Looks like the same person'}, ctx);
  await assert.rejects(rejectReferral(admin, root, {referralId: pending.id, reason: 'again'}, ctx), ConflictError);
  const [rj] = await q(`select status, reject_reason, rejected_by from referrals where id = $1`, [pending.id]);
  assert.deepEqual([rj.status, rj.reject_reason, rj.rejected_by], ['rejected', 'Looks like the same person', root.staffId]);
  const [rewarded] = await q(`select id from referrals where status = 'rewarded' limit 1`);
  await assert.rejects(rejectReferral(admin, root, {referralId: rewarded.id, reason: 'too late'}, ctx), ConflictError, 'a reward already given is not taken back here');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'referral.reject' and staff_id = $1`, [root.staffId]))[0].n, 1);
  // Running the check by hand.
  await assert.rejects(runReferralRewards(admin, marketer, ctx), ForbiddenError);
  const run = await runReferralRewards(admin, root, ctx);
  assert.equal(run.rewarded, 0);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'referral.run' and staff_id = $1`, [root.staffId]))[0].n, 1);
  // The store's role can never reward or change a referral.
  const webPool = new pg.Pool({connectionString: WEBSITE_DATABASE_URL, max: 1});
  for (const sql of [`update referrals set status = 'rewarded', rewarded_at = now()`, `insert into referral_rewards (referral_id, customer_id, role, discount_id) select id, referrer_id, 'referrer', gen_random_uuid() from referrals limit 1`,
    `insert into discounts (name, code, kind, value, scope, is_active) values ('x', 'FREEMONEY', 'fixed', 99999, 'order', true)`])
    await assert.rejects(webPool.query(sql), e => e.code === '42501', sql);
  await webPool.end();
});

test('integrity: every rewarded referral has exactly two rewards, one per party; no other referral has any', async () => {
  const [x] = await q(`select (select count(*)::int from referrals where status = 'rewarded') rewarded, (select count(*)::int from referral_rewards) rewards,
    (select count(*)::int from (select referral_id from referral_rewards group by referral_id having count(*) <> 2 or count(distinct role) <> 2) y) uneven,
    (select count(*)::int from referral_rewards w join discounts d on d.id = w.discount_id where d.customer_id is distinct from w.customer_id) wrong_owner,
    (select count(*)::int from referrals where referrer_id = referred_id) selfs`);
  assert.deepEqual([x.rewards, x.uneven, x.wrong_owner, x.selfs], [x.rewarded * 2, 0, 0, 0]);
});
