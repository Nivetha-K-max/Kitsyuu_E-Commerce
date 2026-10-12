/* Packaging materials (2026-10-12), against the LOCAL test database only. Packaging is a kind of material on the existing
   material ledger: no second stock table. Covered: materials stay as they were; a packaging item with its supplier and
   place; receiving on a purchase order; recording use; corrections; the ledger always equals the stock; stock never
   below zero; two people at once; a form sent twice; low stock and what to order; permissions; audit.
   Services run as the real kitsyuu_admin role; setup and checks use the owner connection.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/packaging.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, materialInput, packagingUseInput} from '@kitsyuu/contracts';
import {
  adjustMaterialStock, createPurchaseOrderWithLines, getPurchaseOrder, listMaterials, materialMovements, onlineLocationId, receiveGoods, recordPackagingUse, saveMaterial, saveVendor,
  setPurchaseOrderStatus,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'packaging.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'packaging test passphrase', fullName: role}, ctx)).token);
}
const stockOf = async id => Number((await q(`select stock_qty from materials where id = $1`, [id]))[0].stock_qty);
const ledgerAgrees = async () => (await q(`select count(*)::int n from materials m where m.stock_qty <> coalesce((select sum(v.delta) from material_movements v where v.material_id = m.id), 0)
  or m.stock_qty <> coalesce((select v.balance_after from material_movements v where v.material_id = m.id order by v.id desc limit 1), 0)`))[0].n === 0;
const pack = id => listMaterials(db, root, {kind: 'packaging'}).then(l => l.find(m => m.id === id));
const use = (actor, id, qty, expected, note = 'Packing orders') => recordPackagingUse(db, actor, {materialId: id, qty, expectedStock: expected, note}, ctx);

let root, manager, inventory, accountant, support, vendor, place, fabric, bags, tissue;

before(async () => {
  root = await staff('pk.root@test.local', 'super_admin');          // procurement.manage + costs.read
  manager = await staff('pk.manager@test.local', 'manager');        // procurement.manage, no costs.read
  inventory = await staff('pk.inventory@test.local', 'inventory_manager');   // procurement.read + receive only
  accountant = await staff('pk.accounts@test.local', 'accountant'); // procurement.read + costs.read
  support = await staff('pk.support@test.local', 'support');        // no purchasing permission
  vendor = (await saveVendor(db, root, {name: 'PackWell Supplies', contactName: null, email: null, phone: null, gstin: null, address: null, notes: null}, ctx)).id;
  place = await onlineLocationId(db);
});
after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });

test('materials stay as they were: a material is not packaging, and the list without a kind is everything', async () => {
  fabric = (await saveMaterial(db, manager, materialInput.parse({code: 'FAB-TEST-01', name: 'Test fabric', unit: 'm', reorderLevel: '10', notes: ''}), ctx)).id;
  const all = await listMaterials(db, manager);
  assert.deepEqual(all.map(m => [m.code, m.kind, m.vendor_id, m.location_id]), [['FAB-TEST-01', 'material', null, null]]);
  assert.equal((await listMaterials(db, manager, {kind: 'packaging'})).length, 0);
  assert.equal((await listMaterials(db, manager, {kind: 'material'})).length, 1);
  await assert.rejects(use(manager, fabric, 1, 0), e => e instanceof ConflictError && /not a packaging item/.test(e.message), 'fabric is used through production, not here');
});

test('a packaging item: its own list, with its supplier and where it is kept; its kind is fixed', async () => {
  bags = (await saveMaterial(db, manager, materialInput.parse({code: 'PKG-BAG-M', name: 'Courier bag, medium', unit: 'pcs', reorderLevel: '100', notes: '', kind: 'packaging', vendorId: vendor, locationId: place}), ctx)).id;
  tissue = (await saveMaterial(db, manager, materialInput.parse({code: 'PKG-TISSUE', name: 'Tissue paper', unit: 'sheets', reorderLevel: '', notes: '', kind: 'packaging', vendorId: '', locationId: ''}), ctx)).id;
  const list = await listMaterials(db, manager, {kind: 'packaging'});
  assert.deepEqual(list.map(m => m.code), ['PKG-BAG-M', 'PKG-TISSUE']);
  const b = list[0];
  assert.deepEqual([b.kind, b.vendor_name, !!b.location_name, b.stock, b.reorderLevel, b.low, b.toOrder, b.is_active], ['packaging', 'PackWell Supplies', true, 0, 100, true, 100, true]);
  assert.deepEqual([list[1].vendor_id, list[1].location_id, list[1].low, list[1].toOrder], [null, null, false, 0], 'no supplier, no place, no reorder level: never "low"');
  assert.deepEqual((await listMaterials(db, manager, {kind: 'material'})).map(m => m.code), ['FAB-TEST-01'], 'the materials view does not show packaging');
  // Editing: details change, the kind does not; a form that does not send supplier / place leaves them alone; an empty choice clears them.
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: 'Courier bag, medium (matte)', unit: 'pcs', reorderLevel: '100', notes: '', kind: 'material'}), ctx);
  assert.deepEqual([(await pack(bags)).name, (await pack(bags)).kind, (await pack(bags)).vendor_name], ['Courier bag, medium (matte)', 'packaging', 'PackWell Supplies']);
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: 'Courier bag, medium (matte)', unit: 'pcs', reorderLevel: '100', notes: '', vendorId: ''}), ctx);
  assert.equal((await pack(bags)).vendor_id, null);
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: 'Courier bag, medium (matte)', unit: 'pcs', reorderLevel: '100', notes: '', vendorId: vendor}), ctx);
  await assert.rejects(saveMaterial(db, manager, materialInput.parse({materialId: bags, name: 'x', unit: 'pcs', reorderLevel: '', notes: '', vendorId: '00000000-0000-4000-8000-000000000000'}), ctx), NotFoundError);
  await assert.rejects(q(`update materials set kind = 'box' where id = $1`, [bags]), /materials_kind_check/, 'the database knows only the two kinds');
  assert.equal((await q(`select count(*)::int n from audit_logs where action in ('material.create', 'material.update') and entity_id = $1`, [bags]))[0].n, 4, 'created once, edited three times; the refused edit left nothing');
});

test('receiving: packaging arrives on a purchase order like any material, through the same ledger', async () => {
  const po = await createPurchaseOrderWithLines(db, root, {vendorId: vendor, expectedOn: null, notes: 'Packaging restock', locationId: null, lines: [{materialId: bags, qty: 500, unitCostPaise: 350}]}, ctx);
  assert.equal(await stockOf(bags), 0, 'ordering moves no stock');
  await setPurchaseOrderStatus(db, root, {purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx);
  assert.deepEqual([(await pack(bags)).incoming, (await pack(bags)).toOrder], [500, 0], 'on order: nothing more needs ordering');
  const line = (await getPurchaseOrder(db, root, po.id)).lines[0];
  await receiveGoods(db, inventory, {purchaseOrderId: po.id, lines: [{lineId: line.id, qty: 300, expectedReceived: 0}], note: 'First cartons'}, ctx);
  const b = await pack(bags);
  assert.deepEqual([b.stock, b.incoming, b.low, b.toOrder], [300, 200, false, 0]);
  assert.deepEqual((await materialMovements(db, inventory, bags)).map(m => [m.reason, m.delta, m.balance_after]), [['receipt', 300, 300]]);
  assert.equal(b.last_cost_paise, 350, 'the cost it was last bought at, for staff who may see costs');
  assert.equal((await listMaterials(db, manager, {kind: 'packaging'})).find(m => m.id === bags).last_cost_paise, null, 'not for staff without costs.read');
});

test('use and corrections: each is one ledger row; stock never goes below zero; the ledger always equals the stock', async () => {
  assert.deepEqual(await use(manager, bags, 120, 300, 'Packed 120 orders'), {balance: 180});
  assert.deepEqual(await adjustMaterialStock(db, manager, {materialId: bags, delta: -5, reason: 'damage', note: 'Torn in transit'}, ctx), {balance: 175});
  assert.deepEqual(await adjustMaterialStock(db, manager, {materialId: bags, delta: 2, reason: 'correction', note: 'Recount'}, ctx), {balance: 177});
  assert.deepEqual((await materialMovements(db, manager, bags)).map(m => [m.reason, m.delta, m.balance_after, m.note]),
    [['correction', 2, 177, 'Recount'], ['damage', -5, 175, 'Torn in transit'], ['consume', -120, 180, 'Packed 120 orders'], ['receipt', 300, 300, 'PO/26-27/00001']]);   // a receipt's note is its purchase order number
  await assert.rejects(use(manager, bags, 178, 177), e => e instanceof ConflictError && /not enough/.test(e.message), 'more than there is');
  await assert.rejects(use(manager, bags, 0, 177), DomainError);
  await assert.rejects(use(manager, bags, 5, 177, '  '), DomainError, 'a use says what it was for');
  await assert.rejects(q(`update materials set stock_qty = 9999 where id = $1`, [bags]), /adjust_material_stock/, 'stock cannot be set directly, by anyone');
  assert.equal(await stockOf(bags), 177);
  assert.ok(await ledgerAgrees());
  // Fractions for what is bought by length or weight.
  await adjustMaterialStock(db, manager, {materialId: tissue, delta: 10.5, reason: 'correction', note: 'Opening count'}, ctx);
  assert.deepEqual(await use(manager, tissue, 0.25, 10.5), {balance: 10.25});
  assert.equal(packagingUseInput.safeParse({materialId: tissue, qty: '-1', expectedStock: '10.25', note: 'x'}).success, false);
  assert.equal(packagingUseInput.safeParse({materialId: tissue, qty: '0.0005', expectedStock: '10.25', note: 'x'}).success, false, 'at most 3 decimals');
});

test('a form sent twice is recorded once, and two people recording at the same moment cannot lose an update', async () => {
  const before = (await materialMovements(db, manager, bags)).length;
  // The same form submitted twice (double click, retry): both carry the stock the person saw.
  const twice = await Promise.allSettled([use(manager, bags, 10, 177, 'Double click'), use(manager, bags, 10, 177, 'Double click')]);
  assert.deepEqual(twice.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(twice.find(r => r.status === 'rejected').reason.message, /changed to 167 since you opened this page/);
  assert.deepEqual([await stockOf(bags), (await materialMovements(db, manager, bags)).length], [167, before + 1], 'one use, not two');
  // Six people each record 40 from 167 at once, each having seen 167: only one can be right about what they saw.
  const many = await Promise.allSettled(Array.from({length: 6}, (_, i) => use(i % 2 ? root : manager, bags, 40, 167, `Shift ${i}`)));
  assert.equal(many.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await stockOf(bags), 127);
  // Corrections at the same moment (no "stock seen" on that form): every one is applied, none is lost.
  await Promise.all(Array.from({length: 8}, () => adjustMaterialStock(db, manager, {materialId: bags, delta: -1, reason: 'damage', note: 'Counted damaged'}, ctx)));
  assert.equal(await stockOf(bags), 119);
  // Draining it from several places at once never goes below zero.
  const drain = await Promise.allSettled(Array.from({length: 5}, () => adjustMaterialStock(db, manager, {materialId: bags, delta: -50, reason: 'damage', note: 'Water damage'}, ctx)));
  assert.deepEqual([drain.filter(r => r.status === 'fulfilled').length, await stockOf(bags)], [2, 19]);
  assert.ok(drain.filter(r => r.status === 'rejected').every(r => r.reason instanceof ConflictError));
  assert.equal((await q(`select count(*)::int n from materials where stock_qty < 0`))[0].n, 0);
  assert.ok(await ledgerAgrees(), 'after all of that, every item\'s stock equals the sum of its ledger and the last balance');
});

test('low stock: at or below the reorder level, and how much to order counting what is already on its way', async () => {
  const b = await pack(bags);
  assert.deepEqual([b.stock, b.reorderLevel, b.incoming, b.low, b.toOrder], [19, 100, 200, true, 0], 'low now, but 200 are on order: nothing more to order');
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: b.name, unit: 'pcs', reorderLevel: '400', notes: ''}), ctx);
  assert.deepEqual([(await pack(bags)).low, (await pack(bags)).toOrder], [true, 181], '400 wanted, 19 here, 200 coming: 181 to order');
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: b.name, unit: 'pcs', reorderLevel: '', notes: ''}), ctx);
  assert.deepEqual([(await pack(bags)).low, (await pack(bags)).toOrder], [false, 0], 'no reorder level: no alert');
  await saveMaterial(db, manager, materialInput.parse({materialId: bags, name: b.name, unit: 'pcs', reorderLevel: '19', notes: ''}), ctx);
  assert.equal((await pack(bags)).low, true, 'exactly at the level counts as low');
});

test('permissions: reading needs procurement.read; creating, using and correcting need procurement.manage; an inactive item cannot be used', async () => {
  await assert.rejects(listMaterials(db, support, {kind: 'packaging'}), ForbiddenError);
  for (const reader of [inventory, accountant]) {
    assert.equal((await listMaterials(db, reader, {kind: 'packaging'})).length, 2, 'may read');
    await assert.rejects(use(reader, bags, 1, 19), ForbiddenError);
    await assert.rejects(adjustMaterialStock(db, reader, {materialId: bags, delta: 1, reason: 'correction', note: 'x'}, ctx), ForbiddenError);
    await assert.rejects(saveMaterial(db, reader, materialInput.parse({code: 'PKG-NOPE', name: 'x', unit: 'pcs', reorderLevel: '', notes: '', kind: 'packaging'}), ctx), ForbiddenError);
  }
  await assert.rejects(use(support, bags, 1, 19), ForbiddenError);
  assert.equal(await stockOf(bags), 19, 'nothing changed');
  await assert.rejects(use(manager, '00000000-0000-4000-8000-000000000000', 1, 0), NotFoundError);
  await q(`update materials set is_active = false where id = $1`, [tissue]);
  await assert.rejects(use(manager, tissue, 1, 10.25), e => e instanceof ConflictError && /inactive/.test(e.message));
});

test('audit: every use and correction names who did it, what and why', async () => {
  const uses = await q(`select a.after_data, a.metadata, s.email from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'packaging.use' and a.entity_id = $1 order by a.id`, [bags]);
  assert.equal(uses.length, 3, 'the three uses that went through (the refused ones left no trace of a change)');
  assert.deepEqual([uses[0].after_data, uses[0].metadata, uses[0].email], [{used: 120, balance: 180}, {code: 'PKG-BAG-M', note: 'Packed 120 orders'}, 'pk.manager@test.local']);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'material.stock_adjust' and entity_id = $1`, [bags]))[0].n, 12);
  assert.equal((await q(`select count(*)::int n from material_movements where material_id = $1 and staff_id is null`, [bags]))[0].n, 0, 'every ledger row has its staff member');
});
