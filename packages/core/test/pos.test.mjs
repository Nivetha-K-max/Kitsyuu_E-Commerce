/* POS billing (2026-10-02), against the LOCAL test database: cashier sessions, product search (name / SKU / barcode) with
   branch stock, pricing with staff discount limits and tax, cash / UPI / card payments, the order in the existing order
   system (channel retail, POS number, session, cashier), stock from the selected branch only, bills / invoices, customer
   history, voids, returns / exchanges / refunds of POS sales at the branch, permissions, audit, simultaneous sales of the
   last units, session close with expected cash and variance, and the POS report. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, settingUpdateInput} from '@kitsyuu/contracts';
import {
  adjustLocationStock, closePosSession, completePosSale, createInvoiceForOrder, createStaffReturn, findPosCustomers, getPosSale, getReturn, listPosSales, listPosSessions,
  onlineLocationId, openPosSession, posContext, posReport, posSessionSummary, quotePosSale, refundReturn, returnAction, saveLocation, searchPosProducts, setProductMinPrice,
  setVariantBarcode, updateReturnItem, updateSetting, voidPosSale,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'pos.test', requestId: 'test'};
const set = (key, value) => updateSetting(admin, root, settingUpdateInput.parse({key, value}), ctx);
const key = () => randomBytes(16).toString('hex');

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'pos test passphrase', fullName: role}, ctx)).token);
}
const variant = async sku => (await q(`select v.id, v.sku, v.size, p.id product_id, p.name, p.price_paise from product_variants v join products p on p.id = v.product_id where v.sku = $1`, [sku]))[0];
const locQty = async (loc, v) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, v]))[0].n;
const onlineQty = async v => (await q(`select stock_qty n from product_variants where id = $1`, [v]))[0].n;
/** A sale for the quoted total (what the cashier showed the customer). */
async function sell(actor, session, lines, payment, extra = {}) {
  const quote = await quotePosSale(admin, actor, {locationId: session.location_id ?? extra.locationId, lines, customerId: extra.customerId ?? null, discount: extra.discount ?? null});
  return completePosSale(admin, actor, {sessionId: session.id, idempotencyKey: extra.key ?? key(), lines, customerId: extra.customerId ?? null, contact: extra.contact ?? null,
    discount: extra.discount ?? null, payment, expectedTotalPaise: extra.expected ?? quote.totals.totalPaise}, ctx);
}

let root, manager, sales, sales2, support, accountant, online, store1, store2, V1, V2, V3, customer;
let s1, s2m, s2;   // sessions: sales @ store1, manager @ store2, sales2 @ store2
before(async () => {
  root = await staff('pos.root@test.local', 'super_admin');
  manager = await staff('pos.manager@test.local', 'manager');
  sales = await staff('pos.sales@test.local', 'sales');
  sales2 = await staff('pos.sales2@test.local', 'sales');
  support = await staff('pos.support@test.local', 'support');
  accountant = await staff('pos.accountant@test.local', 'accountant');
  online = await onlineLocationId(admin);
  store1 = (await saveLocation(admin, root, {code: 'CHN-S1', name: 'Chennai Store 1', kind: 'retail', address: 'T. Nagar, Chennai', active: true}, ctx)).id;
  store2 = (await saveLocation(admin, root, {code: 'CHN-S2', name: 'Chennai Store 2', kind: 'retail', address: 'Anna Nagar, Chennai', active: true}, ctx)).id;
  [V1, V2, V3] = await Promise.all(['KTS-TOP-001-M', 'KTS-BTM-001-L', 'KTS-OUT-001-S'].map(variant));
  for (const v of [V1, V2, V3]) assert.ok(v, 'catalogue seed sizes exist');
  for (const [loc, v, n] of [[store1, V1, 6], [store1, V2, 4], [store2, V1, 3], [store2, V3, 2]])
    await adjustLocationStock(admin, manager, {locationId: loc, variantId: v.id, delta: n, reason: 'restock', note: 'POS test stock', expectedQty: 0}, ctx);
  customer = (await owner.insertInto('customers').values({email: 'pos.meera@test.local', full_name: 'Meera Pos', phone: '9840012345', email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

test('permissions: support has no POS; a cashier (sales) can sell but not void, report or discount', async () => {
  await assert.rejects(posContext(admin, support), ForbiddenError);
  await assert.rejects(openPosSession(admin, support, {locationId: store1, openingCashPaise: 0}, ctx), ForbiddenError);
  const c = await posContext(admin, sales);
  assert.deepEqual(c.can, {sell: true, discount: false, void: false, reports: false, invoice: false});
  assert.deepEqual(c.locations.map(l => l.name).sort(), ['Chennai Store 1', 'Chennai Store 2'], 'branches only, never the online stock');
  assert.equal(c.session, null);
  const a = await posContext(admin, accountant);
  assert.equal(a.can.sell, false); assert.equal(a.can.reports, true);
  await assert.rejects(openPosSession(admin, accountant, {locationId: store1, openingCashPaise: 0}, ctx), ForbiddenError);
});

test('cashier session: open at a branch with opening cash, one open session per cashier, not at the online stock', async () => {
  await assert.rejects(openPosSession(admin, sales, {locationId: online, openingCashPaise: 0}, ctx), /online stock/);
  await assert.rejects(openPosSession(admin, sales, {locationId: store1, openingCashPaise: -5}, ctx), DomainError);
  const r = await openPosSession(admin, sales, {locationId: store1, openingCashPaise: 200000}, ctx);
  assert.match(r.number, /^POSS\/\d{2}-\d{2}\/\d{5}$/);
  await assert.rejects(openPosSession(admin, sales, {locationId: store2, openingCashPaise: 0}, ctx), /already have an open session/);
  s1 = (await posContext(admin, sales)).session;
  assert.equal(s1.location_id, store1);
  s2m = (await openPosSession(admin, manager, {locationId: store2, openingCashPaise: 0}, ctx)) && (await posContext(admin, manager)).session;
  s2 = (await openPosSession(admin, sales2, {locationId: store2, openingCashPaise: 50000}, ctx)) && (await posContext(admin, sales2)).session;
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'pos.session_open'`))[0].n, 3);
});

test('product search: by name, by SKU (exact hit), by barcode; each size shows the stock at THIS branch', async () => {
  const byName = await searchPosProducts(admin, sales, {locationId: store1, q: V1.name.split(' ')[0]});
  assert.ok(byName.products.some(p => p.productId === V1.product_id));
  const bySku = await searchPosProducts(admin, sales, {locationId: store1, q: V1.sku.toLowerCase()});
  assert.equal(bySku.exact?.variantId, V1.id); assert.equal(bySku.exact.stock, 6, 'store 1 stock, not the online stock');
  assert.equal((await searchPosProducts(admin, sales, {locationId: store2, q: V1.sku})).exact.stock, 3, 'store 2 has its own stock');
  await assert.rejects(setVariantBarcode(admin, sales, {variantId: V2.id, barcode: '8901234567890'}, ctx), ForbiddenError);
  await setVariantBarcode(admin, root, {variantId: V2.id, barcode: '8901234567890'}, ctx);
  await assert.rejects(setVariantBarcode(admin, root, {variantId: V1.id, barcode: '8901234567890'}, ctx), /already uses this barcode/);
  const byCode = await searchPosProducts(admin, sales, {locationId: store1, q: '8901234567890'});
  assert.equal(byCode.exact?.variantId, V2.id); assert.equal(byCode.exact.size, V2.size);
  const prefix = await searchPosProducts(admin, sales, {locationId: store1, q: 'KTS-TOP-001'});
  assert.ok(prefix.products[0].variants.length >= 2, 'all sizes (variants) of the product to choose from');
  assert.deepEqual(await searchPosProducts(admin, sales, {locationId: store1, q: '   '}), {exact: null, products: []});
});

test('pricing: line totals, subtotal, tax as configured; branch stock enforced; discounts only with permission and within limits', async () => {
  const quote = await quotePosSale(admin, sales, {locationId: store1, lines: [{variantId: V1.id, qty: 2}, {variantId: V2.id, qty: 1}], discount: null});
  assert.equal(quote.totals.subtotalPaise, quote.lines.reduce((n, l) => n + l.unitPaise * l.qty, 0));
  assert.equal(quote.totals.shippingPaise, 0, 'nothing is delivered at the counter');
  assert.equal(quote.problems.length, 0);
  const over = await quotePosSale(admin, sales, {locationId: store1, lines: [{variantId: V1.id, qty: 7}], discount: null});
  assert.match(over.problems[0], /Only 6 .* in stock at this branch/);
  assert.match((await quotePosSale(admin, sales, {locationId: store1, lines: [{variantId: V3.id, qty: 1}], discount: null})).problems[0], /Only 0/, 'store 1 has no V3');
  // Discount: the cashier role has no orders.discount.
  await assert.rejects(quotePosSale(admin, sales, {locationId: store1, lines: [{variantId: V1.id, qty: 1}], discount: {percent: 5, reason: 'Regular customer'}}), ForbiddenError);
  await assert.rejects(quotePosSale(admin, manager, {locationId: store2, lines: [{variantId: V1.id, qty: 1}], discount: {percent: 5, reason: 'x'}}), /not set up/, 'no maximum set: no discounts');
  await set('discounts.staff_max_percent', '10');
  await assert.rejects(quotePosSale(admin, manager, {locationId: store2, lines: [{variantId: V1.id, qty: 1}], discount: {percent: 15, reason: 'Too much'}}), /above the maximum/);
  await setProductMinPrice(admin, root, {productId: V1.product_id, minPricePaise: V1.price_paise - 100}, ctx);
  await assert.rejects(quotePosSale(admin, manager, {locationId: store2, lines: [{variantId: V1.id, qty: 1}], discount: {percent: 10, reason: 'Festival'}}), /below its minimum price/);
  await setProductMinPrice(admin, root, {productId: V1.product_id, minPricePaise: null}, ctx);
  const d = await quotePosSale(admin, manager, {locationId: store2, lines: [{variantId: V1.id, qty: 1}], discount: {percent: 10, reason: 'Festival'}});
  assert.equal(d.totals.discountPaise, Math.round(d.totals.subtotalPaise * 0.1));
});

test('cash sale at Store 1: order in the order system (retail, POS number, session, cashier), paid, stock from Store 1 only', async () => {
  const [s1a, s2a, on0] = [await locQty(store1, V1.id), await locQty(store2, V1.id), await onlineQty(V1.id)];
  const quote = await quotePosSale(admin, sales, {locationId: store1, lines: [{variantId: V1.id, qty: 2}], discount: null});
  const total = quote.totals.totalPaise;
  const base = {sessionId: s1.id, lines: [{variantId: V1.id, qty: 2}], discount: null, expectedTotalPaise: total, contact: {name: 'Walk-in', phone: null}};
  await assert.rejects(completePosSale(admin, sales, {...base, idempotencyKey: key(), payment: {method: 'cash', tenderedPaise: total - 1}}, ctx), /cash received/);
  await assert.rejects(completePosSale(admin, sales, {...base, idempotencyKey: key(), payment: {method: 'cash', tenderedPaise: total}, expectedTotalPaise: total + 100}, ctx), /total changed/);
  await assert.rejects(completePosSale(admin, manager, {...base, idempotencyKey: key(), payment: {method: 'cash', tenderedPaise: total}}, ctx), /another cashier/);
  const k = key();
  const r = await completePosSale(admin, sales, {...base, idempotencyKey: k, payment: {method: 'cash', tenderedPaise: total + 50000}}, ctx);
  assert.match(r.posNumber, /^POS\/\d{2}-\d{2}\/\d{5}$/);
  assert.equal(r.changePaise, 50000);
  // A double-submitted bill returns the same sale (no second charge, no second stock movement).
  const again = await completePosSale(admin, sales, {...base, idempotencyKey: k, payment: {method: 'cash', tenderedPaise: total + 50000}}, ctx);
  assert.equal(again.orderId, r.orderId); assert.equal(again.replay, true);
  const [o] = await q(`select status, payment_status, payment_method, channel, location_id, customer_id, created_by, pos_number, pos_session_id, total_paise, contact->>'name' name from orders where id = $1`, [r.orderId]);
  assert.deepEqual(o, {status: 'delivered', payment_status: 'paid', payment_method: 'cash', channel: 'retail', location_id: store1, customer_id: null, created_by: sales.staffId,
    pos_number: r.posNumber, pos_session_id: s1.id, total_paise: total, name: 'Walk-in'});
  const [p] = await q(`select provider, method, status, amount_paise, raw->>'change_paise' change from payments where order_id = $1`, [r.orderId]);
  assert.deepEqual(p, {provider: 'pos', method: 'cash', status: 'captured', amount_paise: total, change: '50000'});
  assert.deepEqual([await locQty(store1, V1.id), await locQty(store2, V1.id), await onlineQty(V1.id)], [s1a - 2, s2a, on0], 'Store 1 only; Store 2 and online unchanged');
  assert.equal((await q(`select count(*)::int n from inventory_movements where order_id = $1 and location_id = $2 and reason = 'retail_sale' and delta = -2`, [r.orderId, store1]))[0].n, 1);
  const bill = await getPosSale(admin, sales, r.orderId);
  assert.equal(bill.sale.location_name, 'Chennai Store 1'); assert.equal(bill.sale.cashier_email, 'pos.sales@test.local');
  assert.equal(bill.items[0].sku, V1.sku); assert.equal(bill.pos.changePaise, 50000); assert.equal(bill.canVoid, false, 'a cashier cannot void');
});

test('UPI and card need the transaction reference; a customer can be selected and sees the sale in their history', async () => {
  await assert.rejects(sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'upi', reference: null}), /UPI transaction reference/);
  await assert.rejects(sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'card', reference: '12'}), /card approval/);
  const found = await findPosCustomers(admin, sales, '98400');
  assert.equal(found[0]?.id, customer, 'found by phone');
  assert.equal((await findPosCustomers(admin, sales, 'meera'))[0]?.id, customer, 'found by name');
  const upi = await sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'upi', reference: 'UTR 4021 7788 1234'}, {customerId: customer});
  const card = await sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'card', reference: 'APPR-889911'});
  const pays = await q(`select o.id, p.method, p.raw->>'reference' ref from payments p join orders o on o.id = p.order_id where o.id = any($1) order by p.method`, [[upi.orderId, card.orderId]]);
  assert.deepEqual(pays.map(x => [x.method, x.ref]), [['card', 'APPR-889911'], ['upi', 'UTR 4021 7788 1234']]);
  // Customer history: online and POS orders in one list (the ERP customer page reads orders by customer).
  const hist = await q(`select order_number, channel, pos_number from orders where customer_id = $1`, [customer]);
  assert.deepEqual(hist.map(h => [h.channel, h.pos_number]), [['retail', upi.posNumber]]);
  assert.equal((await q(`select contact->>'email' e from orders where id = $1`, [upi.orderId]))[0].e, 'pos.meera@test.local');
});

test('discounted sale by a manager: staff discount stored with reason and who gave it; audit trail', async () => {
  const r = await sell(manager, s2m, [{variantId: V1.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}, {discount: {percent: 10, reason: 'Festival offer'}});
  const [o] = await q(`select discount_paise, staff_discount_paise, staff_discount_bp, staff_discount_reason, staff_discount_by, location_id from orders where id = $1`, [r.orderId]);
  assert.equal(o.staff_discount_bp, 1000); assert.equal(o.staff_discount_reason, 'Festival offer'); assert.equal(o.staff_discount_by, manager.staffId);
  assert.equal(o.discount_paise, o.staff_discount_paise); assert.equal(o.location_id, store2);
  await assert.rejects(sell(manager, s2m, [{variantId: V1.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}, {discount: {percent: 5, reason: ''}}), /reason/);
  const [a] = await q(`select metadata from audit_logs where action = 'pos.sale' and entity_id = $1`, [r.orderId]);
  assert.equal(a.metadata.discount_reason, 'Festival offer');
});

test('overselling: insufficient branch stock is refused; two tills selling the last units at once — exactly one succeeds', async () => {
  // Store 2 now has V1: 3 − 1 (manager's discounted sale) = 2 left.
  assert.equal(await locQty(store2, V1.id), 2);
  await assert.rejects(sell(sales2, s2, [{variantId: V1.id, qty: 3}], {method: 'cash', tenderedPaise: 10_000_000}), /Only 2 .* in stock/);
  const both = await Promise.allSettled([
    sell(sales2, s2, [{variantId: V1.id, qty: 2}], {method: 'cash', tenderedPaise: 10_000_000}),
    sell(manager, s2m, [{variantId: V1.id, qty: 2}], {method: 'card', reference: 'APPR-RACE-1'}),
  ]);
  assert.deepEqual(both.map(x => x.status).sort(), ['fulfilled', 'rejected']);
  const failed = both.find(x => x.status === 'rejected');
  assert.ok(failed.reason instanceof ConflictError, String(failed.reason));
  assert.equal(await locQty(store2, V1.id), 0, 'never below zero');
  // Many sales at once across the two branches: every one consistent with the ledger.
  const many = await Promise.allSettled([
    sell(sales, s1, [{variantId: V1.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}),
    sell(sales, s1, [{variantId: V1.id, qty: 1}], {method: 'upi', reference: 'UTR-PAR-0001'}),
    sell(sales2, s2, [{variantId: V3.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}),
    sell(manager, s2m, [{variantId: V3.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}),
  ]);
  assert.ok(many.every(x => x.status === 'fulfilled'), JSON.stringify(many.map(x => x.reason?.message)));
  assert.deepEqual([await locQty(store1, V1.id), await locQty(store2, V3.id)], [2, 0]);
  const [{bad}] = await q(`select count(*)::int bad from location_stock s where s.qty <> (select coalesce(sum(m.delta), 0) from inventory_movements m
    where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)`);
  assert.equal(bad, 0, 'every branch stock equals its ledger');
});

test('bill and tax invoice: the POS sale gets a normal invoice (finance.manage), the bill shows it', async () => {
  const [{id}] = await q(`select id from orders where pos_session_id = $1 order by created_at limit 1`, [s1.id]);
  await assert.rejects(createInvoiceForOrder(admin, sales, {orderId: id}, ctx), ForbiddenError);
  const inv = await createInvoiceForOrder(admin, root, {orderId: id}, ctx);
  const bill = await getPosSale(admin, sales, id);
  assert.equal(bill.invoice.invoice_number, inv.number);
  const [i] = await q(`select total_paise, billing_address->>'line1' place from invoices where id = $1`, [inv.id]);
  assert.equal(i.place, 'Chennai Store 1');
  assert.ok((await listPosSales(admin, sales, {sessionId: s1.id})).length >= 4);
});

test('void (manager, open session): stock back to the same branch, payment returned, order cancelled; a cashier cannot void', async () => {
  const r = await sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000});
  const before = await locQty(store1, V2.id);
  await assert.rejects(voidPosSale(admin, sales, {orderId: r.orderId, reason: 'Wrong size rung up'}, ctx), ForbiddenError);
  await assert.rejects(voidPosSale(admin, manager, {orderId: r.orderId, reason: ''}, ctx), /reason/);
  const v = await voidPosSale(admin, manager, {orderId: r.orderId, reason: 'Wrong size rung up'}, ctx);
  assert.equal(v.refundedPaise, r.totalPaise);
  assert.equal(await locQty(store1, V2.id), before + 1);
  const [o] = await q(`select status, payment_status from orders where id = $1`, [r.orderId]);
  assert.deepEqual(o, {status: 'cancelled', payment_status: 'refunded'});
  assert.equal((await q(`select count(*)::int n from inventory_movements where order_id = $1 and reason = 'pos_void' and location_id = $2`, [r.orderId, store1]))[0].n, 1);
  await assert.rejects(voidPosSale(admin, manager, {orderId: r.orderId, reason: 'again'}, ctx), /already voided/);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'pos.void' and entity_id = $1`, [r.orderId]))[0].n, 1);
});

test('returns: a POS sale follows the normal return rules; restock and exchange use the branch; refund recorded on the POS payment', async () => {
  const r = await sell(sales, s1, [{variantId: V1.id, qty: 2}], {method: 'cash', tenderedPaise: 10_000_000});
  const items = await q(`select id from order_items where order_id = $1`, [r.orderId]);
  const input = {orderId: r.orderId, reasonCode: 'size_fit', description: 'Too small', items: [{orderItemId: items[0].id, qty: 1}]};
  await assert.rejects(createStaffReturn(admin, manager, input, ctx), /all sales are final/, 'returns are off by default');
  await set('returns.enabled', 'on'); await set('returns.window_days', '7');
  await assert.rejects(createStaffReturn(admin, accountant, input, ctx), ForbiddenError, 'needs returns.manage');
  await assert.rejects(createStaffReturn(admin, manager, {...input, items: [{orderItemId: items[0].id, qty: 3}]}, ctx), /More units/);
  const ret = await createStaffReturn(admin, manager, input, ctx);
  const step = (id, action, extra = {}) => returnAction(admin, manager, {returnId: id, action, note: null, pickupAt: null, pickupRef: null, refundAmount: null, ...extra}, ctx);
  await step(ret.id, 'approve', {resolution: 'refund'});
  await step(ret.id, 'receive');
  const [b1, on0] = [await locQty(store1, V1.id), await onlineQty(V1.id)];
  const detail = await getReturn(admin, manager, ret.id);
  await updateReturnItem(admin, manager, {returnId: ret.id, returnItemId: detail.items[0].id, restockQty: 1}, ctx);
  assert.deepEqual([await locQty(store1, V1.id), await onlineQty(V1.id)], [b1 + 1, on0], 'back into Store 1, not the online stock');
  await step(ret.id, 'inspect', {inspectionResult: 'ok'});
  const unit = (await q(`select unit_price_paise u from order_items where id = $1`, [items[0].id]))[0].u;
  await refundReturn(admin, root, null, {returnId: ret.id, mode: 'manual', amount: unit, reference: 'CASH-REFUND-001', note: 'Cash returned at the counter'}, ctx);
  const [p] = await q(`select status from payments where order_id = $1 and provider = 'pos'`, [r.orderId]);
  assert.equal(p.status, 'partially_refunded');
  assert.equal((await q(`select payment_status from orders where id = $1`, [r.orderId]))[0].payment_status, 'partially_refunded');
  // Exchange of the other unit for another size: the replacement leaves Store 1.
  const ex = await createStaffReturn(admin, manager, {...input, items: [{orderItemId: items[0].id, qty: 1}]}, ctx);
  await step(ex.id, 'approve', {resolution: 'exchange'}); await step(ex.id, 'receive'); await step(ex.id, 'inspect', {inspectionResult: 'ok'});
  const other = (await q(`select v.id from product_variants v where v.product_id = $1 and v.id <> $2 order by v.sort_order limit 1`, [V1.product_id, V1.id]))[0].id;
  await adjustLocationStock(admin, manager, {locationId: store1, variantId: other, delta: 2, reason: 'restock', note: null, expectedQty: 0}, ctx);
  const exDetail = await getReturn(admin, manager, ex.id);
  await updateReturnItem(admin, manager, {returnId: ex.id, returnItemId: exDetail.items[0].id, exchangeVariantId: other}, ctx);
  const onOther = await onlineQty(other);
  await step(ex.id, 'ship_exchange');
  assert.deepEqual([await locQty(store1, other), await onlineQty(other)], [1, onOther], 'replacement from Store 1');
  const bill = await getPosSale(admin, sales, r.orderId);
  assert.equal(bill.returns.length, 2); assert.equal(bill.canVoid, false);
});

test('close session: expected cash = opening + cash sales − cash voids; a variance needs a note; report by method, cashier and branch', async () => {
  const sum = await posSessionSummary(admin, s1.id);
  const cash = (await q(`select coalesce(sum(p.amount_paise), 0)::int n from payments p join orders o on o.id = p.order_id where o.pos_session_id = $1 and p.method = 'cash'`, [s1.id]))[0].n;
  const voided = (await q(`select coalesce(sum(r.amount_paise), 0)::int n from refunds r join orders o on o.id = r.order_id join payments p on p.id = r.payment_id
    where o.pos_session_id = $1 and r.reference like 'VOID %' and p.method = 'cash'`, [s1.id]))[0].n;
  assert.equal(sum.expectedCashPaise, 200000 + cash - voided);
  assert.equal(sum.voidedTransactions, 1);
  await assert.rejects(closePosSession(admin, sales, {sessionId: s1.id, countedCashPaise: sum.expectedCashPaise - 500, note: null}, ctx), /note/);
  await assert.rejects(closePosSession(admin, sales2, {sessionId: s1.id, countedCashPaise: 0, note: 'x'}, ctx), ForbiddenError);
  const c = await closePosSession(admin, sales, {sessionId: s1.id, countedCashPaise: sum.expectedCashPaise - 500, note: 'Short ₹5 (change)'}, ctx);
  assert.equal(c.variancePaise, -500);
  await assert.rejects(sell(sales, s1, [{variantId: V2.id, qty: 1}], {method: 'cash', tenderedPaise: 10_000_000}), /closed/);
  const [{status, variance_paise}] = await q(`select status, variance_paise from pos_sessions where id = $1`, [s1.id]);
  assert.deepEqual([status, variance_paise], ['closed', -500]);
  // Report (pos.reports): totals, methods, by cashier and branch.
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  await assert.rejects(posReport(admin, sales, {from: today, to: today}), ForbiddenError);
  const rep = await posReport(admin, accountant, {from: today, to: today});
  const [{n}] = await q(`select count(*)::int n from orders where pos_number is not null`);
  assert.equal(rep.transactions, n);
  assert.equal(rep.methods.reduce((x, m) => x + m.count, 0), n);
  assert.deepEqual(rep.byLocation.map(l => l.name).sort(), ['Chennai Store 1', 'Chennai Store 2']);
  assert.ok(rep.byCashier.some(c => c.name === 'pos.sales@test.local'));
  assert.equal(rep.voided, 1); assert.ok(rep.returnRefundsPaise > 0); assert.equal(rep.netPaise, rep.grossPaise - rep.voidRefundsPaise - rep.returnRefundsPaise);
  const stores2 = await posReport(admin, root, {from: today, to: today, locationId: store2});
  assert.deepEqual(stores2.byLocation.map(l => l.name), ['Chennai Store 2']);
  assert.equal((await listPosSessions(admin, sales)).length, 1, 'a cashier sees their own sessions');
  assert.equal((await listPosSessions(admin, manager, {all: true})).length, 3);
  assert.ok((await q(`select count(*)::int n from audit_logs where action in ('pos.session_close', 'pos.sale', 'variant.barcode')`))[0].n > 10);
});
