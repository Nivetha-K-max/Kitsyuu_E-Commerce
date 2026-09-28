/* M13 vendors, materials and purchasing: permissions (incl. costs.read), vendor/material records, PO lifecycle through
   the declared transitions, partial and full receipts into the material ledger, stock guard, audit.
   LOCAL test database only. The garment catalogue and its stock are untouched (purchasing uses its own tables). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, DomainError, ForbiddenError, adjustMaterialInput, createPurchaseOrderInput, materialInput, poLineInput, poStatusInput, receiveGoodsInput, vendorInput,
} from '@kitsyuu/contracts';
import {
  adjustMaterialStock, createPurchaseOrder, getPurchaseOrder, listMaterials, listVendors, materialMovements, receiveGoods, removePoLine, saveMaterial, saveVendor,
  setPoLine, setPurchaseOrderStatus, setVendorActive,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm13.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm13 test passphrase', fullName: role}, ctx)).token);
}
const stock = async id => Number((await q(`select stock_qty from materials where id = $1`, [id]))[0].stock_qty);

let root, manager, inventory, accountant, support, vendor, denim, thread;

test('setup: permissions by role; nothing is pre-filled', async () => {
  const has = async code => (await q(`select r.code from role_permissions rp join roles r on r.id = rp.role_id where rp.permission_code = $1 order by 1`, [code])).map(r => r.code);
  assert.deepEqual(await has('procurement.receive'), ['admin', 'inventory_manager', 'manager', 'super_admin']);
  assert.deepEqual(await has('costs.read'), ['accountant', 'admin', 'super_admin']);
  assert.deepEqual(await q(`select (select count(*)::int from vendors) v, (select count(*)::int from materials) m, (select count(*)::int from purchase_orders) p`), [{v: 0, m: 0, p: 0}]);
  root = await staff('m13.root@test.local', 'super_admin');
  manager = await staff('m13.manager@test.local', 'manager');           // manage + receive, no costs
  inventory = await staff('m13.inventory@test.local', 'inventory_manager'); // read + receive
  accountant = await staff('m13.accounts@test.local', 'accountant');     // read + costs
  support = await staff('m13.support@test.local', 'support');            // nothing
});

test('vendors and materials: validated, unique, audited; permissions enforced', async () => {
  await assert.rejects(saveVendor(db, inventory, vendorInput.parse({name: 'Loom Co'}), ctx), ForbiddenError);
  assert.throws(() => vendorInput.parse({name: 'X', gstin: 'bad'}));
  vendor = (await saveVendor(db, manager, vendorInput.parse({name: 'Loom Co', email: 'Sales@Loom.test', gstin: '33abcde1234f1z5'}), ctx)).id;
  await assert.rejects(saveVendor(db, manager, vendorInput.parse({name: 'LOOM CO'}), ctx), ConflictError);
  assert.equal((await listVendors(db, inventory))[0].email, 'sales@loom.test');
  await assert.rejects(listVendors(db, support), ForbiddenError);
  denim = (await saveMaterial(db, manager, materialInput.parse({code: 'fab-denim-12oz', name: 'Denim 12 oz', unit: 'm', reorderLevel: '50'}), ctx)).id;
  thread = (await saveMaterial(db, manager, materialInput.parse({code: 'THR-BLK', name: 'Thread, black', unit: 'cones'}), ctx)).id;
  await assert.rejects(saveMaterial(db, manager, materialInput.parse({code: 'FAB-DENIM-12OZ', name: 'Again', unit: 'm'}), ctx), ConflictError);
  const m = (await listMaterials(db, inventory)).find(x => x.id === denim);
  assert.deepEqual([m.code, m.stock, m.reorderLevel, m.low], ['FAB-DENIM-12OZ', 0, 50, true]);
  assert.deepEqual((await q(`select action from audit_logs where action like 'vendor.%' or action like 'material.%' order by id`)).map(r => r.action), ['vendor.create', 'material.create', 'material.create']);
});

test('purchase order: draft lines (cost only with costs.read), place, cancel rules, numbering', async () => {
  const po = await createPurchaseOrder(db, manager, createPurchaseOrderInput.parse({vendorId: vendor, expectedOn: '2026-10-10'}), ctx);
  assert.match(po.poNumber, /^PO\/\d{2}-\d{2}\/00001$/);
  await assert.rejects(setPurchaseOrderStatus(db, manager, poStatusInput.parse({purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft'}), ctx), ConflictError, 'no lines');
  await setPoLine(db, manager, poLineInput.parse({purchaseOrderId: po.id, materialId: denim, qty: '120.5', unitCost: '310'}), ctx);   // manager: cost ignored
  await setPoLine(db, root, poLineInput.parse({purchaseOrderId: po.id, materialId: thread, qty: '40', unitCost: '85.50'}), ctx);
  await setPoLine(db, root, poLineInput.parse({purchaseOrderId: po.id, materialId: denim, qty: '100', unitCost: '310'}), ctx);         // update in place
  assert.deepEqual((await q(`select qty_ordered::text, unit_cost_paise from purchase_order_lines where purchase_order_id = $1 order by position`, [po.id])),
    [{qty_ordered: '100.000', unit_cost_paise: 31000}, {qty_ordered: '40.000', unit_cost_paise: 8550}]);
  const asManager = await getPurchaseOrder(db, manager, po.id), asAccountant = await getPurchaseOrder(db, accountant, po.id);
  assert.ok(asManager.lines.every(l => l.unitCostPaise === undefined) && asManager.totalPaise === undefined, 'costs hidden without costs.read');
  assert.equal(asAccountant.totalPaise, 100 * 31000 + 40 * 8550);
  await setPurchaseOrderStatus(db, manager, poStatusInput.parse({purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft'}), ctx);
  await assert.rejects(setPoLine(db, root, poLineInput.parse({purchaseOrderId: po.id, materialId: thread, qty: '1'}), ctx), ConflictError, 'placed orders are fixed');
  await assert.rejects(setPurchaseOrderStatus(db, manager, poStatusInput.parse({purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft'}), ctx), ConflictError, 'stale');
  // A second order that is cancelled before anything arrives.
  const po2 = await createPurchaseOrder(db, manager, createPurchaseOrderInput.parse({vendorId: vendor}), ctx);
  assert.match(po2.poNumber, /00002$/);
  await setPoLine(db, manager, poLineInput.parse({purchaseOrderId: po2.id, materialId: thread, qty: '5'}), ctx);
  const line = (await q(`select id from purchase_order_lines where purchase_order_id = $1`, [po2.id]))[0].id;
  await removePoLine(db, manager, {purchaseOrderId: po2.id, lineId: line}, ctx);
  await assert.rejects(setPurchaseOrderStatus(db, manager, poStatusInput.parse({purchaseOrderId: po2.id, status: 'cancelled', expectedStatus: 'draft'}), ctx), DomainError, 'reason needed');
  await setPurchaseOrderStatus(db, manager, poStatusInput.parse({purchaseOrderId: po2.id, status: 'cancelled', expectedStatus: 'draft', note: 'Vendor out of stock'}), ctx);
  globalThis.PO = po.id;
});

test('receiving: partial then full, into the material ledger; over-receiving refused; receive permission', async () => {
  const po = globalThis.PO;
  const lines = (await getPurchaseOrder(db, root, po)).lines, dl = lines.find(l => l.materialId === denim), tl = lines.find(l => l.materialId === thread);
  const recv = (who, ls, note) => receiveGoods(db, who, receiveGoodsInput.parse({purchaseOrderId: po, lines: ls, ...(note && {note})}), ctx);
  await assert.rejects(recv(accountant, [{lineId: dl.id, qty: '10'}]), ForbiddenError);
  assert.deepEqual((await recv(inventory, [{lineId: dl.id, qty: '60.25'}], 'Challan 118')).status, 'partially_received');
  assert.equal(await stock(denim), 60.25);
  await assert.rejects(recv(inventory, [{lineId: dl.id, qty: '40'}]), ConflictError, 'only 39.75 outstanding');
  await assert.rejects(setPurchaseOrderStatus(db, root, poStatusInput.parse({purchaseOrderId: po, status: 'cancelled', expectedStatus: 'partially_received', note: 'x'}), ctx), ConflictError);
  assert.deepEqual((await recv(inventory, [{lineId: dl.id, qty: '39.75'}, {lineId: tl.id, qty: '40'}])).status, 'received');
  assert.deepEqual([await stock(denim), await stock(thread)], [100, 40]);
  await assert.rejects(recv(inventory, [{lineId: tl.id, qty: '1'}]), ConflictError, 'a received order takes no more deliveries');
  const mv = await materialMovements(db, root, denim);
  assert.deepEqual(mv.map(m => [m.reason, m.delta, m.balance_after]), [['receipt', 39.75, 100], ['receipt', 60.25, 60.25]]);
  assert.equal((await listMaterials(db, root)).find(m => m.id === denim).low, false, 'above the reorder level now');
});

test('material stock: corrections and write-offs through the ledger; the database refuses anything else', async () => {
  assert.throws(() => adjustMaterialInput.parse({materialId: thread, reason: 'damage', delta: '0', note: 'x'}));
  await assert.rejects(adjustMaterialStock(db, manager, adjustMaterialInput.parse({materialId: thread, reason: 'damage', delta: '3', note: 'wet'}), ctx), DomainError);
  await adjustMaterialStock(db, manager, adjustMaterialInput.parse({materialId: thread, reason: 'damage', delta: '-3', note: 'Water damage'}), ctx);
  await assert.rejects(adjustMaterialStock(db, manager, adjustMaterialInput.parse({materialId: thread, reason: 'correction', delta: '-100', note: 'Count'}), ctx), ConflictError);
  assert.equal(await stock(thread), 37);
  await assert.rejects(q(`update materials set stock_qty = 999 where id = $1`, [thread]), /only through adjust_material_stock/);
  const sums = await q(`select m.code, m.stock_qty = coalesce((select sum(delta) from material_movements x where x.material_id = m.id), 0) as ok from materials m order by 1`);
  assert.ok(sums.every(s => s.ok), 'material stock always equals its ledger');
  await setVendorActive(db, manager, {vendorId: vendor, active: false}, ctx);
  await assert.rejects(createPurchaseOrder(db, manager, createPurchaseOrderInput.parse({vendorId: vendor}), ctx), ConflictError, 'inactive vendor');
  assert.deepEqual(await q(`select count(*)::int n from product_variants where stock_qty <> 10`), [{n: 0}], 'garment stock untouched');
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
