/* M15 stock counts and stock value. A count snapshots expected stock; posting applies counted − expected to the CURRENT
   stock (movements during the count are kept) through adjust_stock('count_adjust'). Stock value uses only entered unit
   costs (garments) and last purchase prices (materials); costs are invisible to the website role.
   LOCAL test database only. Net stock change is 0 units but three sizes end away from 10 (run-e2e.mjs expects that). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, ForbiddenError, adjustStockInput, openStockCountInput, variantCostInput} from '@kitsyuu/contracts';
import {adjustStock, cancelStockCount, getStockCount, openStockCount, postStockCount, recordCounts, setVariantCost, stockValue} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 1});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm15.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm15 test passphrase', fullName: role}, ctx)).token);
}
const stockOf = async id => (await q(`select stock_qty from product_variants where id = $1`, [id]))[0].stock_qty;

let inventory, accountant, support, A, B, C;

test('count: snapshot, record, movements during the count are kept, only differences posted; one open at a time', async () => {
  inventory = await staff('m15.inventory@test.local', 'inventory_manager');
  accountant = await staff('m15.accounts@test.local', 'accountant');
  support = await staff('m15.support@test.local', 'support');
  [A, B, C] = (await q(`select v.id from product_variants v order by v.sku limit 3`)).map(r => r.id);
  await assert.rejects(openStockCount(db, support, openStockCountInput.parse({}), ctx), ForbiddenError);
  const c = await openStockCount(db, inventory, openStockCountInput.parse({note: 'Month-end'}), ctx);
  assert.match(c.number, /^SC\/\d{2}-\d{2}\/00001$/); assert.equal(c.lines, 110);
  await assert.rejects(openStockCount(db, inventory, openStockCountInput.parse({}), ctx), ConflictError, 'one open count');
  assert.equal((await getStockCount(db, inventory, c.id)).lines.length, 110);
  const lineOf = async vid => (await q(`select id from stock_count_lines where stock_count_id = $1 and variant_id = $2`, [c.id, vid]))[0].id;
  // A is found with 2 more than expected, B with 1 fewer, C matches; D (all others) not counted.
  await recordCounts(db, inventory, {stockCountId: c.id, lines: [{lineId: await lineOf(A), counted: 12}, {lineId: await lineOf(B), counted: 9}, {lineId: await lineOf(C), counted: 10}]}, ctx);
  // Meanwhile one unit of A is written off (as a sale would): posting must keep that movement.
  await adjustStock(db, inventory, adjustStockInput.parse({variantId: A, direction: 'decrease', quantity: '1', reason: 'damage', note: 'Torn during count', expectedQty: '10'}), ctx);
  assert.equal(await stockOf(A), 9);
  const res = await postStockCount(db, inventory, {stockCountId: c.id}, ctx);
  assert.deepEqual(res, {counted: 3, adjusted: 2});
  assert.deepEqual([await stockOf(A), await stockOf(B), await stockOf(C)], [11, 9, 10]);
  assert.deepEqual((await q(`select delta, reason, note from inventory_movements where reason = 'count_adjust' order by id`)).map(m => [m.delta, m.note]), [[2, c.number], [-1, c.number]]);
  await assert.rejects(postStockCount(db, inventory, {stockCountId: c.id}, ctx), ConflictError, 'already posted');
  const c2 = await openStockCount(db, inventory, openStockCountInput.parse({}), ctx);
  await assert.rejects(postStockCount(db, inventory, {stockCountId: c2.id}, ctx), ConflictError, 'nothing counted');
  await cancelStockCount(db, inventory, {stockCountId: c2.id}, ctx);
  const ledger = await q(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`);
  assert.deepEqual(ledger, [{n: 0}]);
});

test('stock value: entered costs only; costs.read / costs.manage; the website role cannot read costs', async () => {
  await assert.rejects(stockValue(db, inventory), ForbiddenError);
  await assert.rejects(setVariantCost(db, inventory, variantCostInput.parse({variantId: A, unitCost: '500'}), ctx), ForbiddenError);
  await setVariantCost(db, accountant, variantCostInput.parse({variantId: A, unitCost: '₹1,250.50'}), ctx);
  const v = await stockValue(db, accountant);
  const a = v.garments.find(g => g.id === A);
  assert.deepEqual([a.unit_cost_paise, a.valuePaise], [125050, 125050 * 11]);
  assert.equal(v.totals.garmentsPaise, 125050 * 11, 'only sizes with a cost count');
  assert.equal(v.totals.garmentsWithoutCost, 109);
  await setVariantCost(db, accountant, variantCostInput.parse({variantId: A, unitCost: ''}), ctx);
  assert.deepEqual(await q(`select count(*)::int n from variant_costs`), [{n: 0}]);
  await assert.rejects(web.selectFrom('variant_costs').selectAll().execute(), /permission denied/);
  assert.deepEqual((await q(`select action from audit_logs where action = 'cost.update' order by id`)).length, 2);
});

test.after(async () => { await db.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });
