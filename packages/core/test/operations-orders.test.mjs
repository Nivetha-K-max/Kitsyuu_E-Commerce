/* Client change request: purchase + production + orders. One vendor with several materials on ONE purchase order; a
   production order's shortfall raised as one PO (items without a shortfall left out) and its procurement status through
   receiving; order views (active / draft / abandoned by the configurable delay); an invoice built from the order's data;
   an order edit to a sold-out size refused with the reason. LOCAL test database only. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError, orderEditInput, orderListQuery, placeOrderInput, purchaseOrderWithLinesInput, settingUpdateInput} from '@kitsyuu/contracts';
import {
  addCartLine, adjustMaterialStock, createInvoiceForOrder, createProductionOrder, createPurchaseOrderWithLines, editOrder, getCustomerCart, getInvoice,
  getPurchaseOrder, listOrders, placeOrder, preparePayment, productionMaterialNeeds, raisePurchaseOrderForProduction, receiveGoods, removeCartLine,
  saveCustomerAddress, saveMaterial, saveVendor, setProductionInput, setPurchaseOrderStatus, settingsShipping, submitPaymentResult, testPaymentProvider,
  updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'operations-orders.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'operations passphrase', fullName: role}, ctx)).token);
}
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const set = (actor, key, value) => updateSetting(admin, actor, settingUpdateInput.parse({key, value}), ctx);
const orderByNumber = n => owner.selectFrom('orders').selectAll().where('order_number', '=', n).executeTakeFirstOrThrow();

let root, support, prod;
const customers = [];
before(async () => {
  root = await staff('ops.root@test.local', 'super_admin');
  support = await staff('ops.support@test.local', 'support');
  // One customer per order: a newer checkout of the same cart replaces an older unpaid order.
  for (const n of [1, 2, 3, 4]) {
    const email = `ops.cust${n}@test.local`;
    const c = P((await owner.insertInto('customers').values({email, full_name: 'Ops', email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id, email);
    c.addr = await saveCustomerAddress(web, c, {fullName: 'Ops', phone: '9876543210', line1: '1 Test Road', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true}, ctx);
    customers.push(c);
  }
  [prod] = await owner.selectFrom('products').select(['id']).where('status', '=', 'active').orderBy('id').limit(1).execute();
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

async function order(cust, size, qty = 1) {
  for (const l of (await getCustomerCart(web, cust)).lines) await removeCartLine(web, cust, l);
  await addCartLine(web, cust, {productId: prod.id, size, qty});
  const cart = await getCustomerCart(web, cust);
  const placed = await placeOrder(web, cust, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: cust.addr, expectedTotalPaise: String(cart.totals.totalPaise)}), ctx);
  return orderByNumber(placed.orderNumber);
}
async function payOrder(cust, orderNumber) {
  const start = await preparePayment(web, pay, cust, orderNumber);
  const o = await orderByNumber(orderNumber);
  return submitPaymentResult(web, pay, cust, {orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, o.currency, 'success')}, ctx);
}

// ---------------------------------------------------------------- purchase orders
test('one vendor + several materials = ONE purchase order with its lines, prices and total; permissions; audited', async () => {
  const v = await saveVendor(admin, root, {name: 'ABC Textiles', contact: 'Ravi', email: 'orders@abc.test', phone: '9876500000', gstin: null, address: 'Tiruppur', notes: null}, ctx);
  const mats = [];
  for (const [code, name, unit] of [['CT-FAB', 'Cotton Fabric', 'm'], ['ZIP-BLK', 'Black Zipper', 'pcs'], ['BTN-MTL', 'Metal Button', 'pcs'], ['PKG', 'Packaging Material', 'pcs']])
    mats.push(await saveMaterial(admin, root, {code, name, unit, reorderLevel: null, notes: null}, ctx));
  const form = {vendorId: v.id, expectedOn: '2026-10-15', notes: 'Deliver to the Chennai warehouse',
    materialIds: mats.map(m => m.id), qtys: ['50', '100', '500', '200'], costs: ['180', '12.50', '1.2', '']};
  const input = purchaseOrderWithLinesInput.parse(form);
  assert.equal(input.lines.length, 4);
  await assert.rejects(createPurchaseOrderWithLines(admin, support, input, ctx), ForbiddenError);
  const r = await createPurchaseOrderWithLines(admin, root, input, ctx);
  assert.equal(r.lines, 4);
  const po = await getPurchaseOrder(admin, root, r.id);
  assert.deepEqual(po.lines.map(l => [l.name, l.ordered, l.unitCostPaise]), [['Cotton Fabric', 50, 18000], ['Black Zipper', 100, 1250], ['Metal Button', 500, 120], ['Packaging Material', 200, null]]);
  assert.equal(po.totalPaise, 50 * 18000 + 100 * 1250 + 500 * 120, 'line totals add up (a line without a price counts as 0)');
  const e = po.order.expected_on;
  assert.deepEqual([po.order.vendor, po.order.vendor_email, po.order.status, `${e.getFullYear()}-${e.getMonth() + 1}-${e.getDate()}`], ['ABC Textiles', 'orders@abc.test', 'draft', '2026-10-15']);
  assert.throws(() => purchaseOrderWithLinesInput.parse({...form, qtys: ['', '', '', '']}), /at least one product or material/);
  assert.throws(() => purchaseOrderWithLinesInput.parse({...form, qtys: ['-1', '', '', '']}), /above 0/);
  await q(`update materials set is_active = false where id = $1`, [mats[3].id]);
  await assert.rejects(createPurchaseOrderWithLines(admin, root, input, ctx), /Inactive material: Packaging Material/);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'purchase_order.create' and entity_id = $1`, [r.id]))[0].n, 1);
});

// ---------------------------------------------------------------- production → purchase order for the shortfall
test('production shortfall: one PO for the short items only (none for what stock covers); procurement status through receiving', async () => {
  const v = await saveVendor(admin, root, {name: 'Shortfall Supplies', contact: null, email: null, phone: null, gstin: null, address: null, notes: null}, ctx);
  const plan = [['PR-FAB', 'Fabric', 'm', 60, 100], ['PR-ZIP', 'Zippers', 'pcs', 50, 200], ['PR-BTN', 'Buttons', 'pcs', 800, 800]];
  const [size] = await owner.selectFrom('product_variants').select('id').where('product_id', '=', prod.id).orderBy('sort_order').limit(1).execute();
  const prodOrder = await createProductionOrder(admin, root, {variantId: size.id, qty: 10, dueOn: null, notes: null}, ctx);
  const ids = {};
  for (const [code, name, unit, stock, planned] of plan) {
    const m = await saveMaterial(admin, root, {code, name, unit, reorderLevel: null, notes: null}, ctx);
    ids[name] = m.id;
    await adjustMaterialStock(admin, root, {materialId: m.id, delta: stock, reason: 'correction', note: 'count'}, ctx);
    await setProductionInput(admin, root, {productionOrderId: prodOrder.id, materialId: m.id, qtyPlanned: planned}, ctx);
  }
  let needs = await productionMaterialNeeds(admin, root, prodOrder.id);
  assert.deepEqual(needs.needs.map(n => [n.name, n.shortfall]), [['Buttons', 0], ['Fabric', 40], ['Zippers', 150]]);
  assert.equal(needs.procurement, 'not_ordered');
  // "Create PO for shortfall": the page sends only the short items.
  const lines = needs.needs.filter(n => n.shortfall > 0).map(n => ({materialId: n.materialId, qty: n.shortfall}));
  const raised = await raisePurchaseOrderForProduction(admin, root, {productionOrderId: prodOrder.id, vendorId: v.id, lines, notes: null}, ctx);
  const po = await getPurchaseOrder(admin, root, raised.id);
  assert.deepEqual(po.lines.map(l => [l.name, l.ordered]).sort(), [['Fabric', 40], ['Zippers', 150]], 'Buttons are not ordered');
  needs = await productionMaterialNeeds(admin, root, prodOrder.id);
  assert.equal(needs.procurement, 'ordered');
  assert.deepEqual(needs.linked.map(l => [l.po_number, l.ordered, l.received, l.remaining]), [[raised.poNumber, 190, 0, 190]]);
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: raised.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx);
  const fab = po.lines.find(l => l.name === 'Fabric'), zip = po.lines.find(l => l.name === 'Zippers');
  await receiveGoods(admin, root, {purchaseOrderId: raised.id, lines: [{lineId: fab.id, qty: 40, expectedReceived: 0}], note: null}, ctx);
  needs = await productionMaterialNeeds(admin, root, prodOrder.id);
  assert.deepEqual(needs.linked.map(l => [l.status, l.received, l.remaining]), [['partially_received', 40, 150]]);
  assert.equal(needs.procurement, 'ordered', 'still ordered: the rest is on the way');
  await receiveGoods(admin, root, {purchaseOrderId: raised.id, lines: [{lineId: zip.id, qty: 150, expectedReceived: 0}], note: null}, ctx);
  needs = await productionMaterialNeeds(admin, root, prodOrder.id);
  assert.equal(needs.procurement, 'received');
  assert.deepEqual(needs.needs.map(n => [n.name, n.stock, n.shortfall]), [['Buttons', 800, 0], ['Fabric', 100, 0], ['Zippers', 200, 0]]);
});

// ---------------------------------------------------------------- order views, invoice, sold-out edit
test('orders: Active / Draft / Abandoned views (delay from Settings); invoice from the order data; a sold-out size is refused', async () => {
  const sizes = await owner.selectFrom('product_variants').select(['id', 'size']).where('product_id', '=', prod.id).where('is_active', '=', true).orderBy('sort_order').execute();
  const draft = await order(customers[0], sizes[0].size);
  const old = await order(customers[1], sizes[0].size);
  await pool.query(`begin; set local session_replication_role = replica; update orders set created_at = now() - interval '25 hours' where id = '${old.id}'; commit;`);
  const paid = await order(customers[2], sizes[0].size);
  await payOrder(customers[2], paid.order_number);
  const view = async v => (await listOrders(admin, root, orderListQuery.parse({view: v}))).rows.map(r => r.order_number);
  assert.deepEqual(await view('draft'), [draft.order_number], 'placed, unpaid, newer than 24 h');
  assert.deepEqual(await view('abandoned'), [old.order_number], 'unpaid after the 24 h default');
  // 2026-10-06: Active = orders in progress: paid ones and those placed and still inside the delay; never the abandoned ones.
  assert.deepEqual((await view('active')).sort(), [paid.order_number, draft.order_number].sort());
  assert.equal((await view('all')).length, 3);
  await set(root, 'checkout.abandoned_after_hours', '48');
  assert.deepEqual((await view('draft')).sort(), [draft.order_number, old.order_number].sort(), 'the delay is the Settings value');
  assert.deepEqual(await view('abandoned'), []);

  // Invoice: made from the order (numbering and GST split are the Finance module's), with its payment facts.
  const inv = await createInvoiceForOrder(admin, root, {orderId: paid.id}, ctx);
  const g = await getInvoice(admin, root, inv.id);
  assert.deepEqual([g.invoice.total_paise, g.invoice.payment_method, g.invoice.payment_status, g.invoice.order_status], [paid.total_paise, 'online', 'paid', 'paid']);
  assert.equal(g.items.length, 1);

  // Order edit: a size with no stock is refused with the reason; nothing changes.
  const other = await (async () => { const t = await createOrderWithoutInvoice(); return t; })();
  const target = sizes[1];
  const left = (await q(`select stock_qty from product_variants where id = $1`, [target.id]))[0].stock_qty;
  if (left > 0) await q(`select public.adjust_stock($1::uuid, $2::int, 'correction', null, 'test', null)`, [target.id, -left]);
  const [item] = await q(`select id from order_items where order_id = $1`, [other.id]);
  const shipping = settingsShipping(() => admin);
  await assert.rejects(editOrder(admin, root, orderEditInput.parse({orderId: other.id, expectedTotalPaise: String(other.total_paise), note: 'Size change',
    itemIds: [item.id], variantIds: [target.id], qtys: ['1']}), ctx, {shipping}), new RegExp(`Size ${target.size} is currently unavailable`));
  assert.equal((await q(`select variant_id from order_items where id = $1`, [item.id]))[0].variant_id, sizes[0].id, 'nothing changed');
  if (left > 0) await q(`select public.adjust_stock($1::uuid, $2::int, 'correction', null, 'test', null)`, [target.id, left]);

  async function createOrderWithoutInvoice() { const o = await order(customers[3], sizes[0].size); await payOrder(customers[3], o.order_number); return orderByNumber(o.order_number); }
});
