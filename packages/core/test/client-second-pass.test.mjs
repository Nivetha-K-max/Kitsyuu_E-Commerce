/* Client change request, SECOND PASS, against the LOCAL test database: cash on delivery, loyalty points, order editing
   before shipment. Customer flows run as kitsyuu_website, staff flows as kitsyuu_admin; setup and checks use the owner
   connection. Run by apps/admin/tests/run-e2e.mjs, or:
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/client-second-pass.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError, codCancelInput, codCollectInput, loyaltyAdjustInput, orderEditInput, placeOrderInput, settingUpdateInput, shippingRateInput, shippingZoneInput} from '@kitsyuu/contracts';
import {
  addCartLine, adjustLoyaltyPoints, cancelCodOrder, cancelOrderByCustomer, createInvoiceForOrder, databaseDiscounts, defaultCommerceConfig, editOrder, expireLoyaltyPoints,
  getCustomerCart, getCustomerOrder, getMyLoyalty, importLoyaltyPoints, listLoyaltyAccounts, listOrderEdits, orderConfirmationEmail, orderEditBlocker, parseLoyaltyImport,
  placeOrder, preparePayment, recordCodCollected, refundOrderEdit, removeCartLine, saveCustomerAddress, saveShippingRate, saveShippingZone, settingsShipping,
  submitPaymentResult, testPaymentProvider, updateOrderStatus, updateSetting, voidInvoice,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'second-pass.test', requestId: 'test'};
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const adminShipping = settingsShipping(() => admin);
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const SHIP_TO = {state: 'Tamil Nadu', pin: '600001', country: 'IN'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'second pass passphrase', fullName: role}, ctx)).token);
}
const set = (actor, key, value) => updateSetting(admin, actor, settingUpdateInput.parse({key, value}), ctx);
const emptyCart = async p => { for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l); };
const sizes = productId => owner.selectFrom('product_variants').select(['id', 'size', 'stock_qty', 'price_paise']).where('product_id', '=', productId).where('is_active', '=', true).orderBy('sort_order').execute();
const stockOf = async variantId => (await q(`select stock_qty from product_variants where id = $1`, [variantId]))[0].stock_qty;
const orderByNumber = n => owner.selectFrom('orders').selectAll().where('order_number', '=', n).executeTakeFirstOrThrow();
const balance = async p => (await q(`select coalesce((select balance from loyalty_accounts where customer_id = $1), 0) as b`, [p.customerId]))[0].b;

/** Fills the cart and places an order the way the checkout does (the page's total, the customer's choices). */
async function order(p, addressId, lines, choice = {}) {
  await emptyCart(p);
  for (const l of lines) await addCartLine(web, p, l);
  const payment = {method: choice.paymentMethod ?? 'online', usePoints: !!choice.usePoints};
  const cart = await getCustomerCart(web, p, config(), SHIP_TO, payment);
  const placed = await placeOrder(web, p, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId, expectedTotalPaise: String(cart.totals.totalPaise),
    ...(choice.paymentMethod ? {paymentMethod: choice.paymentMethod} : {}), ...(choice.usePoints ? {usePoints: 'on'} : {})}), ctx, config());
  return {placed, cart, o: await orderByNumber(placed.orderNumber)};
}
async function payOrder(p, orderNumber) {
  const start = await preparePayment(web, pay, p, orderNumber);
  const o = await orderByNumber(orderNumber);
  return submitPaymentResult(web, pay, p, {orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, o.currency, 'success')}, ctx);
}
async function advance(actor, orderNumber, to) {
  let o = await orderByNumber(orderNumber);
  for (const s of to) { await updateOrderStatus(admin, actor, {orderId: o.id, toStatus: s, expectedStatus: o.status, note: null, carrierCode: 'manual', trackingNumber: null}, ctx); o = await orderByNumber(orderNumber); }
  return o;
}

let root, manager, asha, ravi, meera, ashaAddr, raviAddr, meeraAddr, prod, prod2, codRate;
before(async () => {
  root = await staff('sp.root@test.local', 'super_admin');
  manager = await staff('sp.manager@test.local', 'manager');
  const mk = async (email, name) => (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  asha = P(await mk('asha.sp@test.local', 'Asha'), 'asha.sp@test.local');
  ravi = P(await mk('ravi.sp@test.local', 'Ravi'), 'ravi.sp@test.local');
  meera = P(await mk('meera.sp@test.local', 'Meera'), 'meera.sp@test.local');
  const addr = {fullName: 'Asha', phone: '9876543210', line1: '1 Test Road', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true};
  ashaAddr = await saveCustomerAddress(web, asha, addr, ctx);
  raviAddr = await saveCustomerAddress(web, ravi, {...addr, fullName: 'Ravi'}, ctx);
  meeraAddr = await saveCustomerAddress(web, meera, {...addr, fullName: 'Meera'}, ctx);
  // Two products whose sizes all sell at the product price (no size has its own price in the seed).
  [prod, prod2] = await owner.selectFrom('products').select(['id', 'price_paise']).where('status', '=', 'active').orderBy('id').limit(2).execute();
  // Delivery by zone: one rate that allows cash on delivery with a ₹40 COD fee.
  const z = await saveShippingZone(admin, root, shippingZoneInput.parse({name: 'SP South', states: ['Tamil Nadu'], pinPrefixes: '', active: 'on'}), ctx);
  codRate = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Standard', amount: '50', estMin: '3', estMax: '5', active: 'on'}), ctx);
  await set(root, 'shipping.method', 'zones');
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

// ---------------------------------------------------------------- cash on delivery
test('COD: off by default; follows the delivery rate; fee, discount and order value range from settings; the server decides', async () => {
  const [s] = await sizes(prod.id);
  await emptyCart(asha);
  await addCartLine(web, asha, {productId: prod.id, size: s.size, qty: 1});
  const off = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'cod', usePoints: false});
  assert.equal(off.totals.payment.cod.offered, false, 'COD is off until the business switches it on');
  assert.equal(off.totals.payment.method, 'online');
  const input = placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr, expectedTotalPaise: String(off.totals.totalPaise), paymentMethod: 'cod'});
  await assert.rejects(placeOrder(web, asha, input, ctx, config()), /not available/, 'a COD order is refused while COD is off');

  await set(root, 'payments.cod_enabled', 'on');
  const noRate = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'cod', usePoints: false});
  assert.equal(noRate.totals.payment.cod.available, false);
  assert.match(noRate.totals.payment.cod.reason, /not available for this address/, 'only where the delivery rate allows COD');

  await saveShippingRate(admin, root, shippingRateInput.parse({rateId: codRate.id, zoneId: (await q(`select zone_id from shipping_rates where id = $1`, [codRate.id]))[0].zone_id,
    name: 'Standard', amount: '50', estMin: '3', estMax: '5', active: 'on', codAllowed: 'on', codFee: '40'}), ctx);
  await set(root, 'payments.cod_discount', '25');
  const withCod = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'cod', usePoints: false});
  const t = withCod.totals;
  assert.equal(t.payment.method, 'cod');
  assert.equal(t.codFeePaise, 4000, 'the delivery rate’s COD fee');
  assert.ok(t.discounts.some(d => d.code === 'COD' && d.amountPaise === 2500), 'the COD discount from settings');
  assert.equal(t.totalPaise, t.subtotalPaise - 2500 + 5000 + 4000, 'items − COD discount + delivery + COD fee (prices include tax)');
  const online = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'online', usePoints: false});
  assert.equal(online.totals.codFeePaise, 0); assert.ok(!online.totals.discounts.some(d => d.code === 'COD'), 'no COD fee or discount when paying online');

  await set(root, 'payments.cod_min_order', String((t.subtotalPaise + 100) / 100));
  const tooSmall = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'cod', usePoints: false});
  assert.match(tooSmall.totals.payment.cod.reason, /orders of ₹/);
  await set(root, 'payments.cod_min_order', '');
  await set(root, 'payments.cod_max_order', '1');
  assert.match((await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'cod', usePoints: false})).totals.payment.cod.reason, /up to ₹1\.00/);
  await set(root, 'payments.cod_max_order', '');
  await set(root, 'payments.cod_discount', '');
  await emptyCart(asha);
});

test('COD order: straight to packing, stock taken, cash to collect; collected → paid; cancel before dispatch; refused parcel', async () => {
  const [s] = await sizes(prod.id);
  const before = await stockOf(s.id);
  const {o, placed} = await order(asha, ashaAddr, [{productId: prod.id, size: s.size, qty: 2}], {paymentMethod: 'cod'});
  assert.equal(placed.cod, true);
  assert.equal(o.status, 'processing'); assert.equal(o.payment_method, 'cod'); assert.equal(o.cod_status, 'to_collect');
  assert.equal(o.payment_status, 'unpaid'); assert.equal(o.payment_expires_at, null, 'a COD order never expires for want of an online payment');
  assert.equal(o.cod_fee_paise, 4000);
  assert.equal(await stockOf(s.id), before - 2, 'stock taken like any order');
  assert.equal((await q(`select status from carts where id = $1`, [o.cart_id]))[0].status, 'converted');
  const mail = await orderConfirmationEmail(web, o.order_number, {orderUrl: 'https://store.test/o'});
  assert.match(mail.text, /in cash when it is delivered/); assert.match(mail.text, /Cash on delivery fee: ₹40/);
  const detail = await getCustomerOrder(web, asha, o.order_number);
  assert.equal(detail.paymentMethod, 'cod'); assert.equal(detail.canPay, false, 'nothing to pay online');

  // Staff: the generic status menu cannot cancel it; the COD action can only after the right step.
  await assert.rejects(updateOrderStatus(admin, root, {orderId: o.id, toStatus: 'cancelled', expectedStatus: 'processing', note: 'x', carrierCode: 'manual', trackingNumber: null}, ctx), /cannot go/);
  await assert.rejects(recordCodCollected(admin, manager, {orderId: o.id, amountPaise: o.total_paise, reference: null, note: null}, ctx), ForbiddenError, 'needs orders.cod');
  assert.equal(codCollectInput.parse({orderId: o.id, amount: '1,299.50'}).amount, 129950);
  await assert.rejects(recordCodCollected(admin, root, {orderId: o.id, amountPaise: o.total_paise, reference: null, note: null}, ctx), /shipped or delivered/);
  await advance(root, o.order_number, ['shipped', 'delivered']);
  const collect = amount => recordCodCollected(admin, root, {orderId: o.id, amountPaise: amount, reference: 'RCPT-1', note: null}, ctx);
  await assert.rejects(collect(o.total_paise - 100), /must be the order total/);
  await collect(o.total_paise);
  const paid = await orderByNumber(o.order_number);
  assert.equal(paid.cod_status, 'collected'); assert.equal(paid.payment_status, 'paid'); assert.ok(paid.paid_at);
  const [p] = await q(`select provider, status, amount_paise, method from payments where order_id = $1`, [o.id]);
  assert.deepEqual(p, {provider: 'cod', status: 'captured', amount_paise: o.total_paise, method: 'cash'});
  await assert.rejects(collect(o.total_paise), /already recorded/);
  assert.ok((await q(`select 1 from audit_logs where action = 'order.cod_collected' and entity_id = $1`, [o.id])).length);

  // Cancel before dispatch: stock comes back.
  const b2 = await stockOf(s.id);
  const {o: o2} = await order(ravi, raviAddr, [{productId: prod.id, size: s.size, qty: 1}], {paymentMethod: 'cod'});
  await assert.rejects(cancelCodOrder(admin, root, {orderId: o2.id, kind: 'refused', note: 'x', restock: true}, ctx), /once the order has been shipped/);
  await cancelCodOrder(admin, root, {...codCancelInput.parse({orderId: o2.id, kind: 'cancel', note: 'Customer called to cancel'}), restock: false}, ctx);
  assert.equal((await orderByNumber(o2.order_number)).status, 'cancelled');
  assert.equal(await stockOf(s.id), b2, 'a cancelled COD order returns its stock');

  // Refused parcel: cancelled; stock only comes back when staff say so; the shipment is marked failed.
  const b3 = await stockOf(s.id);
  const {o: o3} = await order(meera, meeraAddr, [{productId: prod.id, size: s.size, qty: 1}], {paymentMethod: 'cod'});
  await advance(root, o3.order_number, ['shipped']);
  await cancelCodOrder(admin, root, {orderId: o3.id, kind: 'refused', note: 'Not at home, refused', restock: false}, ctx);
  const r3 = await orderByNumber(o3.order_number);
  assert.equal(r3.status, 'cancelled'); assert.equal(r3.cod_status, 'refused');
  assert.equal(await stockOf(s.id), b3 - 1, 'not put back unless staff say the pieces are fit to sell');
  assert.equal((await q(`select status from shipments where order_id = $1`, [o3.id]))[0].status, 'failed_delivery');
});

// ---------------------------------------------------------------- loyalty
test('loyalty: nothing without the settings; earned when paid; staff adjust with a reason; redeem at checkout (server-priced); cancel gives points back', async () => {
  const [s] = await sizes(prod2.id);
  // Off: an order earns nothing and points cannot be used.
  const {o: o0} = await order(asha, ashaAddr, [{productId: prod2.id, size: s.size, qty: 1}]);
  await payOrder(asha, o0.order_number);
  assert.equal(await balance(asha), 0, 'no earning while loyalty is off');

  await assert.rejects(adjustLoyaltyPoints(admin, manager, {customerId: asha.customerId, points: 10, reason: 'x'}, ctx), ForbiddenError, 'needs loyalty.adjust');
  await assert.rejects(adjustLoyaltyPoints(admin, root, {customerId: asha.customerId, points: -5, reason: 'x'}, ctx), /Only 0 points/);
  assert.throws(() => loyaltyAdjustInput.parse({customerId: asha.customerId, points: '0', reason: 'x'}), /other than 0/);
  await adjustLoyaltyPoints(admin, root, {customerId: asha.customerId, points: 120, reason: 'Welcome gift'}, ctx);
  assert.equal(await balance(asha), 120);
  assert.ok((await q(`select 1 from audit_logs where action = 'loyalty.adjust' and entity_id = $1`, [asha.customerId])).length);

  // Switch on and set the rules (all values are the business's; these are test values).
  await set(root, 'loyalty.enabled', 'on');
  await set(root, 'loyalty.earn_points_per_100', '5');
  await set(root, 'loyalty.earn_when', 'paid');
  const {o: o1} = await order(asha, ashaAddr, [{productId: prod2.id, size: s.size, qty: 1}]);
  await payOrder(asha, o1.order_number);
  const earned = Math.floor((o1.subtotal_paise - o1.discount_paise) * 5 / 10000);
  assert.ok(earned > 0);
  assert.equal(await balance(asha), 120 + earned, 'points earned when the order is paid');
  await payOrder(asha, o1.order_number).catch(() => null);
  assert.equal(await balance(asha), 120 + earned, 'once per order');

  // Redemption: no point value → points cannot be used.
  await emptyCart(asha);
  await addCartLine(web, asha, {productId: prod2.id, size: s.size, qty: 1});
  const noValue = await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'online', usePoints: true});
  assert.equal(noValue.totals.payment.loyalty.redeemable, false);
  await set(root, 'loyalty.point_value_paise', '1');       // ₹1 per point (test value)
  await set(root, 'loyalty.max_redeem_points', '100');
  await set(root, 'loyalty.min_redeem_points', '10');
  const quote = (await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'online', usePoints: true})).totals;
  assert.equal(quote.payment.loyalty.usedPoints, 100, 'capped at the most points per order');
  assert.ok(quote.discounts.some(d => d.code === 'LOYALTY' && d.amountPaise === 10000));
  // The browser cannot choose the amount: placing with the total of "no points" while asking for points is refused.
  const plain = (await getCustomerCart(web, asha, config(), SHIP_TO, {method: 'online', usePoints: false})).totals;
  await assert.rejects(placeOrder(web, asha, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr,
    expectedTotalPaise: String(plain.totalPaise), usePoints: 'on'}), ctx, config()), /changed/);
  const before = await balance(asha);
  const {o: o2} = await order(asha, ashaAddr, [{productId: prod2.id, size: s.size, qty: 1}], {usePoints: true});
  assert.equal(o2.loyalty_points_used, 100); assert.equal(o2.loyalty_discount_paise, 10000);
  assert.equal(o2.total_paise, plain.totalPaise - 10000);
  assert.equal(await balance(asha), before - 100);
  // The customer cancels the unpaid order: the points come back.
  await cancelOrderByCustomer(web, asha, o2.order_number, ctx);
  assert.equal(await balance(asha), before, 'a cancelled order gives its points back');
  const mine = await getMyLoyalty(web, asha);
  assert.deepEqual(mine.rows.slice(0, 2).map(r => r.kind), ['restore', 'redeem']);
  assert.ok(mine.rows.every(r => !('staff_id' in r) && !('staff_email' in r)), 'staff are not shown to customers');

  // Minimum: a customer below it cannot use points.
  await adjustLoyaltyPoints(admin, root, {customerId: ravi.customerId, points: 5, reason: 'Test'}, ctx);
  await emptyCart(ravi);
  await addCartLine(web, ravi, {productId: prod2.id, size: s.size, qty: 1});
  const ravQuote = (await getCustomerCart(web, ravi, config(), SHIP_TO, {method: 'online', usePoints: true})).totals.payment.loyalty;
  assert.equal(ravQuote.usedPoints, 0); assert.match(ravQuote.message, /At least 10 points/);
  await emptyCart(ravi); await emptyCart(asha);
  assert.ok((await listLoyaltyAccounts(admin, root, {page: 1})).rows.some(r => r.id === asha.customerId));
  await assert.rejects(listLoyaltyAccounts(admin, manager, {page: 1}), ForbiddenError);
});

test('loyalty: import opening balances (all or nothing); unused points expire', async () => {
  assert.equal(parseLoyaltyImport('email,points\nbad,5\nx@y.in,0').errors.length, 2);
  await assert.rejects(importLoyaltyPoints(admin, root, {text: 'meera.sp@test.local,50\nnobody@test.local,10', reason: 'Opening balance'}, ctx), /No customer account for: nobody@test.local/);
  assert.equal(await balance(meera), 0, 'nothing imported when one line is wrong');
  const r = await importLoyaltyPoints(admin, root, {text: 'email,points,reason\nMEERA.sp@test.local,50,From the old shop\n', reason: 'Opening balance'}, ctx);
  assert.deepEqual(r, {customers: 1, points: 50});
  assert.equal(await balance(meera), 50);
  await set(root, 'loyalty.expiry_months', '12');
  await adjustLoyaltyPoints(admin, root, {customerId: meera.customerId, points: 30, reason: 'Expiring'}, ctx);
  const [row] = await q(`select id, expires_at from loyalty_transactions where customer_id = $1 and reason = 'Expiring'`, [meera.customerId]);
  assert.ok(row.expires_at, 'points added while an expiry is set get an expiry date');
  await q(`update loyalty_transactions set expires_at = now() - interval '1 minute' where id = $1`, [row.id]);
  const run = await expireLoyaltyPoints(admin);
  assert.deepEqual(run, {customers: 1, points: 30});
  assert.equal(await balance(meera), 50, 'only the unused, expired points go');
  await set(root, 'loyalty.expiry_months', '');
  await set(root, 'loyalty.enabled', 'off');
});

// ---------------------------------------------------------------- order editing
test('order edit: before shipment only; quantities and sizes at the paid price; stock through the ledger; refund due for a lower total', async () => {
  const [a1, a2] = await sizes(prod.id);
  const [b1] = await sizes(prod2.id);
  const {o} = await order(ravi, raviAddr, [{productId: prod.id, size: a1.size, qty: 2}, {productId: prod2.id, size: b1.size, qty: 1}]);
  assert.match(await orderEditBlocker(admin, o.id), /waiting for payment/);
  await payOrder(ravi, o.order_number);
  const paid = await orderByNumber(o.order_number);
  assert.equal(await orderEditBlocker(admin, o.id), null);
  const items = await q(`select id, variant_id, qty, unit_price_paise from order_items where order_id = $1 order by sku`, [o.id]);
  const itemA = items.find(i => i.variant_id === a1.id), itemB = items.find(i => i.variant_id === b1.id);
  const form = (lines, extra = {}) => orderEditInput.parse({orderId: o.id, expectedTotalPaise: String(extra.expected ?? paid.total_paise), note: extra.note ?? 'Customer asked by phone',
    itemIds: lines.map(l => l.item.id), variantIds: lines.map(l => l.variant), qtys: lines.map(l => String(l.qty)), ...(extra.address ?? {})});

  await assert.rejects(editOrder(admin, manager, form([{item: itemA, variant: a1.id, qty: 1}, {item: itemB, variant: b1.id, qty: 1}]), ctx, {shipping: adminShipping}), ForbiddenError, 'needs orders.edit');
  await assert.rejects(editOrder(admin, root, form([{item: itemA, variant: a1.id, qty: 3}, {item: itemB, variant: b1.id, qty: 1}]), ctx, {shipping: adminShipping}), /more than the customer paid/);
  await assert.rejects(editOrder(admin, root, form([{item: itemA, variant: a1.id, qty: 1}, {item: itemB, variant: b1.id, qty: 1}], {expected: paid.total_paise + 1}), ctx, {shipping: adminShipping}), /changed since you opened it/);
  await assert.rejects(editOrder(admin, root, form([{item: itemA, variant: a1.id, qty: 0}, {item: itemB, variant: b1.id, qty: 0}]), ctx, {shipping: adminShipping}), /at least one item/);
  await assert.rejects(editOrder(admin, root, form([{item: itemA, variant: b1.id, qty: 1}, {item: itemB, variant: b1.id, qty: 1}]), ctx, {shipping: adminShipping}), /another size/);
  // A size with its own (different) price cannot be swapped in.
  await owner.updateTable('product_variants').set({price_paise: (paid.subtotal_paise + 12345)}).where('id', '=', a2.id).execute();
  await assert.rejects(editOrder(admin, root, form([{item: itemA, variant: a2.id, qty: 2}, {item: itemB, variant: b1.id, qty: 1}]), ctx, {shipping: adminShipping}), /different price/);
  await owner.updateTable('product_variants').set({price_paise: null}).where('id', '=', a2.id).execute();

  // One fewer of A, and A's size swapped: fewer units back, the new size taken; the total falls → refund due.
  const [sA1, sA2] = [await stockOf(a1.id), await stockOf(a2.id)];
  const r = await editOrder(admin, root, form([{item: itemA, variant: a2.id, qty: 1}, {item: itemB, variant: b1.id, qty: 1}]), ctx, {shipping: adminShipping});
  assert.equal(r.totalAfter, paid.total_paise - itemA.unit_price_paise);
  assert.equal(r.refundDuePaise, itemA.unit_price_paise);
  assert.equal(await stockOf(a1.id), sA1 + 2, 'both units of the old size come back');
  assert.equal(await stockOf(a2.id), sA2 - 1, 'the new size is taken');
  const after = await orderByNumber(o.order_number);
  assert.equal(after.total_paise, r.totalAfter); assert.equal(after.subtotal_paise, paid.subtotal_paise - itemA.unit_price_paise);
  const [line] = await q(`select variant_id, qty, line_total_paise, unit_price_paise from order_items where id = $1`, [itemA.id]);
  assert.deepEqual(line, {variant_id: a2.id, qty: 1, line_total_paise: itemA.unit_price_paise, unit_price_paise: itemA.unit_price_paise}, 'the price paid is kept');
  const [edit] = await listOrderEdits(admin, o.id);
  assert.equal(edit.note, 'Customer asked by phone'); assert.equal(edit.total_before, paid.total_paise); assert.equal(edit.refund_due_paise, itemA.unit_price_paise);
  assert.ok((await q(`select 1 from audit_logs where action = 'order.edit' and entity_id = $1`, [o.id])).length);
  assert.match(await orderEditBlocker(admin, o.id), /refund due/, 'the refund comes first');

  // The refund: recorded as paid outside the platform needs its reference; through the test provider it is processed.
  await assert.rejects(refundOrderEdit(admin, manager, pay, {editId: edit.id, mode: 'manual', reference: 'UTR1'}, ctx), ForbiddenError);
  await refundOrderEdit(admin, root, pay, {editId: edit.id, mode: 'provider', reference: null}, ctx);
  const [ref] = await q(`select amount_paise, status, method from refunds where order_id = $1`, [o.id]);
  assert.deepEqual(ref, {amount_paise: itemA.unit_price_paise, status: 'processed', method: 'provider'});
  assert.equal((await orderByNumber(o.order_number)).payment_status, 'partially_refunded');
  await assert.rejects(refundOrderEdit(admin, root, pay, {editId: edit.id, mode: 'manual', reference: 'UTR1'}, ctx), /already been made/);
  assert.equal(await orderEditBlocker(admin, o.id), null, 'a refund made for an edit does not block the next edit');

  // New delivery address: re-quoted; refused where there is no delivery.
  const cur = await orderByNumber(o.order_number);
  const lines2 = [{item: itemA, variant: a2.id, qty: 1}, {item: itemB, variant: b1.id, qty: 1}];
  const addr = st => ({changeAddress: 'on', fullName: 'Ravi', phone: '9876543210', line1: '2 New Street', line2: '', city: 'Chennai', state: st, pin: st === 'Kerala' ? '682001' : '600002'});
  await assert.rejects(editOrder(admin, root, form(lines2, {expected: cur.total_paise, address: addr('Kerala')}), ctx, {shipping: adminShipping}), /New address: We do not deliver/);
  await editOrder(admin, root, form(lines2, {expected: cur.total_paise, address: addr('Tamil Nadu'), note: 'New address'}), ctx, {shipping: adminShipping});
  assert.equal((await orderByNumber(o.order_number)).shipping_address.line1, '2 New Street');
  assert.throws(() => form(lines2, {address: addr('Nowhere')}), /state/);

  // An issued invoice blocks editing until it is voided; a shipped order cannot be edited.
  const inv = await createInvoiceForOrder(admin, root, {orderId: o.id}, ctx);
  assert.match(await orderEditBlocker(admin, o.id), /issued invoice/);
  await voidInvoice(admin, root, {invoiceId: inv.id, reason: 'Order edited'}, ctx);
  await advance(root, o.order_number, ['processing', 'shipped']);
  assert.match(await orderEditBlocker(admin, o.id), /not shipped/);
});

test('order edit: a COD order can grow (collected on delivery), with no refund', async () => {
  const [s] = await sizes(prod.id);
  const {o} = await order(meera, meeraAddr, [{productId: prod.id, size: s.size, qty: 1}], {paymentMethod: 'cod'});
  const [item] = await q(`select id, unit_price_paise from order_items where order_id = $1`, [o.id]);
  const r = await editOrder(admin, root, orderEditInput.parse({orderId: o.id, expectedTotalPaise: String(o.total_paise), note: 'One more',
    itemIds: [item.id], variantIds: [s.id], qtys: ['2']}), ctx, {shipping: adminShipping});
  assert.equal(r.totalAfter, o.total_paise + item.unit_price_paise); assert.equal(r.refundDuePaise, 0);
  const after = await orderByNumber(o.order_number);
  assert.equal(after.cod_fee_paise, o.cod_fee_paise, 'the COD fee stays');
  // Not enough stock: refused, nothing changed.
  const left = await stockOf(s.id);
  if (left > 0) await q(`select public.adjust_stock($1::uuid, $2::int, 'correction', null, 'test', null)`, [s.id, -left]);
  await assert.rejects(editOrder(admin, root, orderEditInput.parse({orderId: o.id, expectedTotalPaise: String(after.total_paise), note: 'Two more',
    itemIds: [item.id], variantIds: [s.id], qtys: ['4']}), ctx, {shipping: adminShipping}), /currently unavailable/);
  assert.equal((await orderByNumber(o.order_number)).total_paise, after.total_paise);
  await cancelCodOrder(admin, root, {orderId: o.id, kind: 'cancel', note: 'Test end', restock: false}, ctx);
});
