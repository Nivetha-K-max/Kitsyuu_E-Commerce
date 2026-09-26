/* Integration tests for order administration, against the LOCAL test database only (with database/test/order-fixtures).
   Services run as the real kitsyuu_admin role; setup uses the owner connection. */
import test from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import {createDb, recordAudit, sql} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, orderListQuery, updateOrderStatusInput} from '@kitsyuu/contracts';
import {getOrder, listOrders, updateOrderStatus} from '@kitsyuu/core';
import {createOrderFixtures} from '../../../database/test/order-fixtures.mjs';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const ctx = {ip: '127.0.0.1', userAgent: 'orders.test', requestId: 'test'};
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});   // owner connection for assertions (parameterized)
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const n = async text => (await q(text))[0].n;
const L = input => orderListQuery.parse(input);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const r = await acceptStaffInvite(db, {token, password: 'orders test passphrase', fullName: role}, ctx);
  return validateStaffSession(db, r.token);
}

let F, sales, support, accountant, inventory, snapshot, historyBase;
const amounts = () => q(`select o.order_number, o.subtotal_paise, o.total_paise, (select json_agg(json_build_array(i.sku, i.unit_price_paise, i.qty, i.line_total_paise) order by i.sku) from order_items i where i.order_id = o.id) lines from orders o order by o.order_number`);
const ledgerAgrees = async () => (await n(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`)) === 0;
const statusOf = async num => (await q(`select status from orders where order_number = $1`, [num]))[0].status;
const input = (num, toStatus, expectedStatus, note = '') => updateOrderStatusInput.parse({orderId: F.ids[num], toStatus, expectedStatus, note});

test('fixtures: 8 orders for 2 customers; stock and ledger agree (1100 − 11 units taken)', async () => {
  assert.equal(await n(`select count(*)::int n from orders`), 0);
  F = await createOrderFixtures(KITSYUU_DB_URL);
  assert.deepEqual([F.orders, F.customers, F.unitsHeld], [8, 2, 11]);
  assert.equal(await n(`select sum(stock_qty)::int n from product_variants`), 1089);
  assert.ok(await ledgerAgrees());
  sales = await staff('ord.sales@test.local', 'sales');              // orders.read + orders.update_status + customers.read
  support = await staff('ord.support@test.local', 'support');        // orders.read + customers.read (no update, no billing)
  accountant = await staff('ord.accounts@test.local', 'accountant'); // orders.read + billing.read (no update)
  inventory = await staff('ord.inventory@test.local', 'inventory_manager'); // no orders.read
  snapshot = await amounts();
  historyBase = await n(`select count(*)::int n from order_status_history`);
});

test('order list: newest first, filters, search and date range', async () => {
  const all = (await listOrders(db, support, L({}))).rows;
  assert.equal(all.length, 8);
  assert.equal(all[0].order_number, 'KTS-TEST-0007', 'newest first');
  assert.deepEqual((await listOrders(db, support, L({status: 'open'}))).rows.map(r => r.order_number).sort(), ['KTS-TEST-0001', 'KTS-TEST-0002', 'KTS-TEST-0003', 'KTS-TEST-0004', 'KTS-TEST-0008']);
  assert.deepEqual((await listOrders(db, support, L({status: 'delivered'}))).rows.map(r => r.order_number), ['KTS-TEST-0005']);
  assert.deepEqual((await listOrders(db, support, L({payment: 'failed'}))).rows.map(r => r.order_number), ['KTS-TEST-0007']);
  assert.equal((await listOrders(db, support, L({q: 'KTS-TEST-0004'}))).rows.length, 1);
  assert.equal((await listOrders(db, support, L({q: 'ravi.fixture'}))).rows.length, 3, 'by customer email');
  assert.equal((await listOrders(db, support, L({q: 'Asha'}))).rows.length, 5, 'by contact name');
  const sku = (await q(`select sku from order_items where order_id = $1`, [F.ids['KTS-TEST-0004']]))[0].sku;
  assert.deepEqual((await listOrders(db, support, L({q: sku}))).rows.map(r => r.order_number), ['KTS-TEST-0004'], 'by SKU');
  assert.deepEqual((await listOrders(db, support, L({q: F.ids['KTS-TEST-0003']}))).rows.map(r => r.order_number), ['KTS-TEST-0003'], 'by order id');
  assert.deepEqual((await listOrders(db, support, L({from: '2026-09-20', to: '2026-09-21'}))).rows.map(r => r.order_number).sort(), ['KTS-TEST-0002', 'KTS-TEST-0003'], 'IST date range, inclusive');
  assert.equal((await listOrders(db, support, L({q: 'nothing-matches-this'}))).rows.length, 0);
  assert.equal(orderListQuery.safeParse({from: '20-09-2026'}).success, false, 'invalid dates rejected');
  const t4 = all.find(r => r.order_number === 'KTS-TEST-0004');
  assert.deepEqual([t4.units, t4.lines], [3, 1]);
});

test('order detail: lines at the price paid, totals, history, customer and billing by permission', async () => {
  const d = await getOrder(db, accountant, F.ids['KTS-TEST-0002']);
  assert.equal(d.items.length, 2);
  assert.ok(d.integrity.linesMatchUnitPrices && d.integrity.linesMatchSubtotal);
  assert.equal(d.order.subtotalPaise, d.items.reduce((s, i) => s + i.line_total_paise, 0));
  assert.deepEqual(d.history.map(h => h.to_status), ['pending_payment', 'paid']);
  assert.equal(d.contact.email, 'asha.fixture@test.local');
  assert.equal(d.shipping.city, 'Coimbatore');
  assert.equal(d.billing.payments[0].status, 'captured');
  assert.match(d.billing.invoices[0].invoice_number, /^KTS\/26-27\/\d{5}$/);
  assert.equal(d.customer.email, 'asha.fixture@test.local', 'accountant holds customers.read (seeded role)');
  assert.deepEqual(d.allowedTransitions, [], 'accountant cannot change status');
  // No seeded role has orders.read without customers.read, so a custom role (data, as designed) proves the gate.
  const r = (await q(`insert into roles (code, name) values ('orders_only', 'Orders only') returning id`))[0];
  await q(`insert into role_permissions (role_id, permission_code) values ($1, 'orders.read')`, [r.id]);
  const token = await owner.transaction().execute(async tx => {
    const s = await tx.insertInto('staff_users').values({email: 'ord.only@test.local', status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const ordersOnly = await validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'orders test passphrase', fullName: 'x'}, ctx)).token);
  const o = await getOrder(db, ordersOnly, F.ids['KTS-TEST-0002']);
  assert.deepEqual([o.customer, o.billing, o.stock, o.allowedTransitions], [undefined, undefined, undefined, []], 'orders.read alone: no account, billing or stock details, no status change');
  assert.equal(o.contact.email, 'asha.fixture@test.local', 'order contact is part of the order itself');
  const s = await getOrder(db, sales, F.ids['KTS-TEST-0002']);
  assert.equal(s.billing, undefined, 'sales lacks billing.read: no payments/invoices');
  assert.equal(s.customer.email, 'asha.fixture@test.local');
  assert.deepEqual(s.allowedTransitions, ['processing']);
  assert.deepEqual((await getOrder(db, sales, F.ids['KTS-TEST-0005'])).allowedTransitions, [], 'delivered is final');
  await assert.rejects(getOrder(db, sales, '00000000-0000-4000-8000-000000000000'), NotFoundError);
});

test('permission denial: no orders.read → no list/detail; no orders.update_status → no status change', async () => {
  await assert.rejects(listOrders(db, inventory, L({})), ForbiddenError);
  await assert.rejects(getOrder(db, inventory, F.ids['KTS-TEST-0002']), ForbiddenError);
  const audits = await n(`select count(*)::int n from audit_logs where action = 'order.status_update'`);
  await assert.rejects(updateOrderStatus(db, support, input('KTS-TEST-0002', 'processing', 'paid'), ctx), ForbiddenError);
  await assert.rejects(updateOrderStatus(db, accountant, input('KTS-TEST-0002', 'processing', 'paid'), ctx), ForbiddenError);
  assert.equal(await statusOf('KTS-TEST-0002'), 'paid');
  assert.equal(await n(`select count(*)::int n from audit_logs where action = 'order.status_update'`), audits);
});

test('authorized transition: status, history row and audit (staff, before/after, history id) in one transaction', async () => {
  const r = await updateOrderStatus(db, sales, input('KTS-TEST-0002', 'processing', 'paid', 'Packing today'), ctx);
  assert.deepEqual([r.from, r.to, r.released], ['paid', 'processing', []]);
  assert.equal(await statusOf('KTS-TEST-0002'), 'processing');
  const [a] = await q(`select * from audit_logs where action = 'order.status_update' order by id desc limit 1`);
  assert.deepEqual([a.staff_id, a.entity_type, a.entity_id, a.before_data, a.after_data], [sales.staffId, 'orders', F.ids['KTS-TEST-0002'], {status: 'paid'}, {status: 'processing'}]);
  assert.equal(Number(a.metadata.history_id), r.historyId);
  const d = await getOrder(db, sales, F.ids['KTS-TEST-0002']);
  const last = d.history.at(-1);
  assert.deepEqual([last.from_status, last.to_status, last.note, last.staff_email], ['paid', 'processing', 'Packing today', 'ord.sales@test.local']);
  await updateOrderStatus(db, sales, input('KTS-TEST-0002', 'shipped', 'processing'), ctx);
  await updateOrderStatus(db, sales, input('KTS-TEST-0002', 'delivered', 'shipped'), ctx);
  assert.deepEqual((await getOrder(db, sales, F.ids['KTS-TEST-0002'])).history.map(h => h.to_status), ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'], 'history preserved in order');
});

test('invalid transitions are refused by the contract AND by the service (even if the contract is bypassed)', async () => {
  for (const [from, to] of [['paid', 'delivered'], ['pending_payment', 'paid'], ['paid', 'cancelled'], ['delivered', 'processing'], ['cancelled', 'pending_payment'], ['shipped', 'processing'], ['paid', 'refunded']])
    assert.equal(updateOrderStatusInput.safeParse({orderId: F.ids['KTS-TEST-0003'], toStatus: to, expectedStatus: from, note: 'x'}).success, false, `${from} → ${to}`);
  const raw = (num, toStatus, expectedStatus) => ({orderId: F.ids[num], toStatus, expectedStatus, note: 'bypass'});
  await assert.rejects(updateOrderStatus(db, sales, raw('KTS-TEST-0003', 'delivered', 'processing'), ctx), DomainError);
  await assert.rejects(updateOrderStatus(db, sales, raw('KTS-TEST-0001', 'paid', 'pending_payment'), ctx), DomainError, 'staff can never mark an order paid');
  await assert.rejects(updateOrderStatus(db, sales, raw('KTS-TEST-0005', 'processing', 'delivered'), ctx), DomainError, 'delivered is final');
  assert.equal(await statusOf('KTS-TEST-0003'), 'processing');
});

test('stale change is refused and writes nothing', async () => {
  const [h, a] = [await n(`select count(*)::int n from order_status_history`), await n(`select count(*)::int n from audit_logs`)];
  await assert.rejects(updateOrderStatus(db, sales, input('KTS-TEST-0002', 'processing', 'paid'), ctx), ConflictError, 'KTS-TEST-0002 is already delivered');
  assert.deepEqual([await n(`select count(*)::int n from order_status_history`), await n(`select count(*)::int n from audit_logs`)], [h, a]);
});

test('concurrent updates: two simultaneous changes from the same state → exactly one wins', async () => {
  const results = await Promise.allSettled([
    updateOrderStatus(db, sales, input('KTS-TEST-0003', 'shipped', 'processing', 'first'), ctx),
    updateOrderStatus(db, sales, input('KTS-TEST-0003', 'shipped', 'processing', 'second'), ctx),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const lost = results.find(r => r.status === 'rejected');
  assert.ok(lost.reason instanceof ConflictError, String(lost.reason));
  assert.equal(await n(`select count(*)::int n from order_status_history h join orders o on o.id = h.order_id where o.order_number = 'KTS-TEST-0003' and h.to_status = 'shipped'`), 1);
});

test('cancelling an unpaid order needs a reason, returns exactly the stock it took, and is final', async () => {
  const v = (await q(`select variant_id from order_items where order_id = $1`, [F.ids['KTS-TEST-0001']]))[0].variant_id;
  assert.equal((await q(`select stock_qty from product_variants where id = $1`, [v]))[0].stock_qty, 8);
  assert.equal(updateOrderStatusInput.safeParse({orderId: F.ids['KTS-TEST-0001'], toStatus: 'cancelled', expectedStatus: 'pending_payment', note: ''}).success, false, 'reason required');
  await assert.rejects(updateOrderStatus(db, sales, {orderId: F.ids['KTS-TEST-0001'], toStatus: 'cancelled', expectedStatus: 'pending_payment', note: null}, ctx), DomainError);
  const r = await updateOrderStatus(db, sales, input('KTS-TEST-0001', 'cancelled', 'pending_payment', 'Customer asked to cancel'), ctx);
  assert.deepEqual(r.released, [{variantId: v, qty: 2}]);
  assert.equal((await q(`select stock_qty from product_variants where id = $1`, [v]))[0].stock_qty, 10);
  const [m] = await q(`select delta, reason, staff_id, balance_after from inventory_movements where order_id = $1 order by id desc limit 1`, [F.ids['KTS-TEST-0001']]);
  assert.deepEqual([m.delta, m.reason, m.staff_id, m.balance_after], [2, 'cancel', sales.staffId, 10]);
  const [a] = await q(`select metadata from audit_logs where action = 'order.status_update' and entity_id = $1 order by id desc limit 1`, [F.ids['KTS-TEST-0001']]);
  assert.deepEqual(a.metadata.stock_released, [{variantId: v, qty: 2}]);
  await assert.rejects(updateOrderStatus(db, sales, {orderId: F.ids['KTS-TEST-0001'], toStatus: 'cancelled', expectedStatus: 'cancelled', note: 'again'}, ctx), DomainError, 'cancelled is final');
  const released = await updateOrderStatus(db, sales, input('KTS-TEST-0007', 'cancelled', 'payment_failed', 'Payment never completed'), ctx);
  assert.equal(released.released[0].qty, 1, 'a failed-payment order returns its held unit');
});

test('an order with an authorised or captured payment cannot be cancelled here (needs the refund flow)', async () => {
  const [h, m] = [await n(`select count(*)::int n from order_status_history`), await n(`select count(*)::int n from inventory_movements`)];
  await assert.rejects(updateOrderStatus(db, sales, input('KTS-TEST-0008', 'cancelled', 'pending_payment', 'try'), ctx), ConflictError);
  assert.equal(await statusOf('KTS-TEST-0008'), 'pending_payment');
  assert.deepEqual([await n(`select count(*)::int n from order_status_history`), await n(`select count(*)::int n from inventory_movements`)], [h, m]);
});

test('amounts and lines were never altered; stock and ledger still agree; audit counts match successful changes only', async () => {
  assert.deepEqual(await amounts(), snapshot);
  assert.ok(await ledgerAgrees());
  assert.equal(await n(`select sum(stock_qty)::int n from product_variants`), 1089 + 2 + 1);
  const successes = (await n(`select count(*)::int n from order_status_history`)) - historyBase;
  assert.equal(successes, 6, '0002 ×3, 0003 ×1, 0001 cancel, 0007 cancel');
  assert.equal(await n(`select count(*)::int n from audit_logs where action = 'order.status_update'`), successes);
  assert.equal(await n(`select count(*)::int n from orders`), 8, 'no orders created or deleted');
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
