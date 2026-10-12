/* The first-order offer (2026-10-12), against the LOCAL test database only. One of the business's own coupons is named as
   the offer for a customer's first order; the rule it adds (a signed-in customer with no earlier successful order) is
   enforced by the server wherever discounts are evaluated and again when the order is saved. Covered: who is offered it,
   who may use it, what does and does not count as an earlier order, guests, the coupon's own rules (dates, minimum, cap,
   limits, stacking), claiming it once / again / at the same moment, checkout totals, and the POS counter.
   Customer flows run as the real kitsyuu_website role, staff flows as kitsyuu_admin; setup and checks as the owner.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/first-offer.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, placeOrderInput, settingUpdateInput} from '@kitsyuu/contracts';
import {
  FIRST_ORDER_SIGN_IN, FIRST_ORDER_USED, addCartLine, adjustLocationStock, claimFirstOrderOffer, completePosSale, databaseDiscounts, defaultCommerceConfig, firstOrderOffer,
  getCustomerCart, hasSuccessfulOrder, openPosSession, placeOrder, posContext, preparePayment, quotePosSale, recordDiscountRedemptions, removeCartLine, saveCustomerAddress, saveLocation,
  setCartCoupon, settingsShipping, submitPaymentResult, testPaymentProvider, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});      // kitsyuu_admin
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 8});      // kitsyuu_website
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'first-offer.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const key = () => randomBytes(16).toString('hex');

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'first offer test passphrase', fullName: role}, ctx)).token);
}
const set = (k, value) => updateSetting(admin, root, settingUpdateInput.parse({key: k, value}), ctx);
const addr = {fullName: 'Test Customer', phone: '9876543210', line1: '12 Test Street', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true};
async function customer(email) {
  const id = (await owner.insertInto('customers').values({email, full_name: 'Test Customer', email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  const p = P(id, email);
  const address = await saveCustomerAddress(web, p, addr, ctx);
  return {...p, address: typeof address === 'string' ? address : (await q(`select id from addresses where customer_id = $1`, [id]))[0].id};
}
/** The customer's cart with one item, priced as the store prices it. */
async function cart(p, qty = 1) {
  for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l);
  await addCartLine(web, p, {productId: prod.id, size: size.size, qty});
  const a = (await q(`select state, pin, country from addresses where id = $1`, [p.address]))[0];
  return getCustomerCart(web, p, config(), a);
}
const order = (p, total) => placeOrder(web, p, placeOrderInput.parse({idempotencyKey: key(), addressId: p.address, expectedTotalPaise: String(total)}), ctx, config());
async function payOrder(p, orderNumber) {
  const start = await preparePayment(web, pay, p, orderNumber);
  const o = (await q(`select total_paise, currency from orders where order_number = $1`, [orderNumber]))[0];
  return submitPaymentResult(web, pay, p, {orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, o.currency, 'success')}, ctx);
}
/** An order of the customer in a given state, written directly (history from before this test). */
const past = (p, status, paymentStatus) => q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
  values ('KTS-PAST-' || upper(substr(md5(random()::text), 1, 8)), $1, $2, $3, 10000, 10000, '{}', '{}') returning id`, [p.customerId, status, paymentStatus]).then(r => r[0].id);
const coupon = (code, o = {}) => q(`insert into discounts (name, code, kind, value, scope, min_order_paise, max_discount_paise, starts_at, ends_at, is_active, usage_limit, per_customer_limit)
  values ($1, $2, $3, $4, 'order', $5, $6, $7, $8, $9, $10, $11) returning id`, [o.name ?? `Offer ${code ?? 'auto'}`, code, o.kind ?? 'percent', o.value ?? 1000, o.min ?? null, o.max ?? null, o.starts ?? null, o.ends ?? null, o.active ?? true, o.uses ?? null, o.perCustomer ?? null]).then(r => r[0].id);
const claims = id => q(`select count(*)::int n from audit_logs where action = 'offer.first_order_claim' and customer_id = $1`, [id]).then(r => r[0].n);

let root, manager, prod, size, fresh, buyer, unlucky, offerId;

before(async () => {
  root = await staff('offer.root@test.local', 'super_admin');
  manager = await staff('offer.manager@test.local', 'manager');
  [prod] = await q(`select id, price_paise from products where status = 'active' order by id limit 1`);
  [size] = await q(`select id, size from product_variants where product_id = $1 and is_active order by sort_order limit 1`, [prod.id]);
  fresh = await customer('offer.fresh@test.local');        // has never ordered
  buyer = await customer('offer.buyer@test.local');        // has a paid order
  unlucky = await customer('offer.unlucky@test.local');    // only orders that never succeeded
  await past(buyer, 'paid', 'paid');
  for (const [s, ps] of [['cancelled', 'unpaid'], ['payment_failed', 'failed'], ['pending_payment', 'pending']]) await past(unlucky, s, ps);
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('nothing is offered until the business names a coupon and switches discounts on', async () => {
  offerId = await coupon('FIRST10', {max: 15000, perCustomer: 1});              // 10 %, at most ₹150, once per customer
  assert.equal(await firstOrderOffer(web, null), null, 'no coupon is named');
  await set('discounts.first_customer_code', 'first10');                        // typed in lower case: it is the same code
  assert.equal(await firstOrderOffer(web, fresh.customerId), null, 'discounts are switched off');
  await assert.rejects(claimFirstOrderOffer(web, fresh, ctx), e => e instanceof DomainError && /not available/.test(e.message));
  await set('discounts.enabled', 'on');
  assert.deepEqual(await firstOrderOffer(web, null), {code: 'FIRST10', name: 'Offer FIRST10', kind: 'percent', value: 1000, minOrderPaise: null, maxDiscountPaise: 15000, endsAt: null},
    'a guest is shown the offer exactly as the coupon is set up (the store\'s own role can read it)');
});

test('eligibility is the customer\'s own order history: paid or confirmed orders count; failed, cancelled and unpaid ones do not', async () => {
  assert.ok(await firstOrderOffer(web, fresh.customerId), 'never ordered: offered');
  assert.equal(await firstOrderOffer(web, buyer.customerId), null, 'has a paid order: not offered');
  assert.ok(await firstOrderOffer(web, unlucky.customerId), 'a cancelled, a failed and an unpaid order: still a first-time customer');
  assert.deepEqual([await hasSuccessfulOrder(web, fresh.customerId), await hasSuccessfulOrder(web, buyer.customerId), await hasSuccessfulOrder(web, unlucky.customerId)], [false, true, false]);
  for (const s of ['processing', 'shipped', 'delivered']) {
    const c = await customer(`offer.${s}@test.local`); await past(c, s, s === 'processing' ? 'unpaid' : 'paid');
    assert.equal(await firstOrderOffer(web, c.customerId), null, `${s}: a confirmed order counts`);
  }
  // An order from before customer accounts (it names only the old user id) counts for its customer.
  const [au] = await q(`insert into auth.users (email, email_confirmed_at) values ('offer.legacy@test.local', now()) returning id`);
  await q(`insert into customers (id, email, full_name, email_verified_at, legacy_auth_user_id) values ($1, 'offer.legacy@test.local', 'Legacy', now(), $1)`, [au.id]);
  assert.ok(await firstOrderOffer(web, au.id), 'before the old order exists: offered');
  await q(`insert into orders (order_number, user_id, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-PAST-LEGACY', $1, null, 'delivered', 'paid', 100, 100, '{}', '{}')`, [au.id]);
  assert.equal(await firstOrderOffer(web, au.id), null, 'the old order counts');
  // Somebody else's orders never count.
  assert.equal(await hasSuccessfulOrder(web, '00000000-0000-4000-8000-000000000000'), false);
});

test('the offer is used once even while the first order is still unpaid, whatever the coupon\'s own per-customer limit', async () => {
  // Found in the 2026-10-12 review: an order waiting for payment is not a "successful order", so with no per-customer limit
  // on the coupon the offer could go onto several unpaid orders in a row.
  const [before] = await q(`select per_customer_limit from discounts where id = $1`, [offerId]);
  await q(`update discounts set per_customer_limit = null where id = $1`, [offerId]);
  const twice = await customer('offer.twice@test.local');
  assert.ok(await firstOrderOffer(web, twice.customerId), 'a first-time customer is offered it');
  const unpaid = await past(twice, 'pending_payment', 'pending');
  await q(`insert into discount_redemptions (discount_id, order_id, customer_id, code, amount_paise) values ($1, $2, $3, 'FIRST10', 100)`, [offerId, unpaid, twice.customerId]);
  assert.equal(await firstOrderOffer(web, twice.customerId), null, 'it is on an unpaid order of theirs: not offered again');
  await assert.rejects(claimFirstOrderOffer(web, twice, ctx), e => e instanceof DomainError && /already on another order of yours/.test(e.message));
  assert.ok(await firstOrderOffer(web, fresh.customerId), 'another customer is not affected');
  await q(`update orders set status = 'cancelled' where id = $1`, [unpaid]);
  assert.ok(await firstOrderOffer(web, twice.customerId), 'that order was cancelled: the offer is theirs to use again');
  await q(`update discounts set per_customer_limit = $2 where id = $1`, [offerId, before.per_customer_limit]);
});

test('the coupon\'s own rules still decide: inactive, not started, expired, used up, switched off', async () => {
  const offered = () => firstOrderOffer(web, fresh.customerId);
  const claim = () => claimFirstOrderOffer(web, fresh, ctx);
  for (const [change, undo, why] of [
    [`is_active = false`, `is_active = true`, /not available/],
    [`starts_at = now() + interval '2 days'`, `starts_at = null`, /not valid yet/],
    [`ends_at = now() - interval '1 minute', starts_at = now() - interval '2 days'`, `ends_at = null, starts_at = null`, /expired/],
  ]) {
    await q(`update discounts set ${change} where id = $1`, [offerId]);
    assert.equal(await offered(), null, change);
    assert.equal(await firstOrderOffer(web, null), null, `${change}: not shown to a guest either`);
    await assert.rejects(claim(), e => e instanceof DomainError && why.test(e.message), change);
    await q(`update discounts set ${undo} where id = $1`, [offerId]);
  }
  await q(`update discounts set usage_limit = 0 + 1 where id = $1`, [offerId]);
  const other = await customer('offer.other@test.local');
  const taken = await past(other, 'pending_payment', 'pending');
  await q(`insert into discount_redemptions (discount_id, order_id, customer_id, code, amount_paise) values ($1, $2, $3, 'FIRST10', 100)`, [offerId, taken, other.customerId]);
  assert.equal(await offered(), null, 'every use is taken');
  await assert.rejects(claim(), /fully used/);
  await q(`delete from discount_redemptions where order_id = $1`, [taken]); await q(`update orders set status = 'cancelled' where id = $1`, [taken]);
  await q(`update discounts set usage_limit = null where id = $1`, [offerId]);
  const future = new Date(Date.now() + 86_400_000);
  await q(`update discounts set ends_at = $2 where id = $1`, [offerId, future]);
  assert.equal((await offered()).endsAt.getTime(), future.getTime(), 'the end date shown is the coupon\'s own');
  await q(`update discounts set ends_at = null where id = $1`, [offerId]);
  assert.equal(await claims(fresh.customerId), 0, 'no refused attempt was recorded as a claim');
});

test('claiming puts the coupon on the customer\'s own cart, once, however often or however many at once it is asked', async () => {
  assert.equal(claimFirstOrderOffer.length <= 3, true);                           // (db, customer, context): no code, no amount, no customer id from the caller
  const first = await claimFirstOrderOffer(web, fresh, ctx);
  assert.deepEqual(first, {code: 'FIRST10', already: false});
  assert.deepEqual(await claimFirstOrderOffer(web, fresh, ctx), {code: 'FIRST10', already: true}, 'asking again changes nothing');
  assert.equal((await q(`select coupon_code from carts where customer_id = $1 and status = 'active'`, [fresh.customerId]))[0].coupon_code, 'FIRST10');
  assert.equal(await claims(fresh.customerId), 1, 'one audited claim');
  assert.equal((await q(`select count(*)::int n from discounts`))[0].n, 1, 'claiming creates no coupon: there is still the one the business made');
  // Six requests at the same moment (several tabs or devices): all answered, one claim.
  const many = await customer('offer.many@test.local');
  const r = await Promise.allSettled(Array.from({length: 6}, () => claimFirstOrderOffer(web, many, ctx)));
  assert.ok(r.every(x => x.status === 'fulfilled'), r.find(x => x.status === 'rejected')?.reason?.message);
  assert.deepEqual([r.filter(x => !x.value.already).length, await claims(many.customerId), (await q(`select count(*)::int n from carts where customer_id = $1`, [many.customerId]))[0].n], [1, 1, 1]);
  // A customer who already has an order is refused with the reason, and nothing is put on their cart or recorded.
  await assert.rejects(claimFirstOrderOffer(web, buyer, ctx), e => e instanceof DomainError && e.message === FIRST_ORDER_USED);
  assert.equal(await claims(buyer.customerId), 0);
  assert.equal((await q(`select count(*)::int n from carts where customer_id = $1 and coupon_code is not null`, [buyer.customerId]))[0].n, 0);
});

test('at the cart: the eligible customer gets the coupon\'s discount with its cap and minimum; typing the code does not help anyone else', async () => {
  const c = await cart(fresh);
  const tenth = Math.floor(prod.price_paise / 10), expect = Math.min(tenth, 15000);
  assert.deepEqual([c.totals.coupon.applied, c.totals.discountPaise, c.totals.totalPaise], [true, expect, c.totals.subtotalPaise - expect + c.totals.shippingPaise]);
  // Minimum purchase and maximum discount are the coupon's.
  await q(`update discounts set min_order_paise = $2 where id = $1`, [offerId, prod.price_paise + 1]);
  const low = await cart(fresh);
  assert.deepEqual([low.totals.coupon.applied, /Spend .* or more/.test(low.totals.coupon.message), low.totals.discountPaise], [false, true, 0]);
  await q(`update discounts set min_order_paise = null, max_discount_paise = 100 where id = $1`, [offerId]);
  assert.equal((await cart(fresh)).totals.discountPaise, 100, 'never more than the cap');
  await q(`update discounts set max_discount_paise = 15000 where id = $1`, [offerId]);
  // A customer with an earlier order types the code at checkout: it is kept on the cart, and refused with the reason.
  await setCartCoupon(web, buyer, 'FIRST10');
  const b = await cart(buyer);
  assert.deepEqual([b.totals.coupon.applied, b.totals.coupon.message, b.totals.discountPaise], [false, FIRST_ORDER_USED, 0]);
  // A cart priced with no signed-in customer (a guest): the coupon is never applied.
  const lines = [{productId: prod.id, variantId: size.id, qty: 1, unitPaise: prod.price_paise, lineTotalPaise: prod.price_paise}];
  const cartId = (await q(`select id from carts where customer_id = $1 and status = 'active'`, [fresh.customerId]))[0].id;
  const guest = await databaseDiscounts.evaluate(web, {lines, subtotalPaise: prod.price_paise, customerId: null, cartId});
  assert.deepEqual([guest.discounts.length, guest.coupon.applied, guest.coupon.message], [0, false, FIRST_ORDER_SIGN_IN]);
});

test('stacking follows the store\'s setting: with a bigger discount the offer does not combine unless the business chose "all"', async () => {
  const auto = await coupon(null, {name: 'Sale 30%', value: 3000});
  const best = await cart(fresh);
  assert.deepEqual([best.totals.discounts.map(d => d.label), best.totals.coupon.applied, /bigger discount/.test(best.totals.coupon.message)], [['Sale 30%'], false, true]);
  await set('discounts.stacking', 'all');
  const all = await cart(fresh);
  assert.deepEqual(all.totals.discounts.map(d => d.label).sort(), ['Coupon FIRST10', 'Sale 30%']);
  assert.equal(all.totals.discountPaise, Math.floor(prod.price_paise * 0.3) + Math.min(Math.floor(prod.price_paise / 10), 15000));
  await set('discounts.stacking', 'best');
  await q(`update discounts set is_active = false where id = $1`, [auto]);
});

test('placing the order uses the offer once; after the first successful order it is gone for that customer', async () => {
  const c = await cart(fresh);
  // A total the server did not work out is refused: nothing the browser says about money is trusted.
  await assert.rejects(order(fresh, c.totals.totalPaise - 500), e => e instanceof ConflictError || e instanceof DomainError);
  const placed = await order(fresh, c.totals.totalPaise);
  const [o] = await q(`select id, discount_paise, total_paise, status from orders where order_number = $1`, [placed.orderNumber]);
  assert.deepEqual([o.discount_paise, o.total_paise, o.status], [c.totals.discountPaise, c.totals.totalPaise, 'pending_payment']);
  assert.deepEqual(await q(`select code, amount_paise, customer_id from discount_redemptions where order_id = $1`, [o.id]), [{code: 'FIRST10', amount_paise: c.totals.discountPaise, customer_id: fresh.customerId}]);
  assert.ok(await hasSuccessfulOrder(web, fresh.customerId) === false, 'an order waiting for payment is not yet a successful order');
  await payOrder(fresh, placed.orderNumber);
  assert.equal(await hasSuccessfulOrder(web, fresh.customerId), true);
  assert.equal(await firstOrderOffer(web, fresh.customerId), null, 'no longer offered');
  await assert.rejects(claimFirstOrderOffer(web, fresh, ctx), /already used this coupon|first order only/);
  await assert.rejects(setCartCoupon(web, fresh, 'FIRST10'), /already used this coupon/);
  // Even a coupon with no per-customer limit, once named as the first-order offer, cannot be used on a second order.
  await q(`update discounts set per_customer_limit = null where id = $1`, [offerId]);
  await setCartCoupon(web, fresh, 'FIRST10');
  const second = await cart(fresh);
  assert.deepEqual([second.totals.coupon.applied, second.totals.coupon.message, second.totals.discountPaise], [false, FIRST_ORDER_USED, 0]);
  await q(`update discounts set per_customer_limit = 1 where id = $1`, [offerId]);
  await setCartCoupon(web, fresh, null);
});

test('the rule is checked again under the lock when the order is saved, and two checkouts at once cannot both keep the offer', async () => {
  // Saving an order with the offer for a customer who meanwhile has a successful order is refused (whatever the cart said earlier).
  const line = [{code: 'FIRST10', label: 'Coupon FIRST10', amountPaise: 100, discountId: offerId}];
  const other = await past(buyer, 'pending_payment', 'pending');
  await assert.rejects(owner.transaction().execute(tx => recordDiscountRedemptions(tx, other, buyer.customerId, line)), e => e instanceof ConflictError && /first order only/.test(e.message));
  await assert.rejects(owner.transaction().execute(tx => recordDiscountRedemptions(tx, other, null, line)), e => e instanceof ConflictError && /Sign in/.test(e.message), 'nor for no customer at all');
  assert.equal((await q(`select count(*)::int n from discount_redemptions where order_id = $1`, [other]))[0].n, 0);
  // The same customer, two checkouts of the same cart at the same moment.
  const twin = await customer('offer.twin@test.local');
  await claimFirstOrderOffer(web, twin, ctx);
  const c = await cart(twin);
  const r = await Promise.allSettled([order(twin, c.totals.totalPaise), order(twin, c.totals.totalPaise)]);
  assert.ok(r.some(x => x.status === 'fulfilled'), 'at least one checkout goes through');
  const live = await q(`select o.order_number from discount_redemptions r join orders o on o.id = r.order_id where r.discount_id = $1 and r.customer_id = $2 and o.status not in ('cancelled', 'payment_failed')`, [offerId, twin.customerId]);
  assert.ok(live.length <= 1, `at most one live order holds the offer (found ${live.length})`);
  // Either both checkouts were saved (the later one replaced the earlier, now cancelled) or one was refused. For the test
  // runner's row counts, which must not depend on that timing, the customer always ends with two order rows.
  if ((await q(`select count(*)::int n from orders where customer_id = $1`, [twin.customerId]))[0].n === 1) await past(twin, 'cancelled', 'unpaid');
});

test('at the POS counter the same rule holds: a first-time customer on the bill may use it; a returning or walk-in customer may not', async () => {
  const store = (await saveLocation(admin, root, {code: 'OFFER-S1', name: 'Offer Store', kind: 'retail', address: 'Chennai', active: true}, ctx)).id;
  await adjustLocationStock(admin, manager, {locationId: store, variantId: size.id, delta: 5, reason: 'restock', note: 'first-offer test', expectedQty: 0}, ctx);
  await openPosSession(admin, manager, {locationId: store, openingCashPaise: 0}, ctx);
  const session = (await posContext(admin, manager)).session;
  const lines = [{variantId: size.id, qty: 1}];
  const quote = customerId => quotePosSale(admin, manager, {locationId: store, lines, customerId, discount: null, couponCode: 'FIRST10'});
  assert.deepEqual([(await quote(buyer.customerId)).coupon.applied, (await quote(buyer.customerId)).coupon.message], [false, FIRST_ORDER_USED]);
  assert.equal((await quote(null)).coupon.applied, false, 'a walk-in bill names no customer');
  const walkIn = await customer('offer.counter@test.local');
  const ok = await quote(walkIn.customerId);
  assert.equal(ok.coupon.applied, true);
  // The sale is saved as delivered at once; the order being saved is not an "earlier" order.
  const sale = await completePosSale(admin, manager, {sessionId: session.id, idempotencyKey: key(), lines, customerId: walkIn.customerId, contact: null, discount: null, couponCode: 'FIRST10',
    payment: {method: 'cash', tenderedPaise: ok.totals.totalPaise}, expectedTotalPaise: ok.totals.totalPaise}, ctx);
  assert.equal((await q(`select count(*)::int n from discount_redemptions where order_id = $1`, [sale.orderId]))[0].n, 1);
  assert.deepEqual([(await quote(walkIn.customerId)).coupon.applied, await firstOrderOffer(web, walkIn.customerId)], [false, null], 'and after that sale they are a returning customer');
});

test('integrity: one coupon, at most one live use per customer, and no first-order use by a customer with an earlier successful order', async () => {
  assert.equal((await q(`select count(*)::int n from discounts where code = 'FIRST10'`))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from (select r.customer_id from discount_redemptions r join orders o on o.id = r.order_id
    where r.discount_id = $1 and o.status not in ('cancelled', 'payment_failed') group by r.customer_id having count(*) > 1) x`, [offerId]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from discount_redemptions r join orders o on o.id = r.order_id where r.discount_id = $1 and exists (
    select 1 from orders p where p.customer_id = r.customer_id and p.id <> o.id and p.status in ('paid', 'processing', 'shipped', 'delivered') and p.created_at < o.created_at)`, [offerId]))[0].n, 0);
});
