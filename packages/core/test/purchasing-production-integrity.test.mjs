/* Phase 9 (2026-10-08): Purchasing and Production against the stock ledgers, under repeats and concurrency, on the LOCAL
   test database. Everything goes through the existing services (receiveGoods, consumeMaterial, recordQualityCheck and the
   status functions); the test then checks the ledgers against the stock, not the other way round.
   Covers: partial receiving (40 then 60 of 100 is 100, never 140) into the order's location with the receipt on the ledger
   row; over-receiving refused with nothing written; materials received into, and consumed from, the material ledger;
   finished pieces into stock once, by the quality check; simultaneous receipts, consumption, output and status changes;
   permissions on the server; the audit records; and that every stock equals the sum of its ledger rows afterwards.
   Net effect (run-e2e.mjs expects it): +18 units of online stock (8 + 10 passed pieces); product receipts go to a branch.
   2026-10-08 (approved core change): receiveGoods and consumeMaterial REQUIRE what the caller saw (received / used so far) and
   refuse a request made from an out-of-date page, after taking their locks; the two
   "stale page" tests run 30 rounds of five identical simultaneous requests each (P9_STALE_ROUNDS to run more).
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/purchasing-production-integrity.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError} from '@kitsyuu/contracts';
import {
  adjustMaterialStock, consumeMaterial, createProductionOrder, createPurchaseOrderWithLines, getProductionOrder, getPurchaseOrder, receiveGoods, recordQualityCheck,
  saveLocation, saveMaterial, saveVendor, setPoLine, setProductionInput, setProductionStatus, setPurchaseOrderStatus,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 12});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'p9.test', requestId: 'test'};
const ROUNDS = 20;        // rounds of five simultaneous identical receipts
const STALE_ROUNDS = Number(process.env.P9_STALE_ROUNDS ?? 30);   // rounds of five identical simultaneous requests made from the same page (stock-neutral for the online total)
const QC_ROUNDS = 10;     // rounds of five simultaneous quality checks (one passed piece each: fixed, the net stock is expected)

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'phase nine test passphrase', fullName: role}, ctx)).token);
}
const settled = async calls => { const r = await Promise.allSettled(calls); return {ok: r.filter(x => x.status === 'fulfilled').length, errors: r.filter(x => x.status === 'rejected').map(x => x.reason)}; };
const conflicts = errors => errors.every(e => e instanceof ConflictError);
/** Stock equals the sum of its ledger rows: online stock, every location's stock, and every material's stock. */
const mismatches = async () => (await q(`select
  (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online))))
  + (select count(*)::int from location_stock s where s.qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)) stock,
  (select count(*)::int from materials t where t.stock_qty <> (select coalesce(sum(m.delta),0) from material_movements m where m.material_id = t.id)) material,
  (select count(*)::int from location_stock where qty < 0) + (select count(*)::int from product_variants where stock_qty < 0) + (select count(*)::int from materials where stock_qty < 0) negative`))[0];
const CLEAN = {stock: 0, material: 0, negative: 0};
const here = async (loc, variant) => (await q(`select coalesce((select qty from location_stock where location_id = $1::uuid and variant_id = $2::uuid), 0)::int n`, [loc, variant]))[0].n;
const onlineQty = async id => (await q(`select stock_qty from product_variants where id = $1::uuid`, [id]))[0].stock_qty;
const matQty = async id => Number((await q(`select stock_qty from materials where id = $1::uuid`, [id]))[0].stock_qty);
const poState = async id => (await q(`select p.status,
  (select coalesce(sum(qty_ordered),0)::float from purchase_order_lines where purchase_order_id = p.id) ordered,
  (select coalesce(sum(qty_received),0)::float from purchase_order_lines where purchase_order_id = p.id) received,
  (select count(*)::int from goods_receipts where purchase_order_id = p.id) receipts,
  (select count(*)::int from goods_receipt_lines gl join goods_receipts g on g.id = gl.goods_receipt_id where g.purchase_order_id = p.id) receipt_lines,
  (select count(*)::int from inventory_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id) stock_rows,
  (select coalesce(sum(m.delta),0)::int from inventory_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id) stock_sum,
  (select count(*)::int from material_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id) material_rows,
  (select coalesce(sum(m.delta),0)::float from material_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id) material_sum,
  (select count(*)::int from audit_logs a where a.entity_type = 'purchase_orders' and a.entity_id = p.id::text and a.action = 'purchase_order.receive') receive_audits
  from purchase_orders p where p.id = $1::uuid`, [id]))[0];
const audits = async (type, id) => (await q(`select action from audit_logs where entity_type = $1 and entity_id = $2 order by id`, [type, id])).map(r => r.action);

let root, manager, inventory, support, vendor, fabric, branch, A, B;
/** A purchase order sent to the vendor (created, approved and placed by the super admin), ready to be received. */
async function sentPo(lines, locationId = branch) {
  const po = await createPurchaseOrderWithLines(admin, root, {vendorId: vendor, expectedOn: null, notes: null, locationId, lines: lines.map(l => ({unitCostPaise: null, ...l}))}, ctx);
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx);
  const rows = await q(`select id, variant_id, material_id from purchase_order_lines where purchase_order_id = $1::uuid order by position`, [po.id]);
  return {id: po.id, number: po.poNumber, lines: rows.map(r => r.id)};
}
/** A delivery entered on a page opened just now: each line is sent with what is received on it at this moment. */
const receive = async (actor, po, qtys, note = null) => {
  const seen = po.lines.length ? new Map((await q(`select id, qty_received::float r from purchase_order_lines where purchase_order_id = $1::uuid`, [po.id])).map(x => [x.id, x.r])) : new Map();
  return receiveGoods(admin, actor, {purchaseOrderId: po.id, lines: po.lines.map((lineId, i) => ({lineId, qty: qtys[i] ?? 0, expectedReceived: seen.get(lineId) ?? 0})), note, vendorRef: null}, ctx);
};
/** The same delivery sent from ONE page (a fixed figure): each line with what that page showed as already received. */
const receiveSeen = (actor, po, qtys, seen, note = null) => receiveGoods(admin, actor, {purchaseOrderId: po.id, lines: po.lines.map((lineId, i) => ({lineId, qty: qtys[i] ?? 0, expectedReceived: seen[i] ?? 0})), note, vendorRef: null}, ctx);
const stale = e => e instanceof ConflictError && /since you opened the page/.test(e.message);
async function startedProduction(variantId, qty) {
  const o = await createProductionOrder(admin, root, {variantId, qty, dueOn: null, notes: null}, ctx);
  await setProductionStatus(admin, root, {productionOrderId: o.id, status: 'in_progress', expectedStatus: 'planned', note: null}, ctx);
  return o;
}

before(async () => {
  root = await staff('p9.root@test.local', 'super_admin');
  manager = await staff('p9.manager@test.local', 'manager');
  inventory = await staff('p9.inventory@test.local', 'inventory_manager');   // procurement.read + receive; production.read + qc.record
  support = await staff('p9.support@test.local', 'support');                 // none of purchasing or production
  vendor = (await saveVendor(admin, root, {name: 'Phase Nine Mills', contact: null, email: null, phone: null, gstin: null, address: null, notes: null}, ctx)).id;
  fabric = (await saveMaterial(admin, root, {code: 'FAB-P9', name: 'Phase nine fabric', unit: 'm', reorderLevel: null, notes: null}, ctx)).id;
  branch = (await saveLocation(admin, root, {code: 'RB-P9', name: 'Phase Nine Branch', kind: 'retail', address: null, active: true}, ctx)).id;
  [A, B] = await owner.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').select(['v.id', 'v.sku', 'v.stock_qty']).where('p.status', '=', 'active').orderBy('v.sku').limit(2).execute();
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

test('baseline: every stock equals its ledger; the new material and branch hold nothing', async () => {
  assert.deepEqual(await mismatches(), CLEAN);
  assert.equal(await matQty(fabric), 0);
  assert.equal(await here(branch, A.id), 0);
});

let main;
test('a purchase order moves no stock until goods are received (created, approved, sent)', async () => {
  const before = {a: await onlineQty(A.id), m: await matQty(fabric), moves: (await q(`select count(*)::int n from inventory_movements`))[0].n};
  main = await sentPo([{variantId: A.id, qty: 100}, {materialId: fabric, qty: 50}]);
  assert.deepEqual({a: await onlineQty(A.id), m: await matQty(fabric), moves: (await q(`select count(*)::int n from inventory_movements`))[0].n}, before);
  assert.deepEqual(await poState(main.id), {status: 'ordered', ordered: 150, received: 0, receipts: 0, receipt_lines: 0, stock_rows: 0, stock_sum: 0, material_rows: 0, material_sum: 0, receive_audits: 0});
});

test('partial receiving: 40 then 60 of 100 is 100 (never 140); each receipt writes one ledger row at the order\'s location, linked to the receipt', async () => {
  const online = await onlineQty(A.id);
  const first = await receive(inventory, main, [40, 20], 'first delivery');
  assert.equal(first.status, 'partially_received');
  assert.match(first.receiptNumber, /^GRN/);
  let line = (await q(`select qty_ordered::float o, qty_received::float r from purchase_order_lines where id = $1::uuid`, [main.lines[0]]))[0];
  assert.deepEqual([line.o, line.r, line.o - line.r], [100, 40, 60], 'ordered 100, received 40, remaining 60');
  assert.equal(await here(branch, A.id), 40);
  assert.equal(await matQty(fabric), 20);
  const second = await receive(inventory, main, [60, 30], 'second delivery');
  assert.equal(second.status, 'received');
  assert.notEqual(second.receiptNumber, first.receiptNumber, 'each delivery has its own goods receipt number');
  line = (await q(`select qty_ordered::float o, qty_received::float r from purchase_order_lines where id = $1::uuid`, [main.lines[0]]))[0];
  assert.deepEqual([line.o, line.r], [100, 100]);
  assert.equal(await here(branch, A.id), 100, 'the branch holds exactly what was ordered and received');
  assert.equal(await matQty(fabric), 50);
  assert.equal(await onlineQty(A.id), online, 'the online stock was not touched: the order is received at the branch');
  assert.deepEqual(await poState(main.id), {status: 'received', ordered: 150, received: 150, receipts: 2, receipt_lines: 4, stock_rows: 2, stock_sum: 100, material_rows: 2, material_sum: 50, receive_audits: 2});
  // The trace PO → receipt → stock movement → location, as the ledger keeps it.
  const rows = await q(`select m.delta, m.balance_after, m.reason, m.location_id, m.staff_id, g.receipt_number, g.location_id as receipt_location, m.note
    from inventory_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = $1::uuid order by m.id`, [main.id]);
  assert.deepEqual(rows.map(r => [r.delta, r.balance_after, r.reason]), [[40, 40, 'purchase_in'], [60, 100, 'purchase_in']]);
  assert.ok(rows.every(r => r.location_id === branch && r.receipt_location === branch && r.staff_id === inventory.staffId));
  assert.deepEqual(rows.map(r => r.receipt_number), [first.receiptNumber, second.receiptNumber]);
  assert.ok(rows.every(r => r.note.includes(main.number)), 'the ledger row names the purchase order and the receipt');
  const mat = await q(`select m.delta::float d, m.balance_after::float b, m.reason from material_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = $1::uuid order by m.id`, [main.id]);
  assert.deepEqual(mat.map(r => [r.d, r.b, r.reason]), [[20, 20, 'receipt'], [30, 50, 'receipt']]);
});

test('nothing more can be received on a fully received order, and over-receiving is refused: neither writes anything', async () => {
  const before = await poState(main.id);
  await assert.rejects(receive(inventory, main, [1, 0]), ConflictError);
  assert.deepEqual(await poState(main.id), before);
  const po = await sentPo([{variantId: A.id, qty: 10}]);
  await receive(inventory, po, [4]);
  const mid = await poState(po.id), stock = await here(branch, A.id);
  await assert.rejects(receive(inventory, po, [7]), e => e instanceof ConflictError && /outstanding/.test(e.message), '7 is more than the 6 still to come');
  await assert.rejects(receive(inventory, po, [0]), DomainError, 'an empty receipt is refused');
  await assert.rejects(receive(inventory, po, [1.5]), DomainError, 'products are received in whole pieces');
  assert.deepEqual(await poState(po.id), mid, 'refused receipts left no receipt, no line, no ledger row and no audit record');
  assert.equal(await here(branch, A.id), stock);
  assert.equal((await receive(inventory, po, [6])).status, 'received');
  assert.equal(await here(branch, A.id), stock + 6);
  // A draft or cancelled order cannot be received.
  const draft = await createPurchaseOrderWithLines(admin, root, {vendorId: vendor, expectedOn: null, notes: null, locationId: branch, lines: [{variantId: A.id, qty: 5, unitCostPaise: null}]}, ctx);
  const draftLine = (await q(`select id from purchase_order_lines where purchase_order_id = $1::uuid`, [draft.id]))[0].id;
  await assert.rejects(receiveGoods(admin, inventory, {purchaseOrderId: draft.id, lines: [{lineId: draftLine, qty: 5}], note: null}, ctx), ConflictError);
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: draft.id, status: 'cancelled', expectedStatus: 'draft', note: 'not needed'}, ctx);
  await assert.rejects(receiveGoods(admin, inventory, {purchaseOrderId: draft.id, lines: [{lineId: draftLine, qty: 5}], note: null}, ctx), ConflictError);
  assert.equal((await poState(draft.id)).receipts, 0);
});

test('permissions are enforced on the server: reading, ordering, receiving, production and the quality check', async () => {
  const po = await sentPo([{variantId: A.id, qty: 2}]);
  await assert.rejects(getPurchaseOrder(admin, support, po.id), ForbiddenError);
  await assert.rejects(receive(support, po, [2]), ForbiddenError);
  await assert.rejects(receive(manager, {id: po.id, lines: []}, []), DomainError);                       // a manager may receive; nothing entered is a validation error
  await assert.rejects(createPurchaseOrderWithLines(admin, inventory, {vendorId: vendor, expectedOn: null, notes: null, locationId: null, lines: [{variantId: A.id, qty: 1, unitCostPaise: null}]}, ctx), ForbiddenError,
    'an inventory manager receives goods but does not place orders');
  await assert.rejects(setPurchaseOrderStatus(admin, inventory, {purchaseOrderId: po.id, status: 'cancelled', expectedStatus: 'ordered', note: 'x'}, ctx), ForbiddenError);
  const pr = await startedProduction(B.id, 3);
  await assert.rejects(getProductionOrder(admin, support, pr.id), ForbiddenError);
  await assert.rejects(consumeMaterial(admin, support, {productionOrderId: pr.id, materialId: fabric, qty: 1}, ctx), ForbiddenError);
  await assert.rejects(consumeMaterial(admin, inventory, {productionOrderId: pr.id, materialId: fabric, qty: 1}, ctx), ForbiddenError, 'recording material used needs production.manage');
  await assert.rejects(recordQualityCheck(admin, support, {productionOrderId: pr.id, passed: 3, rejected: 0, rejectReason: null, note: null}, ctx), ForbiddenError);
  await assert.rejects(setProductionStatus(admin, inventory, {productionOrderId: pr.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'x'}, ctx), ForbiddenError);
  assert.equal((await poState(po.id)).receipts, 0);
  assert.equal(await matQty(fabric), 50, 'refused requests changed nothing');
  // Tidy up through the services: the order is cancelled, the production order too (neither moved stock).
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'cancelled', expectedStatus: 'ordered', note: 'permission test'}, ctx);
  await setProductionStatus(admin, root, {productionOrderId: pr.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'permission test'}, ctx);
});

test(`concurrency, receipts: ${ROUNDS} rounds of five identical simultaneous receipts of everything outstanding — one is applied, four refused, one ledger row`, async () => {
  let expected = await here(branch, A.id);
  const seen = {applied: 0, refused: 0, other: 0};
  for (let round = 1; round <= ROUNDS; round++) {
    const qty = 1 + (round % 4);
    const po = await sentPo([{variantId: A.id, qty}]);
    const r = await settled(Array.from({length: 5}, () => receive(inventory, po, [qty], `round ${round}`)));
    seen.applied += r.ok; seen.refused += r.errors.filter(e => e instanceof ConflictError).length; seen.other += r.errors.filter(e => !(e instanceof ConflictError)).length;
    assert.equal(r.ok, 1, `round ${round}: exactly one of five is applied`);
    expected += qty;
    assert.equal(await here(branch, A.id), expected, `round ${round}: the stock rose by the ordered quantity, once`);
    assert.deepEqual(await poState(po.id), {status: 'received', ordered: qty, received: qty, receipts: 1, receipt_lines: 1, stock_rows: 1, stock_sum: qty, material_rows: 0, material_sum: 0, receive_audits: 1}, `round ${round}`);
  }
  assert.deepEqual(seen, {applied: ROUNDS, refused: ROUNDS * 4, other: 0});
  assert.deepEqual(await mismatches(), CLEAN);
});

test(`stale page, receipts: ${STALE_ROUNDS} rounds of five identical simultaneous PARTIAL receipts made from the same page — one is applied, four are refused as out of date, nothing is written twice`, async () => {
  const seen = {applied: 0, stale: 0, other: 0};
  let held = await here(branch, A.id);
  for (let round = 1; round <= STALE_ROUNDS; round++) {
    const po = await sentPo([{variantId: A.id, qty: 10}]);
    // 4 of 10: all five would fit in what is outstanding one after another (4 + 4 = 8), so only the page's figure can tell them apart.
    const r = await settled(Array.from({length: 5}, () => receiveSeen(inventory, po, [4], [0], `stale round ${round}`)));
    seen.applied += r.ok; seen.stale += r.errors.filter(stale).length; seen.other += r.errors.filter(e => !stale(e)).length;
    assert.equal(r.ok, 1, `round ${round}: exactly one of five is applied`);
    assert.ok(r.errors.length === 4 && r.errors.every(stale), `round ${round}: the other four are refused as out of date`);
    held += 4;
    assert.deepEqual(await poState(po.id), {status: 'partially_received', ordered: 10, received: 4, receipts: 1, receipt_lines: 1, stock_rows: 1, stock_sum: 4, material_rows: 0, material_sum: 0, receive_audits: 1}, `round ${round}: received 4, remaining 6, one receipt, one ledger row, one audit record`);
    assert.equal(await here(branch, A.id), held, `round ${round}: the stock rose by 4, once`);
    // The rest, again five at once from the refreshed page (4 already received): one is applied, the order is complete.
    const rest = await settled(Array.from({length: 5}, () => receiveSeen(inventory, po, [6], [4])));
    assert.equal(rest.ok, 1, `round ${round}: the remaining 6 are received once`);
    assert.ok(rest.errors.every(e => e instanceof ConflictError));
    held += 6;
    assert.deepEqual(await poState(po.id), {status: 'received', ordered: 10, received: 10, receipts: 2, receipt_lines: 2, stock_rows: 2, stock_sum: 10, material_rows: 0, material_sum: 0, receive_audits: 2}, `round ${round}: 4 then 6 is 10`);
    assert.equal(await here(branch, A.id), held);
  }
  assert.deepEqual(seen, {applied: STALE_ROUNDS, stale: STALE_ROUNDS * 4, other: 0});
  // An old page, one after another (not at the same moment): the second person still sees "0 received".
  const po = await sentPo([{variantId: A.id, qty: 10}, {materialId: fabric, qty: 9}]);
  const m0 = await matQty(fabric);
  await receiveSeen(inventory, po, [4, 2.5], [0, 0]);
  const mid = await poState(po.id);
  await assert.rejects(receiveSeen(manager, po, [4, 2.5], [0, 0]), stale, 'the same delivery entered again from the old page is refused');
  await assert.rejects(receiveSeen(manager, po, [0, 2.5], [0, 0]), stale, 'also when only the material line is entered');
  assert.deepEqual(await poState(po.id), mid, 'refused: no receipt, no line, no ledger row, no audit record');
  assert.equal(await matQty(fabric), m0 + 2.5);
  // More than is still to come, from an up-to-date page, five at once: all refused for the quantity, nothing written.
  const over = await settled(Array.from({length: 5}, () => receiveSeen(inventory, po, [7, 0], [4, 2.5])));
  assert.equal(over.ok, 0);
  assert.ok(over.errors.every(e => e instanceof ConflictError && /outstanding/.test(e.message)), '7 is more than the 6 still to come');
  assert.deepEqual(await poState(po.id), mid);
  // Five simultaneous identical material receipts from the up-to-date page: one.
  const mat = await settled(Array.from({length: 5}, () => receiveSeen(inventory, po, [0, 3], [4, 2.5])));
  assert.equal(mat.ok, 1);
  assert.ok(mat.errors.every(stale));
  assert.equal(await matQty(fabric), m0 + 5.5);
  assert.equal((await poState(po.id)).material_rows, 2);
  assert.deepEqual(await mismatches(), CLEAN);
});

test(`stale page, material used: ${STALE_ROUNDS} rounds of five identical simultaneous uses made from the same page — one is recorded, four are refused as out of date`, async () => {
  // Material for the rounds arrives the normal way: a purchase order received in full.
  const need = Math.ceil(STALE_ROUNDS * 1.25) + 20;   // enough for every round, so a refusal can only be the out-of-date check
  const supply = await sentPo([{materialId: fabric, qty: need}]);
  await receiveSeen(inventory, supply, [need], [0]);
  const o = await startedProduction(A.id, 2);
  const use = (qty, expectedConsumed, materialId = fabric) => consumeMaterial(admin, root, {productionOrderId: o.id, materialId, qty, expectedConsumed}, ctx);
  const st = async () => (await q(`select (select stock_qty::float from materials where id = $1::uuid) stock,
    (select coalesce((select qty_consumed::float from production_inputs where production_order_id = $2::uuid and material_id = $1::uuid), 0)) used,
    (select count(*)::int from material_movements where material_id = $1::uuid and reason = 'consume' and note = $3) rows,
    (select coalesce(sum(delta), 0)::float from material_movements where material_id = $1::uuid and reason = 'consume' and note = $3) ledger,
    (select count(*)::int from audit_logs where entity_type = 'production_orders' and entity_id = $4 and action = 'production.consume') audits`, [fabric, o.id, o.number, o.id]))[0];
  const start = await st();
  const seen = {applied: 0, stale: 0, other: 0};
  let used = 0;
  for (let round = 1; round <= STALE_ROUNDS; round++) {
    const qty = round % 2 ? 0.5 : 1.25;          // small: all five would fit in stock, so only the page's figure can tell them apart
    const r = await settled(Array.from({length: 5}, () => use(qty, used)));
    seen.applied += r.ok; seen.stale += r.errors.filter(stale).length; seen.other += r.errors.filter(e => !stale(e)).length;
    assert.equal(r.ok, 1, `round ${round}: exactly one of five is recorded`);
    assert.ok(r.errors.length === 4 && r.errors.every(stale), `round ${round}: the other four are refused as out of date`);
    used = +(used + qty).toFixed(3);
    const now = await st();
    assert.deepEqual([now.used, now.rows, now.audits], [used, round, round], `round ${round}: used, ledger rows and audit records are exactly one step on`);
    assert.ok(Math.abs(now.stock - (start.stock - used)) < 1e-9 && Math.abs(now.ledger + used) < 1e-9, `round ${round}: the material balance and the ledger agree`);
  }
  assert.deepEqual(seen, {applied: STALE_ROUNDS, stale: STALE_ROUNDS * 4, other: 0});
  // An old page, one after another.
  const mid = await st();
  await assert.rejects(use(1, 0), stale, 'a use entered from a page that still showed nothing used is refused');
  // Not enough in stock, from an up-to-date page, five at once: all refused for the quantity.
  const over = await settled(Array.from({length: 5}, () => use(mid.stock + 1, used)));
  assert.equal(over.ok, 0);
  assert.ok(over.errors.every(e => e instanceof ConflictError && /not enough/.test(e.message)));
  assert.deepEqual(await st(), mid, 'refused requests wrote nothing: no ledger row, no quantity, no audit record');
  // Tidy up: the order is cancelled (it made nothing; the material it used stays used).
  await setProductionStatus(admin, root, {productionOrderId: o.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'stale-page test'}, ctx);
  assert.deepEqual(await mismatches(), CLEAN);
});

test('the stale-state value is mandatory in both functions: valid proceeds once, stale is refused, missing or malformed is refused, and a refusal writes nothing', async () => {
  const po = await sentPo([{variantId: A.id, qty: 10}]);
  const before = await poState(po.id), held = await here(branch, A.id);
  const noFigure = () => receiveGoods(admin, inventory, {purchaseOrderId: po.id, lines: [{lineId: po.lines[0], qty: 4}], note: null, vendorRef: null}, ctx);
  await assert.rejects(noFigure(), stale);
  const r = await settled(Array.from({length: 5}, noFigure));
  assert.equal(r.ok, 0, 'five at once without the figure: none is applied');
  assert.ok(r.errors.every(stale));
  assert.deepEqual(await poState(po.id), before);
  assert.equal(await here(branch, A.id), held);
  const o = await startedProduction(A.id, 1);
  const m = await matQty(fabric);
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: 1}, ctx), stale);
  // Anything that is not the number the record holds is refused: absent, null, text, not-a-number, or simply wrong.
  for (const bad of [undefined, null, '0', NaN, 1]) {
    await assert.rejects(consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: 1, expectedConsumed: bad}, ctx), stale, `material use with ${String(bad)}`);
    await assert.rejects(receiveGoods(admin, inventory, {purchaseOrderId: po.id, lines: [{lineId: po.lines[0], qty: 4, expectedReceived: bad}], note: null, vendorRef: null}, ctx), stale, `receipt with ${String(bad)}`);
  }
  assert.equal(await matQty(fabric), m);
  assert.equal((await audits('production_orders', o.id)).filter(a => a === 'production.consume').length, 0);
  assert.deepEqual(await poState(po.id), before, 'every refused request left the order, the stock, the ledgers and the audit log untouched');
  assert.equal((await q(`select count(*)::int n from material_movements where reason = 'consume' and note = $1`, [o.number]))[0].n, 0);
  // The right value goes through, once; the same value again is then out of date.
  await receiveGoods(admin, inventory, {purchaseOrderId: po.id, lines: [{lineId: po.lines[0], qty: 4, expectedReceived: 0}], note: null, vendorRef: null}, ctx);
  await assert.rejects(receiveGoods(admin, inventory, {purchaseOrderId: po.id, lines: [{lineId: po.lines[0], qty: 4, expectedReceived: 0}], note: null, vendorRef: null}, ctx), stale);
  assert.deepEqual((({received, receipts, stock_rows, receive_audits}) => [received, receipts, stock_rows, receive_audits])(await poState(po.id)), [4, 1, 1, 1]);
  assert.equal(await here(branch, A.id), held + 4);
  await consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: 1, expectedConsumed: 0}, ctx);
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: 1, expectedConsumed: 0}, ctx), stale);
  assert.equal(await matQty(fabric), m - 1);
  assert.equal((await audits('production_orders', o.id)).filter(a => a === 'production.consume').length, 1);
  assert.equal((await q(`select count(*)::int n from material_movements where reason = 'consume' and note = $1`, [o.number]))[0].n, 1);
  await setProductionStatus(admin, root, {productionOrderId: o.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'test'}, ctx);
});

test('different records at the same moment do not disturb each other: every valid request succeeds; shared material is never overdrawn', async () => {
  // Five different purchase orders received at once, and two lines of one order received by two people at once: all applied.
  const pos = await Promise.all(Array.from({length: 5}, (_, i) => sentPo([{variantId: A.id, qty: 2 + i}])));
  const held = await here(branch, A.id);
  const r = await settled(pos.map((po, i) => receiveSeen(inventory, po, [2 + i], [0])));
  assert.equal(r.ok, 5, 'five receipts on five different orders all succeed');
  assert.equal(await here(branch, A.id), held + 2 + 3 + 4 + 5 + 6);
  for (const [i, po] of pos.entries()) assert.deepEqual(await poState(po.id), {status: 'received', ordered: 2 + i, received: 2 + i, receipts: 1, receipt_lines: 1, stock_rows: 1, stock_sum: 2 + i, material_rows: 0, material_sum: 0, receive_audits: 1});
  const two = await sentPo([{variantId: A.id, qty: 3}, {materialId: fabric, qty: 40}]);
  const lines = two.lines;
  const both = await settled([
    receiveGoods(admin, inventory, {purchaseOrderId: two.id, lines: [{lineId: lines[0], qty: 3, expectedReceived: 0}], note: null}, ctx),
    receiveGoods(admin, manager, {purchaseOrderId: two.id, lines: [{lineId: lines[1], qty: 40, expectedReceived: 0}], note: null}, ctx)]);
  assert.equal(both.ok, 2, 'two people receiving different lines of one order at once: both are applied');
  assert.deepEqual((({status, received, receipts, receive_audits}) => [status, received, receipts, receive_audits])(await poState(two.id)), ['received', 43, 2, 2]);
  // Five different production orders using the same material at once, each from its own up-to-date page.
  const orders = []; for (let i = 0; i < 5; i++) orders.push(await startedProduction(A.id, 1));
  const m0 = await matQty(fabric);
  const uses = await settled(orders.map(o => consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: 1.5, expectedConsumed: 0}, ctx)));
  assert.equal(uses.ok, 5, 'five orders using a material that is in stock: all recorded');
  assert.ok(Math.abs((await matQty(fabric)) - (m0 - 7.5)) < 1e-9);
  // The same five, each now wanting 30% of what is left: only three fit; the others are refused for the quantity; stock never goes below zero.
  const left = await matQty(fabric), want = +(left * 0.3).toFixed(3);
  const tight = await settled(orders.map(o => consumeMaterial(admin, root, {productionOrderId: o.id, materialId: fabric, qty: want, expectedConsumed: 1.5}, ctx)));
  assert.equal(tight.ok, 3, 'only the number that fits in stock succeeds');
  assert.ok(tight.errors.length === 2 && tight.errors.every(e => e instanceof ConflictError && /not enough/.test(e.message)));
  const after = await matQty(fabric);
  assert.ok(after >= 0 && Math.abs(after - (left - 3 * want)) < 1e-6, 'the material balance is exactly what the three took');
  const rows = await q(`select count(*)::int n, coalesce(sum(delta), 0)::float d from material_movements where material_id = $1::uuid and reason = 'consume' and note = any($2)`, [fabric, orders.map(o => o.number)]);
  assert.equal(rows[0].n, 5 + 3, 'one ledger row per recorded use, none for the refused ones');
  assert.ok(Math.abs(rows[0].d + 7.5 + 3 * want) < 1e-6);
  let audited = 0; for (const o of orders) audited += (await audits('production_orders', o.id)).filter(a => a === 'production.consume').length;
  assert.equal(audited, 8);
  // Different materials at the same moment: five orders, alternating between two materials, plus one order using both at once.
  const trim = (await saveMaterial(admin, root, {code: 'TRIM-P9', name: 'Phase nine trim', unit: 'pcs', reorderLevel: null, notes: null}, ctx)).id;
  const trimPo = await sentPo([{materialId: trim, qty: 50}]);
  await receiveSeen(inventory, trimPo, [50], [0]);
  const moreFabric = await sentPo([{materialId: fabric, qty: 50}]);
  await receiveSeen(inventory, moreFabric, [50], [0]);
  const f0 = await matQty(fabric), t0 = await matQty(trim);
  const usedSoFar = async (o, material) => Number((await q(`select coalesce((select qty_consumed from production_inputs where production_order_id = $1::uuid and material_id = $2::uuid), 0)::float n`, [o.id, material]))[0].n);
  const seenFabric = await Promise.all(orders.map(o => usedSoFar(o, fabric)));
  const par = await settled([
    ...orders.map((o, i) => consumeMaterial(admin, root, {productionOrderId: o.id, materialId: i % 2 ? trim : fabric, qty: 2, expectedConsumed: i % 2 ? 0 : seenFabric[i]}, ctx)),
  ]);
  assert.equal(par.ok, 5, 'five orders, two materials, at once: all recorded, no database error');
  assert.ok(Math.abs((await matQty(fabric)) - (f0 - 6)) < 1e-6 && Math.abs((await matQty(trim)) - (t0 - 4)) < 1e-6, 'three used fabric, two used trim');
  const one = orders[1];   // it has used trim (2) and fabric; both of its materials at the same moment
  const bothMaterials = await settled([
    consumeMaterial(admin, root, {productionOrderId: one.id, materialId: trim, qty: 1, expectedConsumed: 2}, ctx),
    consumeMaterial(admin, root, {productionOrderId: one.id, materialId: fabric, qty: 1, expectedConsumed: await usedSoFar(one, fabric)}, ctx)]);
  assert.equal(bothMaterials.ok, 2, 'one order using two different materials at once: both recorded');
  assert.ok(Math.abs((await matQty(trim)) - (t0 - 5)) < 1e-6);
  assert.equal((await q(`select count(*)::int n from material_movements where material_id = $1::uuid and reason = 'consume'`, [trim]))[0].n, 3, 'one ledger row per use of the second material');
  for (const o of orders) await setProductionStatus(admin, root, {productionOrderId: o.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'test'}, ctx);
  assert.deepEqual(await mismatches(), CLEAN);
});

test('concurrency, purchase order steps: sent once, cancel against receive never both, a draft line is never duplicated', async () => {
  const po = await createPurchaseOrderWithLines(admin, root, {vendorId: vendor, expectedOn: null, notes: null, locationId: branch, lines: [{variantId: A.id, qty: 3, unitCostPaise: null}]}, ctx);
  // Five different quantities for the same line at once: one line remains, holding one of the five.
  const edits = await settled([5, 6, 7, 8, 9].map(qty => setPoLine(admin, root, {purchaseOrderId: po.id, variantId: A.id, qty, unitCostPaise: null}, ctx)));
  assert.equal(edits.ok, 5);
  const lines = await q(`select qty_ordered::float o from purchase_order_lines where purchase_order_id = $1::uuid`, [po.id]);
  assert.equal(lines.length, 1);
  assert.ok([5, 6, 7, 8, 9].includes(lines[0].o));
  const sent = await settled(Array.from({length: 5}, () => setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx)));
  assert.equal(sent.ok, 1);
  assert.ok(conflicts(sent.errors));
  assert.deepEqual((await audits('purchase_orders', po.id)).filter(a => a === 'purchase_order.place'), ['purchase_order.place']);
  await assert.rejects(setPoLine(admin, root, {purchaseOrderId: po.id, variantId: A.id, qty: 50, unitCostPaise: null}, ctx), ConflictError, 'lines are fixed once the order is sent');
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: po.id, status: 'cancelled', expectedStatus: 'ordered', note: 'test'}, ctx);
  for (let round = 1; round <= 10; round++) {
    const x = await sentPo([{variantId: A.id, qty: 2}]);
    const before = await here(branch, A.id);
    const [got, cancelled] = await Promise.allSettled([receive(inventory, x, [2]), setPurchaseOrderStatus(admin, root, {purchaseOrderId: x.id, status: 'cancelled', expectedStatus: 'ordered', note: 'race'}, ctx)]);
    const s = await poState(x.id);
    assert.notEqual(got.status, cancelled.status, `round ${round}: exactly one of receive and cancel wins`);
    if (got.status === 'fulfilled') assert.deepEqual([s.status, s.receipts, await here(branch, A.id)], ['received', 1, before + 2]);
    else assert.deepEqual([s.status, s.receipts, s.stock_rows, await here(branch, A.id)], ['cancelled', 0, 0, before]);
  }
  assert.deepEqual(await mismatches(), CLEAN);
});

let made;
test('material consumption: only for started orders, through the material ledger, refused when there is not enough; simultaneous requests cannot overdraw', async () => {
  const stock = await matQty(fabric);
  const planned = await createProductionOrder(admin, root, {variantId: B.id, qty: 10, dueOn: null, notes: null}, ctx);
  await setProductionInput(admin, root, {productionOrderId: planned.id, materialId: fabric, qtyPlanned: 12}, ctx);
  assert.equal(await matQty(fabric), stock, 'planning a material takes nothing from stock');
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: planned.id, materialId: fabric, qty: 1}, ctx), ConflictError, 'not before production has started');
  await setProductionStatus(admin, root, {productionOrderId: planned.id, status: 'in_progress', expectedStatus: 'planned', note: null}, ctx);
  made = planned;
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: made.id, materialId: fabric, qty: stock + 1, expectedConsumed: 0}, ctx), e => e instanceof ConflictError && /not enough/.test(e.message));
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: made.id, materialId: fabric, qty: 0}, ctx), DomainError);
  assert.equal(await matQty(fabric), stock, 'refused requests took nothing');
  // Five simultaneous requests that each need more than half of what is there: only one can be served.
  const big = Math.floor(stock / 2) + 1;
  const r = await settled(Array.from({length: 5}, () => consumeMaterial(admin, root, {productionOrderId: made.id, materialId: fabric, qty: big, expectedConsumed: 0}, ctx)));
  assert.equal(r.ok, 1);
  assert.ok(conflicts(r.errors));
  assert.ok(Math.abs((await matQty(fabric)) - (stock - big)) < 1e-9, 'the one that was served took exactly its quantity');
  // Five identical simultaneous small quantities from the same page: they would all fit in stock, and exactly one is recorded.
  const small = await settled(Array.from({length: 5}, () => consumeMaterial(admin, root, {productionOrderId: made.id, materialId: fabric, qty: 0.5, expectedConsumed: big}, ctx)));
  assert.equal(small.ok, 1);
  assert.ok(small.errors.every(stale));
  const used = big + 0.5 * small.ok;
  assert.ok(Math.abs((await matQty(fabric)) - (stock - used)) < 1e-9);
  const rows = await q(`select delta::float d, balance_after::float b, reason, staff_id from material_movements where material_id = $1::uuid and reason = 'consume' and note = $2 order by id`, [fabric, made.number]);
  assert.equal(rows.length, 1 + small.ok, 'one ledger row per recorded use, none for the refused ones');
  assert.ok(Math.abs(rows.reduce((n, x) => n + x.d, 0) + used) < 1e-9);
  assert.ok(Math.abs(rows.at(-1).b - (stock - used)) < 1e-9, 'the last row carries the balance');
  const input = (await q(`select qty_consumed::float c, qty_planned::float p from production_inputs where production_order_id = $1::uuid and material_id = $2::uuid`, [made.id, fabric]))[0];
  assert.ok(Math.abs(input.c - used) < 1e-9, 'the order\'s "used" equals its ledger rows');
  assert.equal((await audits('production_orders', made.id)).filter(a => a === 'production.consume').length, rows.length);
  assert.deepEqual(await mismatches(), CLEAN);
});

test('finished output: the quality check completes the order once; passed pieces enter online stock through the ledger, rejected ones never do', async () => {
  const stock = await onlineQty(B.id);
  await assert.rejects(recordQualityCheck(admin, inventory, {productionOrderId: made.id, passed: 0, rejected: 0, rejectReason: null, note: null}, ctx), DomainError);
  await assert.rejects(recordQualityCheck(admin, inventory, {productionOrderId: made.id, passed: 8, rejected: 2, rejectReason: null, note: null}, ctx), DomainError, 'rejections need a reason');
  const r = await settled(Array.from({length: 5}, () => recordQualityCheck(admin, inventory, {productionOrderId: made.id, passed: 8, rejected: 2, rejectReason: 'stitching', note: null}, ctx)));
  assert.equal(r.ok, 1, 'five simultaneous quality checks: one completes the order');
  assert.ok(conflicts(r.errors));
  assert.equal(await onlineQty(B.id), stock + 8, 'planned 10: 8 passed are in stock, 2 rejected are not');
  const rows = await q(`select delta, balance_after, location_id, staff_id from inventory_movements where variant_id = $1::uuid and reason = 'production_in' and note = $2`, [B.id, made.number]);
  assert.deepEqual(rows.map(x => [x.delta, x.balance_after, x.staff_id]), [[8, stock + 8, inventory.staffId]], 'one ledger row, named after the production order');
  const d = await getProductionOrder(admin, root, made.id);
  assert.deepEqual([d.order.status, d.qc.qty_passed, d.qc.qty_rejected, d.qc.reject_reason, d.next.length, d.canQc], ['completed', 8, 2, 'stitching', 0, false]);
  // There is no partial output: a completed order takes no second quality check, no more material, and cannot be cancelled.
  await assert.rejects(recordQualityCheck(admin, inventory, {productionOrderId: made.id, passed: 2, rejected: 0, rejectReason: null, note: null}, ctx), ConflictError);
  await assert.rejects(consumeMaterial(admin, root, {productionOrderId: made.id, materialId: fabric, qty: 1}, ctx), ConflictError);
  await assert.rejects(setProductionStatus(admin, root, {productionOrderId: made.id, status: 'cancelled', expectedStatus: 'completed', note: 'late'}, ctx), ConflictError);
  assert.equal(await onlineQty(B.id), stock + 8);
  assert.deepEqual(await audits('production_orders', made.id).then(a => a.filter(x => !/consume|input_plan/.test(x))), ['production.create', 'production.start', 'production.complete']);
});

test(`concurrency, output and status: ${QC_ROUNDS} rounds — started once, completed once, one ledger row; a cancelled order adds nothing`, async () => {
  let expected = await onlineQty(B.id);
  for (let round = 1; round <= QC_ROUNDS; round++) {
    const o = await createProductionOrder(admin, root, {variantId: B.id, qty: 1, dueOn: null, notes: null}, ctx);
    const started = await settled(Array.from({length: 5}, () => setProductionStatus(admin, root, {productionOrderId: o.id, status: 'in_progress', expectedStatus: 'planned', note: null}, ctx)));
    assert.equal(started.ok, 1, `round ${round}: started once`);
    assert.ok(conflicts(started.errors));
    const done = await settled(Array.from({length: 5}, () => recordQualityCheck(admin, inventory, {productionOrderId: o.id, passed: 1, rejected: 0, rejectReason: null, note: null}, ctx)));
    assert.equal(done.ok, 1, `round ${round}: completed once`);
    expected += 1;
    assert.equal(await onlineQty(B.id), expected, `round ${round}: one piece entered stock`);
    assert.equal((await q(`select count(*)::int n from inventory_movements where reason = 'production_in' and note = $1`, [o.number]))[0].n, 1);
    assert.equal((await q(`select count(*)::int n from qc_results where production_order_id = $1::uuid`, [o.id]))[0].n, 1);
    assert.deepEqual(await audits('production_orders', o.id), ['production.create', 'production.start', 'production.complete']);
  }
  // Complete against cancel at the same moment: exactly one wins; a cancelled order has no ledger row.
  for (let round = 1; round <= 5; round++) {
    const o = await startedProduction(A.id, 4);
    const before = await onlineQty(A.id);
    const [qc, cancel] = await Promise.allSettled([recordQualityCheck(admin, inventory, {productionOrderId: o.id, passed: 0, rejected: 4, rejectReason: 'test pieces', note: null}, ctx),
      setProductionStatus(admin, root, {productionOrderId: o.id, status: 'cancelled', expectedStatus: 'in_progress', note: 'race'}, ctx)]);
    assert.notEqual(qc.status, cancel.status, `round ${round}: exactly one of complete and cancel wins`);
    assert.equal(await onlineQty(A.id), before, 'no piece passed and none entered stock');
    assert.equal((await q(`select count(*)::int n from inventory_movements where reason = 'production_in' and note = $1`, [o.number]))[0].n, 0);
  }
  assert.deepEqual(await mismatches(), CLEAN);
});

test('audit: the purchase order and the production order carry their whole history in the one audit log', async () => {
  const po = await audits('purchase_orders', main.id);
  assert.deepEqual(po, ['purchase_order.create', 'purchase_order.place', 'purchase_order.receive', 'purchase_order.receive']);
  const meta = await q(`select metadata->>'receipt_number' n, metadata->>'location_id' loc, staff_id from audit_logs where entity_type = 'purchase_orders' and entity_id = $1 and action = 'purchase_order.receive' order by id`, [main.id]);
  assert.ok(meta.every(m => /^GRN/.test(m.n) && m.loc === branch && m.staff_id === inventory.staffId));
  assert.equal((await q(`select count(*)::int n from audit_logs where entity_type = 'materials' and entity_id = $1 and action = 'material.stock_adjust'`, [fabric]))[0].n, 0, 'no manual correction was needed');
  // A recorded correction is the only other way material stock changes; it too is one ledger row and one audit record.
  const stock = await matQty(fabric);
  await adjustMaterialStock(admin, root, {materialId: fabric, delta: -1, reason: 'damage', note: 'offcut'}, ctx);
  assert.equal(await matQty(fabric), stock - 1);
  assert.equal((await q(`select count(*)::int n from audit_logs where entity_type = 'materials' and entity_id = $1 and action = 'material.stock_adjust'`, [fabric]))[0].n, 1);
});

test('afterwards: every stock equals its ledger, no receipt wrote a row twice, and the totals are the expected ones', async () => {
  assert.deepEqual(await mismatches(), CLEAN);
  const dup = await q(`select count(*)::int n from (select goods_receipt_id, variant_id from inventory_movements where goods_receipt_id is not null group by 1, 2 having count(*) > 1) x`);
  assert.equal(dup[0].n, 0, 'one stock-ledger row per receipt and size');
  const dupMat = await q(`select count(*)::int n from (select goods_receipt_id, material_id from material_movements where goods_receipt_id is not null group by 1, 2 having count(*) > 1) x`);
  assert.equal(dupMat[0].n, 0);
  const lines = await q(`select count(*)::int n from purchase_order_lines where qty_received > qty_ordered`);
  assert.equal(lines[0].n, 0, 'no line has received more than was ordered');
  // Received on every order equals what its receipts wrote to the two ledgers.
  const drift = await q(`select count(*)::int n from purchase_orders p where
    (select coalesce(sum(qty_received),0) from purchase_order_lines where purchase_order_id = p.id)
    <> (select coalesce(sum(m.delta),0) from inventory_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id)
     + (select coalesce(sum(m.delta),0) from material_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = p.id)`);
  assert.equal(drift[0].n, 0);
  const online = (await q(`select sum(stock_qty)::int n from product_variants`))[0].n;
  assert.equal(online, 1100 + 8 + QC_ROUNDS, 'online stock rose only by the passed pieces');
});
