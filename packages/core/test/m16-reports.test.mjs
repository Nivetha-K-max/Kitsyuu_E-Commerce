/* M16 reports: figures only from recorded data (sales = paid → delivered orders; cancelled / unpaid excluded), business
   dates in IST, permissions per report (purchasing spend needs costs.read), CSV export formula-safe and audited.
   LOCAL test database only. Adds 2 customers and 4 fixture orders (no stock moved; run-e2e.mjs expects them). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {DomainError, ForbiddenError} from '@kitsyuu/contracts';
import {customerReport, exportReport, inventoryReport, productionReport, productReport, purchasingReport, salesReport} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm16.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm16 test passphrase', fullName: role}, ctx)).token);
}
const R = {from: '2026-09-01', to: '2026-09-30'};

let root, manager, accountant, support, P;

test('fixtures: paid, delivered, cancelled and unpaid orders on known IST dates', async () => {
  root = await staff('m16.root@test.local', 'super_admin');
  manager = await staff('m16.manager@test.local', 'manager');          // reports.read, customers.read, procurement.read — no costs.read
  accountant = await staff('m16.accounts@test.local', 'accountant');   // reports.read, customers.read, procurement.read, costs.read
  globalThis.INV = await staff('m16.inventory@test.local', 'inventory_manager');   // reports.read, no customers.read
  support = await staff('m16.support@test.local', 'support');          // no reports.read
  P = (await q(`select id, sku, name from products order by id limit 2`));
  const [c1] = await q(`insert into customers (email, full_name, status, created_at) values ('one.m16@test.local', 'One', 'active', '2026-08-20') returning id`);
  const [c2] = await q(`insert into customers (email, full_name, status, created_at) values ('two.m16@test.local', 'Two', 'active', '2026-09-05') returning id`);
  const order = async (n, cid, status, at, lines) => {
    const total = lines.reduce((s, [, qty, unit]) => s + qty * unit, 0);
    const [o] = await q(`insert into orders (order_number, customer_id, status, subtotal_paise, total_paise, created_at) values ($1, $2, $3, $4, $4, $5) returning id`, [n, cid, status, total, at]);
    for (const [p, qty, unit] of lines) await q(`insert into order_items (order_id, product_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, $2, $3, $4, 'M', $5, $6, $7)`, [o.id, p.id, p.sku, p.name, unit, qty, qty * unit]);
  };
  // 2026-09-09 23:30 IST is 18:00 UTC on the 9th: counted on the 9th. 2026-09-30 20:00 UTC is 1 October in IST: outside.
  await order('KTS-M16-1', c1.id, 'delivered', '2026-09-09T18:00:00Z', [[P[0], 2, 299900], [P[1], 1, 149900]]);
  await order('KTS-M16-2', c1.id, 'paid', '2026-09-12T06:00:00Z', [[P[0], 1, 299900]]);
  await order('KTS-M16-3', c2.id, 'cancelled', '2026-09-12T07:00:00Z', [[P[1], 5, 149900]]);
  await order('KTS-M16-4', c2.id, 'shipped', '2026-09-30T20:00:00Z', [[P[1], 1, 149900]]);
});

test('sales and best sellers: only sold orders, IST business days, totals and average', async () => {
  await assert.rejects(salesReport(db, support, R), ForbiddenError);
  await assert.rejects(salesReport(db, manager, {from: '2026-09-30', to: '2026-09-01'}), DomainError);
  const s = await salesReport(db, manager, R);
  assert.deepEqual(s.rows.map(x => [x.day, x.orders, x.units, x.revenue]), [['2026-09-09', 1, 3, 749700], ['2026-09-12', 1, 1, 299900]]);
  assert.deepEqual(s.totals, {orders: 2, units: 4, revenue: 1049600, averageOrderPaise: 524800});
  const p = await productReport(db, manager, R);
  assert.deepEqual(p.rows.map(x => [x.sku, x.units, x.revenue]), [[P[0].sku, 3, 899700], [P[1].sku, 1, 149900]]);
  assert.equal(p.byCategory.reduce((n, c) => n + c.revenue, 0), 1049600);
});

test('customers, stock, purchasing, production: each gated by its own permission; spend only with costs.read', async () => {
  assert.deepEqual(await customerReport(db, manager, R), {new_customers: 1, buyers: 1, returning_buyers: 1});
  const inv = await inventoryReport(db, manager, R);
  assert.equal(inv.stock.reduce((n, x) => n + x.units, 0), 1100);
  await assert.rejects(customerReport(db, globalThis.INV, R), ForbiddenError, 'customer figures need customers.read');
  assert.equal((await purchasingReport(db, accountant, R)).costs, true, 'accountants see spend');
  const pur = await purchasingReport(db, manager, R);
  assert.deepEqual([pur.costs, pur.rows], [false, []]);
  assert.equal((await purchasingReport(db, root, R)).costs, true);
  assert.deepEqual((await productionReport(db, root, R)).totals, {passed: 0, rejected: 0, passRate: null});
});

test('CSV export: rupees, formula-safe cells, audited; refused without permission', async () => {
  await q(`update order_items set name = '=HYPERLINK("x")' where sku = $1 and order_id = (select id from orders where order_number = 'KTS-M16-2')`, [P[0].sku]);
  const e = await exportReport(db, manager, 'products', R, ctx);
  const lines = e.csv.trim().split('\r\n');
  assert.equal(lines[0], 'sku,name,category,units,revenue_inr');
  assert.ok(lines.some(l => l.includes(`"'=HYPERLINK(""x"")"`)), 'formula neutralised');
  assert.ok(lines.some(l => l.endsWith(',1,2999.00')));
  const sales = (await exportReport(db, manager, 'sales', R, ctx)).csv;
  assert.match(sales, /2026-09-09,1,3,7497\.00/);
  await assert.rejects(exportReport(db, support, 'sales', R, ctx), ForbiddenError);
  assert.deepEqual((await q(`select entity_id, metadata->>'rows' rows from audit_logs where action = 'report.export' order by id`)), [{entity_id: 'products', rows: '3'}, {entity_id: 'sales', rows: '2'}]);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
