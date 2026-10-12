/* Unified billing (2026-10-12), against the LOCAL test database only: one bill breakdown for the counter, the stored
   order and the invoice; coupons and loyalty points at the POS counter (the store's own rules: coupon first, then points,
   then tax; limits enforced on the server and under locks); the invoice email (manual, and automatic only when switched
   on; logged as sent or failed). Staff run as the real kitsyuu_admin role; setup and checks use the owner connection.
   No payment provider and no real email: the mailer is an in-memory one.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/billing.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, settingUpdateInput} from '@kitsyuu/contracts';
import {
  EMAIL_EVENTS, adjustLocationStock, adjustLoyaltyPoints, billFromOrder, completePosSale, createInvoiceForOrder, invoiceEmail, listInvoiceEmails, loyaltyBalance,
  notifyInvoiceIssued, openPosSession, posContext, quotePosSale, saveLocation, sendInvoiceEmail, updateSetting, voidInvoice, voidPosSale,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'billing.test', requestId: 'test'};
const key = () => randomBytes(16).toString('hex');
const set = (k, value) => updateSetting(admin, root, settingUpdateInput.parse({key: k, value}), ctx);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'billing test passphrase', fullName: role}, ctx)).token);
}
const coupon = (code, o = {}) => q(`insert into discounts (name, code, kind, value, scope, min_order_paise, max_discount_paise, is_active, usage_limit, per_customer_limit)
  values ($1, $2, $3, $4, 'order', $5, $6, true, $7, $8) returning id`, [o.name ?? code, code, o.kind ?? 'percent', o.value ?? 1000, o.min ?? null, o.max ?? null, o.uses ?? null, o.perCustomer ?? null]).then(r => r[0].id);
const orderRow = async id => (await q(`select * from orders where id = $1`, [id]))[0];
const orders = () => q(`select count(*)::int n from orders`).then(r => r[0].n);

let root, manager, sales, sales2, support, accountant, store, V, meera, arun, sM, sS, sS2;
const one = () => [{variantId: V.id, qty: 1}];
/** Quote, then complete for the quoted total (what the cashier showed the customer). */
async function sell(actor, session, extra = {}) {
  const input = {lines: extra.lines ?? one(), customerId: extra.customerId ?? null, discount: extra.discount ?? null, couponCode: extra.couponCode ?? null, usePoints: extra.usePoints ?? false};
  const quote = await quotePosSale(admin, actor, {locationId: store, ...input});
  const sale = await completePosSale(admin, actor, {sessionId: session.id, idempotencyKey: key(), contact: null, ...input,
    payment: {method: 'cash', tenderedPaise: extra.expected ?? quote.totals.totalPaise}, expectedTotalPaise: extra.expected ?? quote.totals.totalPaise}, ctx);
  return {quote, sale};
}

before(async () => {
  root = await staff('bill.root@test.local', 'super_admin');
  manager = await staff('bill.manager@test.local', 'manager');       // may give staff discounts and void
  sales = await staff('bill.sales@test.local', 'sales');             // a cashier: pos.sell, no orders.discount, no loyalty.read, no finance
  sales2 = await staff('bill.sales2@test.local', 'sales');
  support = await staff('bill.support@test.local', 'support');
  accountant = await staff('bill.accounts@test.local', 'accountant'); // finance.read / finance.manage
  store = (await saveLocation(admin, root, {code: 'BILL-S1', name: 'Billing Store', kind: 'retail', address: 'Chennai', active: true}, ctx)).id;
  V = (await q(`select v.id, v.sku, p.id product_id, p.price_paise from product_variants v join products p on p.id = v.product_id where v.sku = 'KTS-TOP-001-M'`))[0];
  await adjustLocationStock(admin, manager, {locationId: store, variantId: V.id, delta: 60, reason: 'restock', note: 'billing test stock', expectedQty: 0}, ctx);
  const mk = (email, name) => owner.insertInto('customers').values({email, full_name: name, phone: null, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow().then(r => r.id);
  meera = await mk('bill.meera@test.local', 'Meera Bill'); arun = await mk('bill.arun@test.local', 'Arun Bill');
  for (const [a, s] of [[manager, 'sM'], [sales, 'sS'], [sales2, 'sS2']]) await openPosSession(admin, a, {locationId: store, openingCashPaise: 0}, ctx);
  sM = (await posContext(admin, manager)).session; sS = (await posContext(admin, sales)).session; sS2 = (await posContext(admin, sales2)).session;
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

// ---------------------------------------------------------------- the bill
test('bill: one breakdown, the same for the counter and for the stored order; it always adds up', async () => {
  const {quote, sale} = await sell(sales, sS);
  assert.deepEqual(quote.bill.lines.map(l => l.kind), ['subtotal', 'tax', 'total'], 'a plain bill: items, tax (included in the prices), total');
  assert.deepEqual([quote.bill.lines[0].amountPaise, quote.bill.lines.at(-1).amountPaise, quote.bill.consistent], [V.price_paise, V.price_paise, true]);
  assert.deepEqual([quote.coupon, quote.loyalty], [null, null], 'no coupon and no customer: nothing about either');
  const o = await orderRow(sale.orderId);
  assert.deepEqual(billFromOrder(o), quote.bill, 'the order that was saved gives exactly the bill the cashier saw');
  assert.deepEqual([o.discount_paise, o.loyalty_points_used, o.loyalty_discount_paise, o.customer_id], [0, 0, 0, null]);
  // A stored order whose amounts disagree is reported, never silently "fixed".
  assert.equal(billFromOrder({...o, total_paise: o.total_paise + 1, cod_fee_paise: 0}).consistent, false);
  // Discount lines that do not add up to the discount charged (an old order): the one charged amount is shown.
  const old = billFromOrder({...o, discount_paise: 500, total_paise: o.total_paise - 500, pricing: {discounts: [{code: 'X', label: 'x', amountPaise: 100}]}});
  assert.deepEqual(old.lines.filter(l => l.effect === -1).map(l => [l.kind, l.amountPaise]), [['discount', 500]]);
});

// ---------------------------------------------------------------- coupons at the counter
test('coupon at POS: off until discounts are switched on; then the store\'s own rules, with the reason when it does not apply', async () => {
  await coupon('WELCOME10');                                                      // 10 %, no limits
  await coupon('BIGSPEND', {min: 10_000_000});                                     // needs ₹1,00,000
  await coupon('ONCEEACH', {perCustomer: 1});                                      // once per customer
  await coupon('FLAT200', {kind: 'fixed', value: 20000});
  const off = await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: 'WELCOME10'});
  assert.deepEqual([off.coupon.applied, off.coupon.message, off.totals.discountPaise], [false, 'Coupons are not available right now.', 0], 'the master switch is off');
  await set('discounts.enabled', 'on');
  const on = await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: ' welcome10 '});
  assert.deepEqual([on.coupon.code, on.coupon.applied, on.totals.discountPaise, on.totals.totalPaise], ['WELCOME10', true, Math.floor(V.price_paise / 10), V.price_paise - Math.floor(V.price_paise / 10)]);
  assert.deepEqual(on.bill.lines.map(l => [l.kind, l.label]), [['subtotal', 'Items subtotal'], ['coupon', 'Coupon WELCOME10'], ['tax', on.bill.lines[2].label], ['total', 'Total payable']]);
  assert.equal(on.bill.coupon, 'WELCOME10');
  for (const [code, reason] of [['NOPE', /not valid/], ['BIGSPEND', /Spend .* or more/], ['ONCEEACH', /limited per customer: add the customer/], ['bad code!', /not valid/]]) {
    const r = await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: code});
    assert.equal(r.coupon.applied, false, code); assert.match(r.coupon.message, reason, code);
    assert.equal(r.totals.discountPaise, 0, `${code}: nothing is taken off`);
  }
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: 'FLAT200'})).totals.discountPaise, 20000);
});

test('coupon at POS: the sale stores the discount and its use; a coupon that does not apply refuses the sale; nothing is trusted from the client', async () => {
  const before = await orders();
  // Anonymous sale with a coupon that has no per-customer limit.
  const {quote, sale} = await sell(sales, sS, {couponCode: 'WELCOME10'});
  const o = await orderRow(sale.orderId);
  assert.deepEqual([o.customer_id, o.discount_paise, o.total_paise, o.pricing.coupon], [null, Math.floor(V.price_paise / 10), quote.totals.totalPaise, 'WELCOME10']);
  assert.deepEqual(billFromOrder(o), quote.bill);
  assert.deepEqual(await q(`select code, amount_paise, customer_id from discount_redemptions where order_id = $1`, [o.id]), [{code: 'WELCOME10', amount_paise: o.discount_paise, customer_id: null}]);
  assert.equal((await q(`select after_data->>'coupon' c from audit_logs where action = 'pos.sale' and entity_id = $1`, [o.id]))[0].c, 'WELCOME10');
  // A coupon that does not apply: the sale is refused with the reason, whatever total the client sends.
  const bad = c => completePosSale(admin, sales, {sessionId: sS.id, idempotencyKey: key(), lines: one(), customerId: null, contact: null, discount: null, couponCode: c,
    payment: {method: 'cash', tenderedPaise: V.price_paise}, expectedTotalPaise: V.price_paise}, ctx);
  await assert.rejects(bad('NOPE'), e => e instanceof ConflictError && /Coupon NOPE was not applied: This coupon code is not valid/.test(e.message));
  await assert.rejects(bad('ONCEEACH'), /limited per customer/);
  // The client claims a lower total than the server works out: refused.
  await assert.rejects(completePosSale(admin, sales, {sessionId: sS.id, idempotencyKey: key(), lines: one(), customerId: null, contact: null, discount: null, couponCode: 'WELCOME10',
    payment: {method: 'cash', tenderedPaise: 100}, expectedTotalPaise: 100}, ctx), /total changed/);
  assert.equal(await orders(), before + 1, 'only the valid sale exists');
  // Per-customer coupon: with the customer on the bill it applies once, then says why not.
  const first = await sell(sales, sS, {couponCode: 'ONCEEACH', customerId: meera});
  assert.equal((await orderRow(first.sale.orderId)).discount_paise, Math.floor(V.price_paise / 10));
  const again = await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: meera, discount: null, couponCode: 'ONCEEACH'});
  assert.deepEqual([again.coupon.applied, again.coupon.message], [false, 'You have already used this coupon the maximum number of times.']);
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: arun, discount: null, couponCode: 'ONCEEACH'})).coupon.applied, true, 'another customer still can');
});

test('coupon at POS: a usage limit holds when two tills use the last one at the same moment', async () => {
  await coupon('LASTONE', {uses: 1});
  const total = (await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: 'LASTONE'})).totals.totalPaise;
  const go = (actor, s) => completePosSale(admin, actor, {sessionId: s.id, idempotencyKey: key(), lines: one(), customerId: null, contact: null, discount: null, couponCode: 'LASTONE',
    payment: {method: 'cash', tenderedPaise: total}, expectedTotalPaise: total}, ctx);
  const r = await Promise.allSettled([go(sales, sS), go(sales2, sS2)]);
  assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected'], 'exactly one of the two sales took the last use');
  assert.match(r.find(x => x.status === 'rejected').reason.message, /fully used/);
  assert.equal((await q(`select count(*)::int n from discount_redemptions r join discounts d on d.id = r.discount_id where d.code = 'LASTONE'`))[0].n, 1);
});

test('staff discount with a coupon follows the stacking setting, as the store does', async () => {
  await set('discounts.staff_max_percent', '10');
  const staff10 = {percent: 10, reason: 'Festival'}, staff5 = {percent: 5, reason: 'Regular'};
  await coupon('FIVEOFF', {value: 500});                                           // 5 %
  // Default (nothing chosen) = only the largest discount.
  const best = await quotePosSale(admin, manager, {locationId: store, lines: one(), discount: staff10, couponCode: 'FIVEOFF'});
  assert.deepEqual(best.totals.discounts.map(d => d.code), ['STAFF'], 'the bigger one only');
  assert.deepEqual([best.coupon.applied, /bigger discount already applies/.test(best.coupon.message)], [false, true]);
  await assert.rejects(sell(manager, sM, {discount: staff10, couponCode: 'FIVEOFF'}), /Coupon FIVEOFF was not applied/, 'the cashier removes the coupon or the discount; the sale is not silently changed');
  const other = await sell(manager, sM, {discount: staff5, couponCode: 'WELCOME10'});   // the coupon is bigger
  const o1 = await orderRow(other.sale.orderId);
  assert.deepEqual([other.quote.totals.discounts.map(d => d.code), o1.staff_discount_paise, o1.staff_discount_reason, o1.staff_discount_bp], [['WELCOME10'], 0, null, null], 'no staff discount is recorded when it was not given');
  // "All": both, staff discount and coupon, each on its own line; never more than the goods.
  await set('discounts.stacking', 'all');
  const all = await sell(manager, sM, {discount: staff10, couponCode: 'FIVEOFF'});
  const o2 = await orderRow(all.sale.orderId);
  const s = Math.round(V.price_paise * 0.10), c = Math.floor(V.price_paise * 0.05);
  assert.deepEqual(all.quote.bill.lines.filter(l => l.effect === -1).map(l => [l.kind, l.amountPaise]), [['staff_discount', s], ['coupon', c]]);
  assert.deepEqual([o2.discount_paise, o2.staff_discount_paise, o2.total_paise], [s + c, s, V.price_paise - s - c]);
  assert.deepEqual(billFromOrder(o2), all.quote.bill);
  // A cashier without orders.discount still cannot give a staff discount, with or without a coupon.
  await assert.rejects(quotePosSale(admin, sales, {locationId: store, lines: one(), discount: staff5, couponCode: 'FIVEOFF'}), ForbiddenError);
  await set('discounts.stacking', 'best');
});

// ---------------------------------------------------------------- loyalty points at the counter
test('loyalty at POS: off until the business sets it; then the cashier sees the linked customer\'s points and what they can take off', async () => {
  await adjustLoyaltyPoints(admin, root, {customerId: meera, points: 300, reason: 'billing test'}, ctx);
  const off = await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: meera, discount: null, usePoints: true});
  assert.deepEqual([off.loyalty.redeemable, off.loyalty.usedPoints, off.totals.discountPaise], [false, 0, 0], 'loyalty is off: nothing can be used');
  await set('loyalty.enabled', 'on'); await set('loyalty.point_value_paise', '1');        // one point takes ₹1 off (the business's value, entered here for the test)
  const see = await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: meera, discount: null, usePoints: false});
  assert.deepEqual([see.loyalty.balance, see.loyalty.usablePoints, see.loyalty.usableValuePaise, see.loyalty.usedPoints, see.totals.totalPaise], [300, 300, 30000, 0, V.price_paise],
    'a cashier (no loyalty.read) sees the balance of the customer on the bill; nothing is used until asked');
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: null, discount: null, usePoints: true})).loyalty, null, 'no customer: no points');
  await assert.rejects(completePosSale(admin, sales, {sessionId: sS.id, idempotencyKey: key(), lines: one(), customerId: null, contact: null, discount: null, usePoints: true,
    payment: {method: 'cash', tenderedPaise: V.price_paise}, expectedTotalPaise: V.price_paise}, ctx), e => e instanceof DomainError && /need a customer/.test(e.message));
});

test('loyalty at POS: coupon first, then points on what is left, then tax; the sale takes the points once and records them', async () => {
  // A real tax rate so the order of the steps is visible in the tax: 5 %, inside the prices, from today.
  await q(`insert into tax_rates (code, label, rate_bp, is_inclusive, valid_from) values ('BILLTEST5', 'GST 5%', 500, true, (now() at time zone 'Asia/Kolkata')::date)`);
  const quote = await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: meera, discount: null, couponCode: 'WELCOME10', usePoints: true});
  const couponOff = Math.floor(V.price_paise / 10), afterCoupon = V.price_paise - couponOff, pointsOff = Math.min(300 * 100, afterCoupon), taxable = afterCoupon - pointsOff;
  assert.deepEqual(quote.bill.lines.map(l => [l.kind, l.amountPaise]), [['subtotal', V.price_paise], ['coupon', couponOff], ['loyalty', pointsOff],
    ['tax', Math.round(taxable * 500 / 10500)], ['total', taxable]], 'coupon, then points on the rest, then tax on what is charged');
  assert.deepEqual([quote.loyalty.usedPoints, quote.bill.points, quote.bill.consistent], [pointsOff / 100, {used: pointsOff / 100, valuePaise: pointsOff}, true]);
  const {sale} = await sell(sales, sS, {customerId: meera, couponCode: 'WELCOME10', usePoints: true});
  const o = await orderRow(sale.orderId);
  assert.deepEqual([o.loyalty_points_used, o.loyalty_discount_paise, o.discount_paise, o.total_paise, o.tax_paise], [pointsOff / 100, pointsOff, couponOff + pointsOff, taxable, Math.round(taxable * 500 / 10500)]);
  assert.deepEqual(billFromOrder(o), quote.bill, 'the stored order shows the same bill');
  assert.equal(await loyaltyBalance(admin, meera), 300 - pointsOff / 100);
  assert.deepEqual(await q(`select kind, points from loyalty_transactions where order_id = $1 order by created_at`, [o.id]), [{kind: 'redeem', points: -pointsOff / 100}]);
  await q(`delete from tax_rates where code = 'BILLTEST5'`);
});

test('loyalty at POS: the configured maximum holds; points that cannot be used refuse the sale; two tills cannot spend the same points', async () => {
  await adjustLoyaltyPoints(admin, root, {customerId: arun, points: 400, reason: 'billing test'}, ctx);
  await set('loyalty.max_redeem_points', '100');
  const capped = await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: arun, discount: null, usePoints: true});
  assert.deepEqual([capped.loyalty.usedPoints, capped.totals.discountPaise], [100, 10000], 'never more than the most points per order');
  await set('loyalty.max_redeem_points', '');
  // A customer with no points: asking to use them refuses the sale instead of charging something else.
  const none = (await owner.insertInto('customers').values({email: 'bill.none@test.local', full_name: 'No Points', email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  await assert.rejects(sell(sales, sS, {customerId: none, usePoints: true}), e => e instanceof ConflictError && /Loyalty points were not used/.test(e.message));
  // Two tills, the same customer, all 400 points each, at the same moment: one sale gets them, the other is refused; never both.
  const total = capped.totals.totalPaise + 10000 - 40000;                      // the bill with all 400 points used
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), customerId: arun, discount: null, usePoints: true})).totals.totalPaise, total);
  const go = (actor, s) => completePosSale(admin, actor, {sessionId: s.id, idempotencyKey: key(), lines: one(), customerId: arun, contact: null, discount: null, usePoints: true,
    payment: {method: 'cash', tenderedPaise: total}, expectedTotalPaise: total}, ctx);
  const r = await Promise.allSettled([go(sales, sS), go(sales2, sS2)]);
  assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected'], 'exactly one sale used the points');
  assert.match(r.find(x => x.status === 'rejected').reason.message, /Loyalty points were not used|total changed/);
  assert.equal(await loyaltyBalance(admin, arun), 0);
  const [led] = await q(`select coalesce(sum(points), 0)::int total, count(*) filter (where kind = 'redeem')::int redeems from loyalty_transactions where customer_id = $1`, [arun]);
  assert.deepEqual(led, {total: 0, redeems: 1}, 'the ledger agrees with the balance: 400 added, 400 used once');
  assert.equal((await q(`select count(*)::int n from loyalty_accounts where balance < 0`))[0].n, 0);
});

test('void: a voided counter sale gives the points back and frees the coupon use', async () => {
  await coupon('VOIDME', {uses: 1});
  await adjustLoyaltyPoints(admin, root, {customerId: arun, points: 50, reason: 'billing test'}, ctx);
  const {sale} = await sell(manager, sM, {customerId: arun, couponCode: 'VOIDME', usePoints: true});
  assert.equal(await loyaltyBalance(admin, arun), 0);
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: 'VOIDME'})).coupon.applied, false, 'used up');
  await voidPosSale(admin, manager, {orderId: sale.orderId, reason: 'Rung up by mistake'}, ctx);
  assert.equal(await loyaltyBalance(admin, arun), 50, 'the points used on the voided bill are back');
  assert.deepEqual((await q(`select kind, points from loyalty_transactions where order_id = $1 order by created_at, kind`, [sale.orderId])).map(r => `${r.kind}:${r.points}`), ['redeem:-50', 'restore:50']);
  assert.equal((await quotePosSale(admin, sales, {locationId: store, lines: one(), discount: null, couponCode: 'VOIDME'})).coupon.applied, true, 'a cancelled sale does not use up a coupon');
});

// ---------------------------------------------------------------- the invoice by email
test('invoice email: built from the invoice with the same bill; sent by hand with finance.manage; logged as sent or failed, never "delivered"', async () => {
  assert.equal(EMAIL_EVENTS['invoice.issued'], 'notifications.invoice_issued');
  const sent = [];
  const mailer = {kind: 'memory', async send(m) { sent.push(m); }};
  const failing = {kind: 'memory', async send() { throw new Error('provider said no'); }};
  const {sale, quote} = await sell(sales, sS, {customerId: meera, couponCode: 'FLAT200'});
  const inv = await createInvoiceForOrder(admin, accountant, {orderId: sale.orderId}, ctx);
  const m = await invoiceEmail(admin, inv.id, {storeUrl: 'http://store.local'});
  assert.deepEqual([m.to, m.subject, m.orderId], ['bill.meera@test.local', `Your KITSYUU tax invoice ${inv.number}`, sale.orderId]);
  for (const l of quote.bill.lines) assert.ok(m.text.includes(`${l.label}: ${l.effect < 0 ? '−' : ''}₹`), `the email has the bill line "${l.label}"`);
  assert.match(m.text, /Coupon FLAT200: −₹200/); assert.match(m.text, /Payment method: Cash in store/); assert.match(m.text, /Payment status: paid/);
  assert.match(m.text, new RegExp(`Invoice number: ${inv.number.replace(/\//g, '\\/')}`));
  assert.match(m.text, /http:\/\/store\.local\/account\/orders\/[^/]+\/invoice/);
  // The automatic email is off until the business switches it on: issuing sends nothing and logs nothing.
  assert.deepEqual(await notifyInvoiceIssued(admin, mailer, inv.id), {sent: false, reason: 'off'});
  assert.deepEqual([sent.length, (await listInvoiceEmails(admin, accountant, inv.id)).length], [0, 0]);
  // By hand: finance.manage only.
  for (const a of [sales, support, manager]) await assert.rejects(sendInvoiceEmail(admin, a, mailer, {invoiceId: inv.id}, ctx), ForbiddenError);
  const r1 = await sendInvoiceEmail(admin, accountant, mailer, {invoiceId: inv.id}, ctx);
  assert.deepEqual([r1.number, r1.result, sent.length, sent[0].to], [inv.number, {sent: true}, 1, 'bill.meera@test.local']);
  const r2 = await sendInvoiceEmail(admin, accountant, mailer, {invoiceId: inv.id}, ctx);          // again, on purpose
  assert.deepEqual([r2.result, sent.length], [{sent: true}, 2]);
  const r3 = await sendInvoiceEmail(admin, accountant, failing, {invoiceId: inv.id}, ctx);
  assert.deepEqual(r3.result, {sent: false, reason: 'failed'});
  const log = await listInvoiceEmails(admin, accountant, inv.id);
  assert.deepEqual(log.map(l => l.status), ['failed', 'sent', 'sent'], 'every attempt is logged, newest first, as sent or failed');
  assert.ok(log.every(l => l.recipient === 'bill.meera@test.local' && !('error' in l) && !('subject' in l)));
  assert.deepEqual((await q(`select metadata->>'result' r from audit_logs where action = 'invoice.email' and entity_id = $1 order by id`, [inv.id])).map(x => x.r), ['sent', 'sent', 'failed']);
  assert.doesNotMatch(JSON.stringify(await q(`select metadata, after_data from audit_logs where action = 'invoice.email'`)), /bill\.meera/, 'the address is not copied into the audit log');
  await assert.rejects(listInvoiceEmails(admin, sales, inv.id), ForbiddenError);
  // Switched on: issuing sends it once; a second call for the same invoice is a duplicate.
  await set('notifications.invoice_issued', 'on');
  const second = await sell(sales, sS, {customerId: arun});
  const inv2 = await createInvoiceForOrder(admin, accountant, {orderId: second.sale.orderId}, ctx);
  assert.deepEqual(await notifyInvoiceIssued(admin, mailer, inv2.id), {sent: true});
  assert.deepEqual(await notifyInvoiceIssued(admin, mailer, inv2.id), {sent: false, reason: 'duplicate'});
  assert.equal(sent.at(-1).to, 'bill.arun@test.local');
  await set('notifications.invoice_issued', 'off');
  // Nobody to send to (a walk-in sale), a voided invoice, and an id that is not an invoice.
  const anon = await sell(sales, sS);
  const inv3 = await createInvoiceForOrder(admin, accountant, {orderId: anon.sale.orderId}, ctx);
  assert.equal(await invoiceEmail(admin, inv3.id), null);
  await assert.rejects(sendInvoiceEmail(admin, accountant, mailer, {invoiceId: inv3.id}, ctx), e => e instanceof DomainError && /no email address/.test(e.message));
  await voidInvoice(admin, accountant, {invoiceId: inv2.id, reason: 'test void'}, ctx);
  await assert.rejects(sendInvoiceEmail(admin, accountant, mailer, {invoiceId: inv2.id}, ctx), ConflictError);
  for (const bad of ['00000000-0000-4000-8000-000000000000', 'nope']) await assert.rejects(sendInvoiceEmail(admin, accountant, mailer, {invoiceId: bad}, ctx), NotFoundError);
  assert.equal(sent.length, 3, 'nothing else was sent');
});

test('integrity: every order made here adds up, and no balance or stock went wrong', async () => {
  const rows = await q(`select * from orders`);
  assert.ok(rows.length >= 10);
  for (const o of rows) assert.equal(billFromOrder(o).consistent, true, `${o.order_number} adds up`);
  assert.equal((await q(`select count(*)::int n from orders where (loyalty_points_used > 0) <> (loyalty_discount_paise > 0)`))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from loyalty_accounts a where a.balance <> (select coalesce(sum(t.points), 0) from loyalty_transactions t where t.customer_id = a.customer_id)`))[0].n, 0, 'every balance equals its ledger');
  assert.equal((await q(`select count(*)::int n from location_stock where qty < 0`))[0].n, 0);
});
