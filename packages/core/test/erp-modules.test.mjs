/* ERP modules 1–8 against the LOCAL test database: pricing & discounts, shipping, returns & refunds, marketing, support,
   finance, carts & wishlists, notifications. Customer flows run as the real kitsyuu_website role, staff flows as
   kitsyuu_admin, setup and checks as the owner. Payments and refunds use the test provider and a local fake Razorpay.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/erp-modules.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, DomainError, ForbiddenError, bannerInput, campaignInput, couponInput, discountInput, placeOrderInput, refundInput, returnRequestInput,
  segmentInput, settingUpdateInput, shippingRateInput, shippingZoneInput, taxRateInput,
} from '@kitsyuu/contracts';
import {
  addCartLine, applyDuePriceChanges, bulkUpdatePrices, createFinanceNote, createInvoiceForOrder, customerReturnOptions, databaseDiscounts, defaultCommerceConfig,
  getCart, getCustomerCart, getCustomerTicket, getInvoice, getReturn, listCarts, listDiscounts, listStaffNotifications, markNotificationsRead, openCustomerTicket,
  placeOrder, preparePayment, priceHistory, reconciliation, refundReturn, removeCartLine, replyAsCustomer, replyToTicket, requestReturn, returnAction,
  saveBanner, saveCampaign, saveCourier, saveCustomerAddress, saveDiscount, saveExpense, saveSegment, saveShippingRate, saveShippingZone, saveTaxRate,
  schedulePriceChange, sendCartReminder, setCartCoupon, setCartRecovery, setFinanceNoteStatus, setProductPricing, settingsShipping, getSegment, financeSummary,
  submitPaymentResult, testPaymentProvider, unreadNotifications, updateOrderStatus, updateReturnItem, updateSetting, updateShipmentStatus, getShipmentDetail,
  listTickets, updateTicket, notifyTicketReply, promotionReport,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});      // kitsyuu_admin
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});      // kitsyuu_website
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'erp.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const sent = [];
const mailer = {kind: 'memory', async send(m) { sent.push(m); }};
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'erp test passphrase', fullName: role}, ctx)).token);
}
const set = (actor, key, value) => updateSetting(admin, actor, settingUpdateInput.parse({key, value}), ctx);
async function checkout(p, addressId, lines, cfg = config()) {
  for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l);
  for (const l of lines) await addCartLine(web, p, l);
  const addr = await owner.selectFrom('addresses').select(['state', 'pin', 'country']).where('id', '=', addressId).executeTakeFirstOrThrow();
  const cart = await getCustomerCart(web, p, cfg, addr);
  return placeOrder(web, p, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId, expectedTotalPaise: String(cart.totals.totalPaise)}), ctx, cfg);
}
async function payOrder(p, orderNumber) {
  const start = await preparePayment(web, pay, p, orderNumber);
  const o = await owner.selectFrom('orders').select(['total_paise', 'currency']).where('order_number', '=', orderNumber).executeTakeFirstOrThrow();
  return submitPaymentResult(web, pay, p, {orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, o.currency, 'success')}, ctx);
}
const orderByNumber = n => owner.selectFrom('orders').selectAll().where('order_number', '=', n).executeTakeFirstOrThrow();
async function ship(actor, orderNumber, to = ['processing', 'shipped'], extra = {}) {
  let o = await orderByNumber(orderNumber);
  for (const s of to) { await updateOrderStatus(admin, actor, {orderId: o.id, toStatus: s, expectedStatus: o.status, note: null, carrierCode: 'manual', trackingNumber: null, ...extra}, ctx); o = await orderByNumber(orderNumber); }
  return o;
}

let root, manager, support, accountant, inventory, asha, ravi, ashaAddr, raviAddr, farAddr, prod, prod2;

before(async () => {
  root = await staff('erp.root@test.local', 'super_admin');
  manager = await staff('erp.manager@test.local', 'manager');
  support = await staff('erp.support@test.local', 'support');
  accountant = await staff('erp.accounts@test.local', 'accountant');
  inventory = await staff('erp.inventory@test.local', 'inventory_manager');
  const mk = async (email, name) => (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  asha = P(await mk('asha.erp@test.local', 'Asha Rao'), 'asha.erp@test.local');
  ravi = P(await mk('ravi.erp@test.local', 'Ravi Kumar'), 'ravi.erp@test.local');
  const addr = {fullName: 'Asha Rao', phone: '9876543210', line1: '12 Test Street', line2: null, city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', isDefault: true};
  ashaAddr = await saveCustomerAddress(web, asha, addr, ctx);
  await saveCustomerAddress(web, ravi, {...addr, fullName: 'Ravi Kumar', city: 'Chennai', pin: '600001'}, ctx);
  await saveCustomerAddress(web, ravi, {...addr, fullName: 'Ravi Kumar', city: 'Srinagar', state: 'Jammu and Kashmir', pin: '190001', isDefault: false}, ctx);
  const ra = await owner.selectFrom('addresses').select(['id', 'state']).where('customer_id', '=', ravi.customerId).execute();
  raviAddr = ra.find(a => a.state === 'Tamil Nadu').id; farAddr = ra.find(a => a.state !== 'Tamil Nadu').id;
  [prod, prod2] = await owner.selectFrom('products').select(['id', 'price_paise', 'category_id']).where('status', '=', 'active').orderBy('id').limit(2).execute();
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

const sizeOf = async productId => (await owner.selectFrom('product_variants').select(['id', 'size', 'stock_qty']).where('product_id', '=', productId).where('is_active', '=', true).orderBy('sort_order').executeTakeFirstOrThrow());

// ---------------------------------------------------------------- 8 · notifications
test('notifications: raised after commit, visible per permission, read state per person, switchable', async () => {
  const s = await sizeOf(prod.id);
  const placed = await checkout(asha, ashaAddr, [{productId: prod.id, size: s.size, qty: 1}]);
  const order = await orderByNumber(placed.orderNumber);
  const mine = await listStaffNotifications(admin, manager, {show: 'all', severity: 'all', page: 1});
  assert.ok(mine.rows.some(r => r.kind === 'order.placed' && r.entity_id === order.id), 'the new order is announced to staff with orders.read');
  const inv = await listStaffNotifications(admin, inventory, {show: 'all', severity: 'all', page: 1});
  assert.ok(!inv.rows.some(r => r.kind === 'order.placed'), 'inventory staff do not hold orders.read');
  const before = (await unreadNotifications(admin, manager)).count;
  assert.ok(before >= 1);
  await markNotificationsRead(admin, manager, {ids: [], all: true});
  assert.equal((await unreadNotifications(admin, manager)).count, 0);
  assert.ok((await unreadNotifications(admin, root)).count >= 1, 'read state is per staff member');
  await payOrder(asha, placed.orderNumber);
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'order.paid' and entity_id = $1`, [order.id]))[0].n, 1);
  await set(root, 'alerts.order.placed', 'off');
  const p2 = await checkout(asha, ashaAddr, [{productId: prod.id, size: s.size, qty: 1}]);
  const o2 = await orderByNumber(p2.orderNumber);
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'order.placed' and entity_id = $1`, [o2.id]))[0].n, 0, 'switched off: not raised');
  await set(root, 'alerts.order.placed', 'on');
});

// ---------------------------------------------------------------- 1 · pricing and discounts
test('pricing: compare-at must be above the price; every change is in the history; scheduled and bulk changes', async () => {
  await assert.rejects(setProductPricing(admin, support, {productId: prod2.id, price: 1000, compareAt: null}, ctx), ForbiddenError);
  await assert.rejects(setProductPricing(admin, manager, {productId: prod2.id, price: 100_000, compareAt: 90_000}, ctx), DomainError);
  await setProductPricing(admin, manager, {productId: prod2.id, price: prod2.price_paise, compareAt: prod2.price_paise + 50_000}, ctx);
  const h = await priceHistory(admin, manager, {productId: prod2.id});
  assert.deepEqual(h.map(r => [r.field, r.source, r.staff_email]), [['compare_at', 'manual', 'erp.manager@test.local']]);
  await assert.rejects(schedulePriceChange(admin, manager, {productId: prod2.id, price: 1000, compareAt: null, clearCompareAt: false, effectiveAt: new Date(Date.now() - 1000), note: null}, ctx), DomainError);
  const c = await schedulePriceChange(admin, manager, {productId: prod2.id, price: prod2.price_paise - 10_000, compareAt: null, clearCompareAt: false, effectiveAt: new Date(Date.now() + 3_600_000), note: 'sale'}, ctx);
  assert.deepEqual(await applyDuePriceChanges(admin), {applied: 0, failed: 0}, 'not due yet');
  await q(`update price_changes set effective_at = now() - interval '1 minute' where id = $1`, [c.id]);
  assert.deepEqual(await applyDuePriceChanges(admin), {applied: 1, failed: 0});
  assert.equal((await owner.selectFrom('products').select('price_paise').where('id', '=', prod2.id).executeTakeFirstOrThrow()).price_paise, prod2.price_paise - 10_000);
  assert.equal((await priceHistory(admin, manager, {productId: prod2.id}))[0].source, 'scheduled');
  const bulk = await bulkUpdatePrices(admin, manager, {productIds: [prod2.id], mode: 'increase_amount', amount: 10_000, keepCompareAt: false}, ctx);
  assert.equal(bulk.changed, 1);
  assert.equal((await owner.selectFrom('products').select('price_paise').where('id', '=', prod2.id).executeTakeFirstOrThrow()).price_paise, prod2.price_paise);
  await assert.rejects(bulkUpdatePrices(admin, manager, {productIds: [prod2.id], mode: 'decrease_amount', amount: 100_000_000, keepCompareAt: false}, ctx), ConflictError);
});

test('discounts: off by default; coupon with minimum and usage limit, recorded on the order; best-only stacking; cancelled orders free the use', async () => {
  const s = await sizeOf(prod.id);
  const d = await saveDiscount(admin, manager, discountInput.parse({name: 'Launch 10%', code: 'launch10', kind: 'percent', value: '10', scope: 'order', minOrder: '100', active: 'on', usageLimit: '1'}), ctx);
  await assert.rejects(saveDiscount(admin, manager, discountInput.parse({name: 'Dup', code: 'LAUNCH10', kind: 'fixed', value: '50', scope: 'order'}), ctx), ConflictError);
  await assert.rejects(setCartCoupon(web, ravi, 'LAUNCH10'), /not available/, 'master switch off: coupons refused');
  for (const l of (await getCustomerCart(web, ravi)).lines) await removeCartLine(web, ravi, l);
  await addCartLine(web, ravi, {productId: prod.id, size: s.size, qty: 1});
  assert.equal((await getCustomerCart(web, ravi, config())).totals.discountPaise, 0);
  await set(root, 'discounts.enabled', 'on');
  await assert.rejects(setCartCoupon(web, ravi, 'NOPE123'), /not valid/);
  await setCartCoupon(web, ravi, couponInput.parse({code: 'launch10'}).code);
  const cart = await getCustomerCart(web, ravi, config());
  assert.equal(cart.totals.discountPaise, Math.floor(prod.price_paise * 1000 / 10_000));
  assert.deepEqual([cart.totals.coupon.code, cart.totals.coupon.applied], ['LAUNCH10', true]);
  // an automatic discount that is smaller: only the largest applies (default stacking = best)
  await saveDiscount(admin, manager, discountInput.parse({name: 'Auto ₹1', kind: 'fixed', value: '1', scope: 'products', productIds: [prod.id], active: 'on'}), ctx);
  const c2 = await getCustomerCart(web, ravi, config());
  assert.deepEqual(c2.totals.discounts.map(x => x.label), ['Coupon LAUNCH10']);
  const placed = await placeOrder(web, ravi, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: raviAddr, expectedTotalPaise: String(c2.totals.totalPaise)}), ctx, config());
  const o = await orderByNumber(placed.orderNumber);
  assert.equal(o.discount_paise, c2.totals.discountPaise);
  assert.deepEqual((await q(`select code, amount_paise from discount_redemptions where order_id = $1`, [o.id])), [{code: 'LAUNCH10', amount_paise: o.discount_paise}]);
  // used up for the next customer (usage limit 1)
  for (const l of (await getCustomerCart(web, asha)).lines) await removeCartLine(web, asha, l);
  await addCartLine(web, asha, {productId: prod.id, size: s.size, qty: 1});
  await assert.rejects(setCartCoupon(web, asha, 'LAUNCH10'), /fully used/);
  // the unpaid order is cancelled: the use comes back
  await q(`update orders set status = 'cancelled' where id = $1`, [o.id]);
  await setCartCoupon(web, asha, 'LAUNCH10');
  assert.equal((await listDiscounts(admin, manager)).find(x => x.id === d.id).uses, 0);
  await set(root, 'discounts.enabled', 'off');
  assert.equal((await getCustomerCart(web, asha, config())).totals.discountPaise, 0, 'switched off again: no discount');
  await setCartCoupon(web, asha, null);
  await q(`update discounts set is_active = false`);
});

// ---------------------------------------------------------------- 2 · shipping
test('shipping: zone rates at checkout (free-from, no zone = refused); courier tracking links; delivery status workflow', async () => {
  const z = await saveShippingZone(admin, manager, shippingZoneInput.parse({name: 'South', 'states': ['Tamil Nadu', 'Kerala'], pinPrefixes: '', active: 'on'}), ctx);
  await assert.rejects(saveShippingZone(admin, manager, shippingZoneInput.parse({name: 'Overlap', states: ['Kerala'], pinPrefixes: '', active: 'on'}), ctx), /already in the zone/);
  await saveShippingRate(admin, manager, shippingRateInput.parse({zoneId: z.id, name: 'Standard', amount: '50', freeFrom: '100000', estMin: '2', estMax: '5', active: 'on'}), ctx);
  await set(root, 'shipping.method', 'zones');
  const s = await sizeOf(prod.id);
  for (const l of (await getCustomerCart(web, ravi)).lines) await removeCartLine(web, ravi, l);
  await addCartLine(web, ravi, {productId: prod.id, size: s.size, qty: 1});
  const near = await getCustomerCart(web, ravi, config(), {state: 'Tamil Nadu', pin: '600001', country: 'IN'});
  assert.deepEqual([near.totals.shippingPaise, near.totals.shipping.label], [prod.price_paise >= 10_000_000 ? 0 : 5000, 'Standard']);
  const far = await getCustomerCart(web, ravi, config(), {state: 'Jammu and Kashmir', pin: '190001', country: 'IN'});
  assert.ok(far.totals.shipping.unavailable);
  await assert.rejects(placeOrder(web, ravi, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: farAddr, expectedTotalPaise: String(far.totals.totalPaise)}), ctx, config()), /do not deliver/);
  // courier with a tracking template; order shipped through the order workflow, then delivery updates here
  await saveCourier(admin, manager, {code: 'testship', name: 'Test Ship', mode: 'manual', trackingUrlTemplate: 'https://track.example/{tracking}', active: true, notes: null}, ctx);
  const placed = await placeOrder(web, ravi, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: raviAddr, expectedTotalPaise: String(near.totals.totalPaise)}), ctx, config());
  await payOrder(ravi, placed.orderNumber);
  const o = await ship(manager, placed.orderNumber, ['processing', 'shipped'], {carrierCode: 'testship', trackingNumber: 'AWB-77'});
  const [sh] = await q(`select id, status, tracking_url from shipments where order_id = $1`, [o.id]);
  assert.deepEqual([sh.status, sh.tracking_url], ['shipped', 'https://track.example/AWB-77']);
  await assert.rejects(updateShipmentStatus(admin, support, {shipmentId: sh.id, status: 'in_transit', courierCode: null, trackingNumber: null, note: null, failureReason: null}, ctx), ForbiddenError);
  await updateShipmentStatus(admin, manager, {shipmentId: sh.id, status: 'in_transit', courierCode: null, trackingNumber: null, note: 'Left hub', failureReason: null}, ctx);
  await assert.rejects(updateShipmentStatus(admin, manager, {shipmentId: sh.id, status: 'failed_delivery', courierCode: null, trackingNumber: null, note: null, failureReason: null}, ctx), /why/);
  await updateShipmentStatus(admin, manager, {shipmentId: sh.id, status: 'failed_delivery', courierCode: null, trackingNumber: null, note: null, failureReason: 'Nobody home'}, ctx);
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'shipment.failed'`))[0].n, 1);
  await assert.rejects(updateShipmentStatus(admin, manager, {shipmentId: sh.id, status: 'packed', courierCode: null, trackingNumber: null, note: null, failureReason: null}, ctx), DomainError);
  await updateShipmentStatus(admin, manager, {shipmentId: sh.id, status: 'delivered', courierCode: null, trackingNumber: null, note: null, failureReason: null}, ctx);
  assert.equal((await orderByNumber(placed.orderNumber)).status, 'delivered', 'delivering the shipment moves the order through its workflow');
  const detail = await getShipmentDetail(admin, manager, sh.id);
  assert.deepEqual(detail.events.map(e => e.status), ['processing', 'packed', 'shipped', 'in_transit', 'failed_delivery', 'delivered'].filter(x => detail.events.some(e => e.status === x)));
  assert.ok(detail.events.some(e => e.status === 'failed_delivery' && e.note === 'Nobody home'));
  await set(root, 'shipping.method', 'none');
});

// ---------------------------------------------------------------- 3 · returns and refunds
test('returns: off by default; request within the window; staff workflow; restock through the ledger; refund through the provider or manual with a reference', async () => {
  const delivered = await owner.selectFrom('orders').select(['id', 'order_number', 'total_paise', 'customer_id']).where('customer_id', '=', ravi.customerId).where('status', '=', 'delivered').executeTakeFirstOrThrow();
  assert.equal((await customerReturnOptions(web, ravi, delivered.order_number)).allowed, false, 'returns are off: all sales final');
  await set(root, 'returns.enabled', 'on');
  assert.equal((await customerReturnOptions(web, ravi, delivered.order_number)).allowed, false, 'no window set: still closed');
  await set(root, 'returns.window_days', '7');
  const opts = await customerReturnOptions(web, ravi, delivered.order_number);
  assert.equal(opts.allowed, true);
  await assert.rejects(customerReturnOptions(web, asha, delivered.order_number), /not found/i, 'another customer\'s order does not exist for them');
  const line = opts.lines[0];
  await assert.rejects(requestReturn(web, ravi, returnRequestInput.parse({orderNumber: delivered.order_number, reasonCode: 'size_fit', items: [{orderItemId: line.id, qty: line.returnable + 1}]}), ctx), ConflictError);
  const r = await requestReturn(web, ravi, returnRequestInput.parse({orderNumber: delivered.order_number, reasonCode: 'size_fit', description: 'Too small', items: [{orderItemId: line.id, qty: 1}]}), ctx);
  assert.match(r.number, /^RET-[A-Z0-9]{8}$/);
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'return.requested' and entity_id = $1`, [r.id]))[0].n, 1);
  const step = (action, extra = {}) => returnAction(admin, manager, {returnId: r.id, action, note: null, pickupAt: null, pickupRef: null, refundAmount: null, ...extra}, ctx);
  await assert.rejects(step('receive'), ConflictError, 'not approved yet');
  await assert.rejects(step('approve'), /refund or exchange/);
  await step('approve', {resolution: 'refund'});
  await step('schedule_pickup', {pickupAt: new Date(Date.now() + 86_400_000), pickupRef: 'PK-1'});
  await step('picked_up'); await step('receive');
  const detail = await getReturn(admin, manager, r.id);
  const stockOf = async id => (await owner.selectFrom('product_variants').select('stock_qty').where('id', '=', id).executeTakeFirstOrThrow()).stock_qty;
  const stockBefore = await stockOf(detail.items[0].variant_id);
  await updateReturnItem(admin, manager, {returnId: r.id, returnItemId: detail.items[0].id, restockQty: 1}, ctx);
  await assert.rejects(updateReturnItem(admin, manager, {returnId: r.id, returnItemId: detail.items[0].id, restockQty: 1}, ctx), /more can be restocked/);
  assert.equal(await stockOf(detail.items[0].variant_id), stockBefore + 1, 'restocked through the ledger');
  assert.equal((await q(`select count(*)::int n from inventory_movements where reason = 'return' and order_id = $1`, [delivered.id]))[0].n, 1);
  await step('inspect', {inspectionResult: 'ok'});
  assert.equal((await getReturn(admin, manager, r.id)).ret.status, 'refund_pending');
  // refunds: needs refunds.create; manual needs a reference; never more than was captured
  await assert.rejects(refundReturn(admin, support, pay, {returnId: r.id, mode: 'manual', amount: 100, reference: 'x', note: 'size'}, ctx), ForbiddenError);
  assert.throws(() => refundInput.parse({returnId: r.id, mode: 'manual', amount: '1', note: 'size'}), /reference/);
  await assert.rejects(refundReturn(admin, root, pay, {returnId: r.id, mode: 'provider', amount: delivered.total_paise + 1, reference: null, note: 'too much'}, ctx), /At most/);
  await assert.rejects(refundReturn(admin, root, null, {returnId: r.id, mode: 'provider', amount: 100, reference: null, note: 'no provider'}, ctx), /manual refund/);
  const res = await refundReturn(admin, root, pay, {returnId: r.id, mode: 'provider', amount: 1000, reference: null, note: 'Size exchange not wanted'}, ctx);
  assert.equal(res.status, 'processed');
  const [f] = await q(`select status, method, provider_refund_id from refunds where return_id = $1`, [r.id]);
  assert.equal(f.status, 'processed'); assert.equal(f.method, 'provider'); assert.match(f.provider_refund_id, /^testrfnd_/);
  assert.equal((await orderByNumber(delivered.order_number)).payment_status, 'partially_refunded');
  await set(root, 'notifications.refund_processed', 'on');
  const { notifyReturn } = await import('@kitsyuu/core');
  assert.deepEqual(await notifyReturn(admin, mailer, r.id, 'refund'), {sent: true});
  assert.match(sent.at(-1).text, /₹10\.00/);
  await step('complete');
  assert.equal((await getReturn(admin, manager, r.id)).ret.status, 'completed');
  // the customer sees the history, never staff notes
  const { getCustomerReturn } = await import('@kitsyuu/core');
  const mine = await getCustomerReturn(web, ravi, r.number);
  assert.ok(!('note' in mine.events[0]));
  await set(root, 'returns.enabled', 'off');
});

// ---------------------------------------------------------------- 4 · marketing
test('marketing: campaigns, banners (public only while live), segments computed from orders', async () => {
  const c = await saveCampaign(admin, manager, campaignInput.parse({name: 'Diwali drop', active: 'on'}), ctx);
  await assert.rejects(saveCampaign(admin, support, campaignInput.parse({name: 'x'}), ctx), ForbiddenError);
  const b = await saveBanner(admin, manager, bannerInput.parse({placement: 'home', heading: 'New drop Friday', ctaLabel: 'Shop', link: '/shop', campaignId: c.id}), ctx);
  assert.throws(() => bannerInput.parse({placement: 'home', heading: 'x', ctaLabel: 'Go', link: 'https://evil.example'}));
  const anon = async () => { const cl = await pool.connect(); try { await cl.query('begin; set local role anon'); return (await cl.query('select heading from banners')).rows; } finally { await cl.query('rollback'); cl.release(); } };
  assert.deepEqual(await anon(), [], 'a draft banner is not public');
  await saveBanner(admin, manager, bannerInput.parse({bannerId: b.id, placement: 'home', heading: 'New drop Friday', ctaLabel: 'Shop', link: '/shop', active: 'on', campaignId: c.id}), ctx);
  assert.deepEqual(await anon(), [{heading: 'New drop Friday'}]);
  await q(`update banners set ends_at = now() - interval '1 minute', starts_at = null where id = $1`, [b.id]);
  assert.deepEqual(await anon(), [], 'expired banners disappear');
  const seg = await saveSegment(admin, manager, segmentInput.parse({name: 'Buyers', minOrders: '1'}), ctx);
  const g = await getSegment(admin, manager, seg.id);
  assert.ok(g.members.rows.some(m => m.email === 'ravi.erp@test.local'));
  assert.throws(() => segmentInput.parse({name: 'Empty'}), /at least one rule/);
  assert.ok(Array.isArray(await promotionReport(admin, manager, {from: '2026-01-01', to: '2030-12-31'})));
});

// ---------------------------------------------------------------- 5 · support
test('support: customer tickets, staff replies and internal notes (never visible to the store), assignment, reopen on reply', async () => {
  const t = await openCustomerTicket(web, asha, {subject: 'Where is my order?', categoryCode: 'order', orderNumber: null, body: 'Please tell me when it ships.'}, ctx);
  assert.match(t.number, /^TCK-/);
  await assert.rejects(openCustomerTicket(web, asha, {subject: 'x order', categoryCode: 'order', orderNumber: 'KTS-NOPE-1', body: 'about someone else order'}, ctx), /could not find/);
  await replyToTicket(admin, support, {ticketId: t.id, body: 'Internal: courier delayed', internal: true}, ctx);
  await replyToTicket(admin, support, {ticketId: t.id, body: 'It ships tomorrow.', internal: false}, ctx);
  const seen = await getCustomerTicket(web, asha, t.number);
  assert.deepEqual(seen.messages.map(m => m.body), ['Please tell me when it ships.', 'It ships tomorrow.']);
  assert.deepEqual((await web.selectFrom('support_messages').select('body').where('is_internal', '=', true).execute()), [], 'RLS: the store role cannot read internal notes');
  assert.equal(seen.status, 'waiting_customer');
  await replyAsCustomer(web, asha, {ticketNumber: t.number, body: 'Thanks!'}, ctx);
  assert.equal((await getCustomerTicket(web, asha, t.number)).status, 'in_progress', 'a customer reply puts it back with staff');
  await updateTicket(admin, support, {ticketId: t.id, status: 'closed', priority: 'low', categoryCode: 'order', assignedTo: null}, ctx);
  await assert.rejects(replyAsCustomer(web, asha, {ticketNumber: t.number, body: 'again'}, ctx), /closed/);
  assert.deepEqual(await notifyTicketReply(admin, mailer, t.id), {sent: false, reason: 'off'});
  await assert.rejects(listTickets(admin, inventory, {status: 'all', priority: 'all', assignee: 'all', page: 1}), ForbiddenError);
});

// ---------------------------------------------------------------- 6 · finance
test('finance: invoices match what was charged, GST split by state, notes within the invoice, expenses, reconciliation of platform records', async () => {
  const paid = await owner.selectFrom('orders').select(['id', 'order_number', 'tax_paise', 'total_paise']).where('status', 'in', ['paid', 'processing', 'shipped', 'delivered']).orderBy('created_at').executeTakeFirstOrThrow();
  await assert.rejects(createInvoiceForOrder(admin, support, {orderId: paid.id}, ctx), ForbiddenError);
  const inv = await createInvoiceForOrder(admin, accountant, {orderId: paid.id}, ctx);
  assert.match(inv.number, /^KTS\/\d{2}-\d{2}\/00001$/);
  await assert.rejects(createInvoiceForOrder(admin, accountant, {orderId: paid.id}, ctx), /already has an invoice/);
  const got = await getInvoice(admin, accountant, inv.id);
  assert.equal(got.items.reduce((n, i) => n + i.tax_paise, 0), paid.tax_paise, 'invoice tax = tax charged');
  assert.equal(got.invoice.total_paise, paid.total_paise);
  assert.equal(got.invoice.tax_split.type, 'unknown', 'no registered state: not guessed');
  await assert.rejects(createFinanceNote(admin, accountant, {kind: 'credit', invoiceId: inv.id, reason: 'too much', amount: paid.total_paise + 1, tax: null}, ctx), /cannot exceed/);
  const n = await createFinanceNote(admin, accountant, {kind: 'credit', invoiceId: inv.id, reason: 'Goodwill', amount: 100, tax: 0}, ctx);
  const issued = await setFinanceNoteStatus(admin, accountant, {noteId: n.id, status: 'issued'}, ctx);
  assert.match(issued.number, /^KTS-C\//);
  await saveTaxRate(admin, accountant, taxRateInput.parse({code: 'GST5', label: 'GST 5%', ratePercent: '5', inclusive: 'on', validFrom: '2030-01-01', active: 'on'}), ctx);
  await saveExpense(admin, accountant, {categoryCode: 'packaging', amount: 25_000, tax: 1_000, date: '2026-09-29', description: 'Mailer boxes', reference: 'INV-9'}, ctx);
  const sum = await financeSummary(admin, accountant, {from: '2026-01-01', to: '2030-12-31'});
  assert.equal(sum.expenseTotal, 25_000);
  const rec = await reconciliation(admin, accountant, {from: '2026-01-01', to: '2030-12-31'});
  assert.ok(rec.days.length >= 1); assert.match(rec.note, /not a bank reconciliation/);
  assert.ok(rec.days.every(d => d.matches), 'every paid order has its captured payment');
});

// ---------------------------------------------------------------- 7 · carts
test('carts: read-only for staff; abandoned only with the business threshold; recovery status; reminder email only when switched on', async () => {
  const s = await sizeOf(prod2.id);
  for (const l of (await getCustomerCart(web, asha)).lines) await removeCartLine(web, asha, l);
  await addCartLine(web, asha, {productId: prod2.id, size: s.size, qty: 1});
  const cartId = (await owner.selectFrom('carts').select('id').where('customer_id', '=', asha.customerId).where('status', '=', 'active').executeTakeFirstOrThrow()).id;
  // Back-date the cart (the updated_at triggers are skipped for this one local transaction).
  await pool.query(`begin; set local session_replication_role = replica; update carts set updated_at = now() - interval '3 days' where id = '${cartId}';
    update cart_items set updated_at = now() - interval '3 days' where cart_id = '${cartId}'; commit;`);
  assert.equal((await listCarts(admin, manager, {view: 'abandoned', page: 1})).rows.length, 0, 'no threshold: nothing is abandoned');
  await set(root, 'carts.abandon_after_hours', '24');
  const list = await listCarts(admin, manager, {view: 'abandoned', page: 1});
  assert.deepEqual(list.rows.map(r => r.id), [cartId]);
  assert.equal((await getCart(admin, manager, cartId)).abandoned, true);
  await assert.rejects(admin.updateTable('cart_items').set({qty: 9}).where('cart_id', '=', cartId).execute(), /permission denied/, 'staff can never change a customer cart');
  await assert.rejects(sendCartReminder(admin, inventory, mailer, {cartId}, ctx), ForbiddenError);
  assert.deepEqual(await sendCartReminder(admin, manager, mailer, {cartId}, ctx), {sent: false, reason: 'off'});
  await set(root, 'notifications.abandoned_cart', 'on');
  assert.deepEqual(await sendCartReminder(admin, manager, mailer, {cartId}, ctx, {storeUrl: 'https://store.test'}), {sent: true});
  assert.match(sent.at(-1).text, /https:\/\/store\.test\/cart/);
  assert.equal((await getCart(admin, manager, cartId)).cart.recovery_status, 'emailed');
  await setCartRecovery(admin, manager, {cartId, status: 'dismissed', note: 'Customer said later'}, ctx);
  await assert.rejects(sendCartReminder(admin, manager, mailer, {cartId}, ctx), /dismissed/);
  assert.equal((await q(`select count(*)::int n from cart_items where cart_id = $1 and qty = 1`, [cartId]))[0].n, 1, 'the cart itself is unchanged');
});

test('returns: a refused provider refund is recorded as failed (nothing marked refunded) and raised; exchanges take the new size from stock', async () => {
  await set(root, 'returns.enabled', 'on');
  const s = await sizeOf(prod.id);
  const placed = await checkout(asha, ashaAddr, [{productId: prod.id, size: s.size, qty: 2}]);
  await payOrder(asha, placed.orderNumber);
  await ship(manager, placed.orderNumber, ['processing', 'shipped', 'delivered']);
  const opts = await customerReturnOptions(web, asha, placed.orderNumber);
  const line = opts.lines[0];
  const refundCase = await requestReturn(web, asha, returnRequestInput.parse({orderNumber: placed.orderNumber, reasonCode: 'damaged', items: [{orderItemId: line.id, qty: 1}]}), ctx);
  const step = (id, action, extra = {}) => returnAction(admin, manager, {returnId: id, action, note: null, pickupAt: null, pickupRef: null, refundAmount: null, ...extra}, ctx);
  await step(refundCase.id, 'approve', {resolution: 'refund'}); await step(refundCase.id, 'receive'); await step(refundCase.id, 'inspect', {inspectionResult: 'damaged'});
  const refusing = {...pay, refund: async () => { throw new Error('Refund declined (test)'); }};
  await assert.rejects(refundReturn(admin, root, refusing, {returnId: refundCase.id, mode: 'provider', amount: 500, reference: null, note: 'damaged'}, ctx), /Nothing was refunded/);
  const [f] = await q(`select status, failure_reason from refunds where return_id = $1`, [refundCase.id]);
  assert.equal(f.status, 'failed'); assert.match(f.failure_reason, /declined/);
  assert.equal((await getReturn(admin, manager, refundCase.id)).ret.status, 'refund_pending', 'still waiting for a refund');
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'refund.failed'`))[0].n, 1);
  // manual refund with its reference after the provider refused
  await refundReturn(admin, root, null, {returnId: refundCase.id, mode: 'manual', amount: 500, reference: 'UPI-REF-123', note: 'Paid by UPI'}, ctx);
  assert.deepEqual(await q(`select status, method, reference from refunds where return_id = $1 order by created_at`, [refundCase.id]),
    [{status: 'failed', method: 'provider', reference: null}, {status: 'processed', method: 'manual', reference: 'UPI-REF-123'}]);
  // exchange: replacement size chosen, then shipped through the ledger
  const ex = await requestReturn(web, asha, returnRequestInput.parse({orderNumber: placed.orderNumber, reasonCode: 'size_fit', items: [{orderItemId: line.id, qty: 1}]}), ctx);
  await step(ex.id, 'approve', {resolution: 'exchange'}); await step(ex.id, 'receive'); await step(ex.id, 'inspect', {inspectionResult: 'ok'});
  assert.equal((await getReturn(admin, manager, ex.id)).ret.status, 'exchange_pending');
  await assert.rejects(step(ex.id, 'ship_exchange'), /replacement size/);
  const d = await getReturn(admin, manager, ex.id);
  const other = d.sizes.find(z => z.product_id === prod.id && z.is_active);
  const before = (await q(`select stock_qty from product_variants where id = $1`, [other.id]))[0].stock_qty;
  await updateReturnItem(admin, manager, {returnId: ex.id, returnItemId: d.items[0].id, exchangeVariantId: other.id}, ctx);
  await step(ex.id, 'ship_exchange', {note: 'AWB EX-1'});
  assert.equal((await q(`select stock_qty from product_variants where id = $1`, [other.id]))[0].stock_qty, before - 1);
  assert.equal((await q(`select count(*)::int n from inventory_movements where reason = 'exchange' and order_id = (select id from orders where order_number = $1)`, [placed.orderNumber]))[0].n, 1);
  assert.deepEqual((await customerReturnOptions(web, asha, placed.orderNumber)).allowed, false, 'both units are now in returns');
  await set(root, 'returns.enabled', 'off');
});
