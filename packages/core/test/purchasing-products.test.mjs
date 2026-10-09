/* Purchasing and product workflows (2026-10-01), against the LOCAL test database: vendors supply finished products (chosen
   several at once); purchase orders draft → approved → sent → partly received → received → closed with numbered goods
   receipts (GRN) and partial receiving; product approval (draft → review → published); bulk edit draft change sets;
   production batches linked to a PO; COD % discount; order-placed email once; order edits (add product, delivery option,
   contact, staff discount) locked after shipping; loyalty totals and refund reversal; customer filters; one review per
   product with the purchased variant; store pickup and delivery option descriptions. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, ForbiddenError, customerListQuery, orderEditInput, placeOrderInput, settingUpdateInput, shippingRateInput, shippingZoneInput, submitReviewInput, vendorInput,
} from '@kitsyuu/contracts';
import {
  addCartLine, adjustPointsForRefunds, applyBulkEditDraft, approvedReviews, codDiscount, createBulkEditDraft, createProductionOrders, createPurchaseOrderWithLines,
  customerReviewState, databaseDiscounts, defaultCommerceConfig, editOrder, getBulkEditDraft, getCustomerCart, getGoodsReceipt, getPurchaseOrder, linkProductionToPurchaseOrder,
  listCustomers, loyaltyTotals, moderateReview, orderEditBlocker, placeOrder, purchasableSizes, readCodSettings, receiveGoods, recordCodCollected, removeCartLine,
  saveCustomerAddress, saveLocation, saveShippingRate, saveShippingZone, saveVendor, sendOrderPlacedEmail, setProductStatus, setPurchaseOrderStatus, setVendorProducts,
  settingsShipping, submitReview, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'purchasing-products.test', requestId: 'test'};
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const SHIP_TO = {state: 'Tamil Nadu', pin: '600001', country: 'IN'};
const mails = []; const mailer = {kind: 'test', send: async m => { mails.push(m); }};
const set = (key, value) => updateSetting(admin, root, settingUpdateInput.parse({key, value}), ctx);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'purchasing test passphrase', fullName: role}, ctx)).token);
}
async function customer(email, name) {
  const id = (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  const c = {customerId: id, email, fullName: name, emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'};
  c.addr = await saveCustomerAddress(web, c, {fullName: name, phone: '9876543210', line1: '1 Anna Salai', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true}, ctx);
  return c;
}
const stock = async variantId => (await q(`select stock_qty n from product_variants where id = $1`, [variantId]))[0].n;
const variant = async sku => (await q(`select v.id, v.size, v.sku, p.id product_id, p.price_paise from product_variants v join products p on p.id = v.product_id where v.sku = $1`, [sku]))[0];
const emptyCart = async c => { for (const l of (await getCustomerCart(web, c)).lines) await removeCartLine(web, c, l); };
async function codOrder(c, lines) {
  await emptyCart(c);
  for (const l of lines) await addCartLine(web, c, l);
  const cart = await getCustomerCart(web, c, config(), SHIP_TO, {method: 'cod', usePoints: false});
  const placed = await placeOrder(web, c, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: c.addr, expectedTotalPaise: String(cart.totals.totalPaise),
    paymentMethod: 'cod'}), ctx, config());
  const [o] = await q(`select * from orders where order_number = $1`, [placed.orderNumber]);
  return {cart, o};
}

let root, manager, support, asha, ravi, vendor, store1, rates = {};
before(async () => {
  root = await staff('pp.root@test.local', 'super_admin');
  manager = await staff('pp.manager@test.local', 'manager');
  support = await staff('pp.support@test.local', 'support');
  asha = await customer('pp.asha@test.local', 'Asha'); ravi = await customer('pp.ravi@test.local', 'Ravi');
  store1 = (await saveLocation(admin, root, {code: 'PP-S1', name: 'Chennai Store 1', kind: 'retail', address: 'T. Nagar, Chennai', active: true}, ctx)).id;
  const z = await saveShippingZone(admin, root, shippingZoneInput.parse({name: 'PP South', states: ['Tamil Nadu'], pinPrefixes: '', active: 'on'}), ctx);
  rates.standard = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Standard', amount: '50', estMin: '3', estMax: '5', codAllowed: 'on', active: 'on'}), ctx);
  rates.express = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Express', amount: '150', estMin: '1', estMax: '2', codAllowed: 'on', active: 'on',
    description: 'Dispatched the same day before 2 pm'}), ctx);
  rates.pickup = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Store pickup', amount: '0', estMin: '0', estMax: '1', codAllowed: 'on', active: 'on',
    pickupLocationId: store1}), ctx);
  await set('shipping.method', 'zones');
  await set('payments.cod_enabled', 'on');
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

// ---------------------------------------------------------------- vendors and purchasing
test('vendors supply finished products: several chosen at once, audited; only managers may change them', async () => {
  vendor = await saveVendor(admin, manager, vendorInput.parse({name: 'Tiruppur Knits', email: 'orders@tiruppur.test'}), ctx);
  const [a, b] = await q(`select id from products order by sku limit 2`);
  const r = await setVendorProducts(admin, manager, {vendorId: vendor.id, productIds: [a.id, b.id, a.id]}, ctx);
  assert.deepEqual([r.added, r.removed, r.total], [2, 0, 2], 'duplicates ignored');
  const sizes = await purchasableSizes(admin, manager, vendor.id);
  assert.ok(sizes.filter(s => s.supplied).length >= 2 && sizes.some(s => !s.supplied), 'supplied sizes are flagged; others still choosable');
  assert.deepEqual(await setVendorProducts(admin, manager, {vendorId: vendor.id, productIds: [a.id]}, ctx), {added: 0, removed: 1, total: 1});
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'vendor.products'`))[0].n, 2);
  await assert.rejects(setVendorProducts(admin, support, {vendorId: vendor.id, productIds: []}, ctx), ForbiddenError);
});

let po, v1, v2;
test('purchase order: creating it moves no stock; approval needed; partial receiving with GRN numbers; ordered / received / remaining; close', async () => {
  v1 = await variant('KTS-TOP-003-M'); v2 = await variant('KTS-TOP-003-L');
  const [s1, s2] = [await stock(v1.id), await stock(v2.id)];
  po = await createPurchaseOrderWithLines(admin, root, {vendorId: vendor.id, expectedOn: '2026-10-20', notes: 'Diwali restock', locationId: null,
    lines: [{variantId: v1.id, qty: 10, unitCostPaise: 40000}, {variantId: v2.id, qty: 5, unitCostPaise: 40000}]}, ctx);
  assert.deepEqual([await stock(v1.id), await stock(v2.id)], [s1, s2], 'a PO does not touch inventory');
  let d = await getPurchaseOrder(admin, manager, po.id);
  assert.equal(d.order.status, 'draft');
  await assert.rejects(setPurchaseOrderStatus(admin, manager, {purchaseOrderId: po.id, status: 'approved', expectedStatus: 'draft', note: null}, ctx), ForbiddenError, 'a manager cannot approve');
  await assert.rejects(setPurchaseOrderStatus(admin, manager, {purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx), ForbiddenError, 'nor send an unapproved draft');
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'approved', expectedStatus: 'draft', note: null}, ctx);
  await assert.rejects(receiveGoods(admin, manager, {purchaseOrderId: po.id, lines: [{lineId: d.lines[0].id, qty: 1, expectedReceived: 0}], note: null}, ctx), ConflictError, 'nothing is received before it is sent');
  await setPurchaseOrderStatus(admin, manager, {purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'approved', note: null}, ctx);
  d = await getPurchaseOrder(admin, manager, po.id);
  const [l1, l2] = d.lines;
  assert.ok(d.order.approved_at && d.order.approved_by === 'pp.root@test.local' && d.order.ordered_at);
  // First delivery: 4 of 10.
  const g1 = await receiveGoods(admin, manager, {purchaseOrderId: po.id, lines: [{lineId: l1.id, qty: 4, expectedReceived: 0}], note: 'First lot', vendorRef: 'DC-101'}, ctx);
  assert.match(g1.receiptNumber, /^GRN/); assert.equal(g1.status, 'partially_received');
  assert.equal(await stock(v1.id), s1 + 4);
  const [m] = await q(`select reason, delta, unit_cost_paise, goods_receipt_id from inventory_movements where variant_id = $1 order by id desc limit 1`, [v1.id]);
  assert.deepEqual([m.reason, m.delta, m.unit_cost_paise, m.goods_receipt_id], ['purchase_in', 4, 40000, g1.receiptId], 'through the ledger, with cost and its GRN');
  await assert.rejects(receiveGoods(admin, manager, {purchaseOrderId: po.id, lines: [{lineId: l1.id, qty: 7, expectedReceived: 4}], note: null}, ctx), /more|outstanding|ordered/i, 'never more than remains');
  // Second delivery: the rest of line 1, 2 of line 2.
  const g2 = await receiveGoods(admin, manager, {purchaseOrderId: po.id, lines: [{lineId: l1.id, qty: 6, expectedReceived: 4}, {lineId: l2.id, qty: 2, expectedReceived: 0}], note: null, vendorRef: 'DC-102'}, ctx);
  assert.notEqual(g2.receiptNumber, g1.receiptNumber);
  d = await getPurchaseOrder(admin, manager, po.id);
  assert.deepEqual(d.lines.map(l => [l.ordered, l.received, l.outstanding]), [[10, 10, 0], [5, 2, 3]]);
  assert.deepEqual(d.receipts.map(r => r.vendor_ref), ['DC-101', 'DC-102'], 'receiving history');
  const grn = await getGoodsReceipt(admin, manager, g2.receiptId);
  assert.deepEqual(grn.lines.map(l => l.qty), [6, 2]); assert.equal(grn.receipt.po_number, d.order.po_number);
  assert.deepEqual([await stock(v1.id), await stock(v2.id)], [s1 + 10, s2 + 2]);
  // Closing with 3 still to come needs a reason, and an approver.
  await assert.rejects(setPurchaseOrderStatus(admin, manager, {purchaseOrderId: po.id, status: 'closed', expectedStatus: 'partially_received', note: 'Short shipped'}, ctx), ForbiddenError);
  await assert.rejects(setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'closed', expectedStatus: 'partially_received', note: null}, ctx), /reason|note/i);
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'closed', expectedStatus: 'partially_received', note: 'Vendor short-shipped 3 pieces'}, ctx);
  d = await getPurchaseOrder(admin, manager, po.id);
  assert.deepEqual([d.order.status, d.order.close_note, d.next], ['closed', 'Vendor short-shipped 3 pieces', []]);
});

test('production: several sizes planned as one batch; linked to a purchase order without moving stock', async () => {
  const a = await variant('KTS-TOP-004-S'), b = await variant('KTS-TOP-004-M');
  const before = [await stock(a.id), await stock(b.id)];
  const r = await createProductionOrders(admin, manager, {lines: [{variantId: a.id, qty: 5}, {variantId: b.id, qty: 8}], dueOn: null, notes: null, batchRef: null}, ctx);
  assert.equal(r.orders.length, 2); assert.equal(r.batchRef, r.orders[0].number, 'the batch is named after the first order');
  assert.deepEqual((await q(`select batch_ref from production_orders where id = any($1) order by number`, [r.orders.map(o => o.id)])).map(x => x.batch_ref), [r.batchRef, r.batchRef]);
  const draft = await createPurchaseOrderWithLines(admin, manager, {vendorId: vendor.id, expectedOn: null, notes: 'Trims for the batch', locationId: null,
    lines: [{variantId: a.id, qty: 1, unitCostPaise: null}]}, ctx);
  const l = await linkProductionToPurchaseOrder(admin, manager, {productionOrderIds: r.orders.map(o => o.id), purchaseOrderId: draft.id}, ctx);
  assert.deepEqual([l.linked, l.already], [2, 0]);
  assert.deepEqual(await linkProductionToPurchaseOrder(admin, manager, {productionOrderIds: [r.orders[0].id], purchaseOrderId: draft.id}, ctx).then(x => [x.linked, x.already]), [0, 1]);
  assert.deepEqual([await stock(a.id), await stock(b.id)], before, 'linking moves no stock');
  await q(`update production_orders set status = 'cancelled' where id = $1`, [r.orders[1].id]);
  await assert.rejects(linkProductionToPurchaseOrder(admin, manager, {productionOrderIds: [r.orders[1].id], purchaseOrderId: po.id}, ctx), /finished or cancelled/);
  await assert.rejects(createProductionOrders(admin, manager, {lines: [{variantId: a.id, qty: 1}, {variantId: a.id, qty: 2}], dueOn: null, notes: null, batchRef: null}, ctx), /twice/);
});

// ---------------------------------------------------------------- products
test('product approval: managers submit, only approvers publish; a hidden product is not readable by the store', async () => {
  const [p] = await q(`select id, slug from products order by sku desc limit 1`);
  await setProductStatus(admin, manager, {productId: p.id, status: 'draft'}, ctx);
  const visible = async () => (await web.selectFrom('products').select('id').where('id', '=', p.id).where('status', '=', 'active').execute()).length;
  assert.equal(await visible(), 0, 'a draft is not served to the store');
  await assert.rejects(setProductStatus(admin, manager, {productId: p.id, status: 'active'}, ctx), ForbiddenError, 'publishing needs products.publish');
  await setProductStatus(admin, manager, {productId: p.id, status: 'review'}, ctx);
  let [r] = await q(`select status, submitted_by, approved_by from products where id = $1`, [p.id]);
  assert.deepEqual([r.status, r.submitted_by, r.approved_by], ['review', manager.staffId, null]);
  await setProductStatus(admin, root, {productId: p.id, status: 'active'}, ctx);
  [r] = await q(`select status, approved_by from products where id = $1`, [p.id]);
  assert.deepEqual([r.status, r.approved_by], ['active', root.staffId]);
  assert.equal(await visible(), 1);
});

test('bulk edit: saved as a draft change set (old → new), nothing changes until applied; applied once; a price changed since is refused', async () => {
  const ps = await q(`select id, price_paise from products order by sku limit 3`);
  const d = await createBulkEditDraft(admin, manager, {productIds: ps.slice(0, 2).map(p => p.id), changes: [{action: 'price_percent', percent: 10}], note: 'Festive prices'}, ctx);
  assert.match(d.number, /^BULK/);
  assert.deepEqual((await q(`select price_paise from products where id = any($1) order by sku`, [ps.slice(0, 2).map(p => p.id)])).map(x => x.price_paise), ps.slice(0, 2).map(p => p.price_paise), 'unchanged while a draft');
  const view = await getBulkEditDraft(admin, manager, d.id);
  assert.equal(view.preview.length, 2); assert.equal(view.preview[0].changes[0].field, 'Price');
  const res = await applyBulkEditDraft(admin, root, {draftId: d.id}, ctx);
  assert.deepEqual([res.applied.length, res.failed.length], [2, 0]);
  const now = await q(`select price_paise from products where id = any($1) order by sku`, [ps.slice(0, 2).map(p => p.id)]);
  assert.ok(now.every((x, i) => x.price_paise > ps[i].price_paise), 'prices raised');
  await assert.rejects(applyBulkEditDraft(admin, root, {draftId: d.id}, ctx), /already applied/);
  const [x] = await q(`select status, applied_by from bulk_edit_drafts where id = $1`, [d.id]);
  assert.deepEqual([x.status, x.applied_by], ['applied', root.staffId]);
  // Stale: the price changed after the draft was saved.
  const d2 = await createBulkEditDraft(admin, manager, {productIds: [ps[2].id], changes: [{action: 'price_set', price: 99900}], note: null}, ctx);
  await q(`update products set price_paise = price_paise + 100 where id = $1`, [ps[2].id]);
  const res2 = await applyBulkEditDraft(admin, root, {draftId: d2.id}, ctx);
  assert.equal(res2.failed.length, 1, 'not overwritten');
});

// ---------------------------------------------------------------- orders
test('COD % discount: from a minimum order value, never stacked with another discount unless allowed', async () => {
  await set('payments.cod_discount_percent', '5');
  await set('payments.cod_discount_min_order', '5000');
  let s = await readCodSettings(admin);
  assert.deepEqual(codDiscount(s, 600000, 0), {discountPaise: 30000, discountLabel: 'Cash on delivery discount 5% (orders of ₹5,000 or more)'});
  assert.equal(codDiscount(s, 499999, 0).discountPaise, 0, 'below the minimum');
  assert.equal(codDiscount(s, 600000, 1000).discountPaise, 0, 'no stacking by default');
  await set('payments.cod_discount_with_other', 'yes');
  s = await readCodSettings(admin);
  assert.equal(codDiscount(s, 600000, 1000).discountPaise, 30000);
  await set('payments.cod_discount_with_other', 'no');
});

let codO;
test('COD order: discount shown and stored with its reason; the order-placed email is sent once even when asked twice at once', async () => {
  const v = await variant('KTS-TOP-005-M');
  const qty = Math.min(9, Math.ceil(500000 / v.price_paise));
  const {cart, o} = await codOrder(asha, [{productId: v.product_id, size: v.size, qty}]);
  codO = o;
  const cod = (o.pricing.discounts ?? []).find(d => d.code === 'COD');
  if (v.price_paise * qty >= 500000) {
    assert.ok(cod && /5%/.test(cod.label), 'the COD discount line is on the order');
    assert.equal(cart.totals.discountPaise, o.discount_paise);
  }
  assert.equal(o.total_paise, o.subtotal_paise - o.discount_paise + o.shipping_paise + o.cod_fee_paise + (o.prices_include_tax ? 0 : o.tax_paise), 'subtotal − discount + delivery (+ tax) = total');
  mails.length = 0;
  const r = await Promise.all([1, 2, 3].map(() => sendOrderPlacedEmail(admin, mailer, o.order_number, {orderUrl: 'http://localhost:3001/account/orders/x'})));
  assert.equal(r.filter(x => x.sent).length, 1, 'one send');
  assert.equal(mails.length, 1); assert.equal(mails[0].to, asha.email);
  assert.deepEqual(r.filter(x => !x.sent).map(x => x.reason), ['duplicate', 'duplicate']);
  assert.equal((await q(`select count(*)::int n from notification_log where event = 'order.placed' and status = 'sent'`))[0].n, 1);
});

test('order edit before shipping: add a product, delivery option, contact and staff discount, with the trail; locked once shipped', async () => {
  await set('discounts.staff_max_percent', '10');
  const add = await variant('KTS-BTM-001-M');
  const items = await q(`select id, variant_id, qty from order_items where order_id = $1`, [codO.id]);
  const s0 = await stock(add.id);
  const input = orderEditInput.parse({orderId: codO.id, expectedTotalPaise: String(codO.total_paise), note: 'Customer called: add jeans, express, new email',
    'itemIds': items.map(i => i.id), 'variantIds': items.map(i => i.variant_id), 'qtys': items.map(i => String(i.qty)),
    addVariantId: add.id, addQty: '1', deliveryRateId: rates.express.id, changeContact: 'on', contactName: 'Asha R', contactEmail: 'asha.new@test.local', contactPhone: '9876500000',
    staffDiscountPercent: '5', staffDiscountReason: 'Apology for the delay'});
  await assert.rejects(editOrder(admin, manager, input, ctx, {shipping: settingsShipping(() => admin)}), ForbiddenError, 'orders.edit');
  const r = await editOrder(admin, root, input, ctx, {shipping: settingsShipping(() => admin)});
  assert.equal(r.cod, true);
  const [o] = await q(`select * from orders where id = $1`, [codO.id]);
  assert.equal((await q(`select count(*)::int n from order_items where order_id = $1`, [o.id]))[0].n, items.length + 1);
  assert.equal(await stock(add.id), s0 - 1, 'the added piece is taken through the ledger');
  assert.equal(o.contact.email, 'asha.new@test.local');
  assert.match(o.pricing.shipping.label, /Express/); assert.equal(o.shipping_paise, 15000);
  assert.equal(o.staff_discount_bp, 500); assert.ok(o.pricing.discounts.some(d => d.code === 'STAFF' && /Apology/.test(d.label)));
  assert.ok(!o.pricing.discounts.some(d => d.code === 'COD'), 'the COD discount is not stacked with the staff discount');
  assert.equal(o.total_paise, o.subtotal_paise - o.discount_paise + o.shipping_paise + o.cod_fee_paise + (o.prices_include_tax ? 0 : o.tax_paise));
  const [e] = await q(`select before, after, note, staff_id, total_before, total_after from order_edits where order_id = $1`, [o.id]);
  assert.deepEqual([e.staff_id, e.total_before, e.total_after], [root.staffId, codO.total_paise, o.total_paise]);
  assert.equal(e.after.lines.length, e.before.lines.length + 1); assert.equal(e.after.staffDiscountBp, 500); assert.match(e.after.delivery, /Express/);
  // Above the staff maximum: refused.
  const again = orderEditInput.parse({orderId: o.id, expectedTotalPaise: String(o.total_paise), note: 'More', itemIds: [], variantIds: [], qtys: [],
    ...(await q(`select id, variant_id, qty from order_items where order_id = $1`, [o.id])).reduce((a, i) => ({itemIds: [...a.itemIds, i.id], variantIds: [...a.variantIds, i.variant_id], qtys: [...a.qtys, String(i.qty)]}), {itemIds: [], variantIds: [], qtys: []}),
    staffDiscountPercent: '20', staffDiscountReason: 'x'});
  await assert.rejects(editOrder(admin, root, again, ctx, {shipping: settingsShipping(() => admin)}), /above the maximum/);
  // Shipped: locked, pointing to returns.
  await q(`update orders set status = 'shipped' where id = $1`, [o.id]);
  assert.match(await orderEditBlocker(admin, o.id), /locked.*return, exchange or refund/);
  await q(`update orders set status = 'processing' where id = $1`, [o.id]);
  codO = o;
});

test('loyalty: earned on a paid order, totals (earned / used / expired), proportional reversal on a refund, never twice', async () => {
  await set('loyalty.enabled', 'on'); await set('loyalty.earn_points_per_100', '1'); await set('loyalty.earn_when', 'paid'); await set('loyalty.point_value_paise', '100');
  await q(`update orders set status = 'shipped' where id = $1`, [codO.id]);   // cash is collected on delivery
  await recordCodCollected(admin, root, {orderId: codO.id, amountPaise: codO.total_paise, reference: 'cash', note: null}, ctx);
  const [earn] = await q(`select points from loyalty_transactions where order_id = $1 and kind = 'earn'`, [codO.id]);
  assert.ok(earn && earn.points > 0, 'points earned once paid');
  let t = await loyaltyTotals(admin, asha.customerId);
  assert.deepEqual(t, {earned: earn.points, used: 0, expired: 0, reversed: 0});
  const [pay] = await q(`select id from payments where order_id = $1`, [codO.id]);
  const half = Math.floor((codO.subtotal_paise - codO.discount_paise) / 2);
  await q(`insert into refunds (payment_id, order_id, amount_paise, reason, status, method, reference) values ($1, $2, $3, 'test refund', 'processed', 'manual', 'UPI-1')`, [pay.id, codO.id, half]);
  const taken = await admin.transaction().execute(tx => adjustPointsForRefunds(tx, codO.id));
  assert.ok(taken > 0 && taken <= Math.ceil(earn.points / 2), `about half taken back (${taken} of ${earn.points})`);
  assert.equal(await admin.transaction().execute(tx => adjustPointsForRefunds(tx, codO.id)), 0, 'never twice');
  t = await loyaltyTotals(admin, asha.customerId);
  assert.deepEqual([t.earned, t.reversed], [earn.points, taken]);
});

test('customer filters combine: payment method, with / without orders, points range, order count, spend, place', async () => {
  const ids = async p => (await listCustomers(admin, manager, customerListQuery.parse(p))).rows.map(r => r.id);
  assert.ok((await ids({payment: 'cod'})).includes(asha.customerId));
  assert.ok(!(await ids({payment: 'cod'})).includes(ravi.customerId));
  assert.ok((await ids({orders: 'without'})).includes(ravi.customerId));
  assert.deepEqual(await ids({orders: 'with', minPoints: '1', minOrders: '1', minSpend: '1'}), [asha.customerId]);
  assert.deepEqual(await ids({maxPoints: '0', orders: 'with'}), []);
  assert.ok((await ids({place: 'Chennai'})).includes(asha.customerId));
});

test('reviews: verified purchase only, one per product, purchased variant recorded, only approved shown', async () => {
  await set('reviews.eligibility', 'paid');
  const st = await customerReviewState(web, asha);
  const item = st.reviewable[0];
  assert.ok(item, 'the paid order can be reviewed');
  assert.equal(new Set(st.reviewable.map(i => i.product_id)).size, st.reviewable.length, 'one entry per product');
  const r = await submitReview(web, asha, submitReviewInput.parse({orderItemId: item.id, rating: '5', title: 'Lovely', body: 'Fits well and the fabric is soft.', displayName: 'Asha'}), [], ctx);
  const [row] = await q(`select status, variant_label from reviews where id = $1`, [r.id ?? r.reviewId]);
  assert.equal(row.status, 'pending'); assert.ok(row.variant_label, 'the size / colour bought is recorded');
  await assert.rejects(submitReview(web, asha, submitReviewInput.parse({orderItemId: item.id, rating: '4', title: '', body: 'Writing a second review here.', displayName: 'Asha'}), [], ctx), ConflictError);
  assert.equal((await approvedReviews(web, item.product_id)).length, 0, 'pending reviews are not public');
  await moderateReview(admin, root, {reviewId: r.id ?? r.reviewId, decision: 'approved', note: null, expectedStatus: 'pending'}, ctx);
  const pub = await approvedReviews(web, item.product_id);
  assert.equal(pub.length, 1); assert.equal(pub[0].variant, row.variant_label);
  assert.equal((await customerReviewState(web, asha)).reviews[0].status, 'approved', 'the customer sees their review status');
});

test('delivery options: standard / express (with description) / store pickup at a branch; the choice is quoted from the server', async () => {
  const ship = settingsShipping(() => web);
  const lines = [{productId: v1.product_id, variantId: v1.id, qty: 1, unitPaise: v1.price_paise, lineTotalPaise: v1.price_paise}];
  const qd = await ship.quote({lines, subtotalPaise: v1.price_paise, shipTo: {...SHIP_TO, deliveryRateId: rates.pickup.id}});
  assert.equal(qd.pickup, true); assert.match(qd.label, /Store pickup \(Chennai Store 1\)/); assert.equal(qd.amountPaise, 0);
  assert.deepEqual(qd.options.map(o => o.label).slice(0, 3).sort(), ['Express', 'Standard', 'Store pickup (Chennai Store 1)'].sort());
  assert.equal(qd.options.find(o => o.rateId === rates.express.id).description, 'Dispatched the same day before 2 pm');
  const std = await ship.quote({lines, subtotalPaise: v1.price_paise, shipTo: {...SHIP_TO, deliveryRateId: null}});
  assert.equal(std.rateId, rates.standard.id, 'first option by default'); assert.ok(!std.pickup);
});
