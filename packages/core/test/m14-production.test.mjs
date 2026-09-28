/* M14 production and quality control: lifecycle through the declared transitions, materials used drawn from the material
   ledger, completion by quality check (passed pieces into garment stock via adjust_stock('production_in'), rejected
   recorded with a reason), permissions, audit. LOCAL test database only.
   Leaves +8 units on one size (the passed pieces) — run-e2e.mjs expects exactly that; every stock still equals its ledger. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, DomainError, ForbiddenError, adjustMaterialInput, consumeMaterialInput, createProductionOrderInput, materialInput, productionInputInput,
  productionStatusInput, qualityCheckInput,
} from '@kitsyuu/contracts';
import {
  adjustMaterialStock, consumeMaterial, createProductionOrder, getProductionOrder, listAdjustmentReasons, listProductionOrders, recordQualityCheck, saveMaterial,
  setProductionInput, setProductionStatus,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm14.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm14 test passphrase', fullName: role}, ctx)).token);
}
const status = (id, s, expected, note) => productionStatusInput.parse({productionOrderId: id, status: s, expectedStatus: expected, ...(note && {note})});

let manager, inventory, support, V, fabric;

test('setup: permissions; production_in is a system reason (not offered for manual adjustments)', async () => {
  const has = async code => (await q(`select r.code from role_permissions rp join roles r on r.id = rp.role_id where rp.permission_code = $1 order by 1`, [code])).map(r => r.code);
  assert.deepEqual(await has('qc.record'), ['admin', 'inventory_manager', 'manager', 'super_admin']);
  assert.deepEqual(await has('production.manage'), ['admin', 'manager', 'super_admin']);
  manager = await staff('m14.manager@test.local', 'manager');
  inventory = await staff('m14.inventory@test.local', 'inventory_manager');  // read + qc
  support = await staff('m14.support@test.local', 'support');               // nothing
  assert.ok(!(await listAdjustmentReasons(db, inventory)).some(r => r.code === 'production_in'));
  V = (await q(`select v.id from product_variants v join products p on p.id = v.product_id order by p.id, v.sort_order limit 1`))[0].id;
  fabric = (await saveMaterial(db, manager, materialInput.parse({code: 'FAB-M14', name: 'Fabric', unit: 'm'}), ctx)).id;
  await adjustMaterialStock(db, manager, adjustMaterialInput.parse({materialId: fabric, reason: 'correction', delta: '30', note: 'Opening count'}), ctx);
});

test('lifecycle: plan → start → materials used → quality check completes; passed pieces into stock', async () => {
  await assert.rejects(createProductionOrder(db, inventory, createProductionOrderInput.parse({variantId: V, qty: '10'}), ctx), ForbiddenError);
  const o = await createProductionOrder(db, manager, createProductionOrderInput.parse({variantId: V, qty: '10', dueOn: '2026-10-20'}), ctx);
  assert.match(o.number, /^PR\/\d{2}-\d{2}\/00001$/);
  await setProductionInput(db, manager, productionInputInput.parse({productionOrderId: o.id, materialId: fabric, qtyPlanned: '12.5'}), ctx);
  await assert.rejects(consumeMaterial(db, manager, consumeMaterialInput.parse({productionOrderId: o.id, materialId: fabric, qty: '5'}), ctx), ConflictError, 'not started');
  await assert.rejects(recordQualityCheck(db, inventory, qualityCheckInput.parse({productionOrderId: o.id, passed: '10', rejected: '0'}), ctx), ConflictError, 'not started');
  await setProductionStatus(db, manager, status(o.id, 'in_progress', 'planned'), ctx);
  await assert.rejects(setProductionStatus(db, manager, status(o.id, 'in_progress', 'planned'), ctx), ConflictError, 'stale');
  await consumeMaterial(db, manager, consumeMaterialInput.parse({productionOrderId: o.id, materialId: fabric, qty: '12.25'}), ctx);
  await assert.rejects(consumeMaterial(db, manager, consumeMaterialInput.parse({productionOrderId: o.id, materialId: fabric, qty: '20'}), ctx), ConflictError, 'not enough material');
  const stockBefore = (await q(`select stock_qty from product_variants where id = $1`, [V]))[0].stock_qty;
  await assert.rejects(recordQualityCheck(db, inventory, qualityCheckInput.parse({productionOrderId: o.id, passed: '8', rejected: '2'}), ctx), DomainError, 'reason needed');
  await assert.rejects(recordQualityCheck(db, support, qualityCheckInput.parse({productionOrderId: o.id, passed: '8', rejected: '0'}), ctx), ForbiddenError);
  const r = await recordQualityCheck(db, inventory, qualityCheckInput.parse({productionOrderId: o.id, passed: '8', rejected: '2', rejectReason: 'Uneven stitching'}), ctx);
  assert.equal(r.stockAfter, stockBefore + 8);
  const d = await getProductionOrder(db, manager, o.id);
  assert.deepEqual([d.order.status, d.qc.qty_passed, d.qc.qty_rejected, d.inputs[0].consumed, d.inputs[0].planned], ['completed', 8, 2, 12.25, 12.5]);
  await assert.rejects(recordQualityCheck(db, inventory, qualityCheckInput.parse({productionOrderId: o.id, passed: '1', rejected: '0'}), ctx), ConflictError, 'only once');
  const mv = await q(`select delta, reason, note from inventory_movements where variant_id = $1 order by id desc limit 1`, [V]);
  assert.deepEqual(mv, [{delta: 8, reason: 'production_in', note: o.number}]);
  assert.deepEqual((await q(`select delta::text, reason from material_movements where material_id = $1 order by id`, [fabric])).map(m => [m.delta, m.reason]), [['30.000', 'correction'], ['-12.250', 'consume']]);
  assert.deepEqual((await q(`select action from audit_logs where entity_type = 'production_orders' order by id`)).map(a => a.action),
    ['production.create', 'production.input_plan', 'production.start', 'production.consume', 'production.complete']);
});

test('cancel: reason required, not after completion; a cancelled order adds nothing to stock', async () => {
  const o = await createProductionOrder(db, manager, createProductionOrderInput.parse({variantId: V, qty: '5'}), ctx);
  await assert.rejects(setProductionStatus(db, manager, status(o.id, 'cancelled', 'planned'), ctx), DomainError);
  await setProductionStatus(db, manager, status(o.id, 'cancelled', 'planned', 'Fabric not available'), ctx);
  await assert.rejects(setProductionStatus(db, manager, status(o.id, 'in_progress', 'cancelled'), ctx), ConflictError);
  assert.deepEqual((await listProductionOrders(db, inventory, {status: 'cancelled'})).map(x => x.number), [o.number]);
  await assert.rejects(listProductionOrders(db, support, {}), ForbiddenError);
  const ledgerOk = await q(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`);
  assert.deepEqual(ledgerOk, [{n: 0}], 'every garment stock still equals its ledger');
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
