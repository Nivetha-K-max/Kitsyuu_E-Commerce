/* Phase 8 (2026-10-08): stock integrity under repeats and concurrency, against the LOCAL test database.
   Everything goes through the existing services (adjustStock, adjustLocationStock, the transfer functions), which write
   the stock ledger; the test then checks the ledger against the stock, not the other way round.
   Covers: the stale-data check and repeated / simultaneous adjustments, no negative stock, transfers (validation, sent
   once, received once, cancelled once, nothing created or lost), permissions on the server, the low-stock rule, and that
   stock equals the sum of its ledger rows at every location afterwards.
   Net effect (run-e2e.mjs expects it): 4 units moved from the online location to a new branch and left there.
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/inventory-integrity.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, ForbiddenError, adjustStockInput, settingUpdateInput} from '@kitsyuu/contracts';
import {adjustLocationStock, adjustStock, cancelTransfer, createTransfer, getLocationStock, getTransfer, listLocations, listStock, onlineLocationId, receiveTransfer, saveLocation, sendTransfer, updateSetting} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 12});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'inventory.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'inventory test passphrase', fullName: role}, ctx)).token);
}
const settled = async calls => { const r = await Promise.allSettled(calls); return {ok: r.filter(x => x.status === 'fulfilled').length, errors: r.filter(x => x.status === 'rejected').map(x => x.reason)}; };
const onlineQty = async id => (await q(`select stock_qty from product_variants where id = $1`, [id]))[0].stock_qty;
const here = async (loc, variant) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, variant]))[0].n;
const rowsOf = async (variant, where = 'true') => (await q(`select delta, reason, balance_after, location_id, transfer_id, staff_id from inventory_movements where variant_id = $1 and ${where} order by id`, [variant]));
/** Stock equals the sum of its ledger rows: the online stock and every location's stock (the same check as run-e2e.mjs). */
const mismatches = async () => (await q(`select
  (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online))))
  + (select count(*)::int from location_stock s where s.qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)) n,
  (select count(*)::int from location_stock where qty < 0) + (select count(*)::int from product_variants where stock_qty < 0) negative`))[0];
const everywhere = async variant => (await q(`select (select coalesce(sum(qty),0)::int from location_stock where variant_id = $1) n`, [variant]))[0].n;

let root, support, online, branch, A, B;
before(async () => {
  root = await staff('inv.root@test.local', 'super_admin');
  support = await staff('inv.support@test.local', 'support');     // inventory.read only
  online = await onlineLocationId(admin);
  branch = (await saveLocation(admin, root, {code: 'RB-INT', name: 'Integrity Branch', kind: 'retail', address: null, active: true}, ctx)).id;
  [A, B] = await owner.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').select(['v.id', 'v.sku', 'v.stock_qty']).where('p.status', '=', 'active').orderBy('v.sku').limit(2).execute();
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

test('baseline: stock equals the ledger everywhere; there is one online location and its stock is the store\'s', async () => {
  assert.deepEqual(await mismatches(), {n: 0, negative: 0});
  const locs = await listLocations(admin, root);
  assert.equal(locs.filter(l => l.is_online).length, 1);
  assert.equal(await here(online, A.id), await onlineQty(A.id), 'the online location\'s row is the store\'s stock');
});

test('online adjustment: needs the permission, a listed reason and the quantity the person saw; one ledger row and one audit row each', async () => {
  const start = await onlineQty(A.id);
  const input = over => adjustStockInput.parse({variantId: A.id, direction: 'decrease', quantity: 2, reason: 'damage', note: 'integrity', expectedQty: start, ...over});
  await assert.rejects(adjustStock(admin, support, input(), ctx), ForbiddenError, 'inventory.read alone cannot adjust');
  await assert.rejects(adjustStock(admin, root, input({reason: 'sale'}), ctx), /listed reasons/, 'system reasons are not for staff');
  await assert.rejects(adjustStock(admin, root, input({expectedQty: start + 1}), ctx), ConflictError, 'stale quantity is refused');
  await assert.rejects(adjustStock(admin, root, input({quantity: start + 1}), ctx), /below zero/, 'never below zero');
  assert.equal(await onlineQty(A.id), start, 'nothing changed by any refused attempt');

  // The same adjustment submitted five times at once (a double click, two tabs, a retried request): applied once.
  const five = await settled(Array.from({length: 5}, () => adjustStock(admin, root, input(), ctx)));
  assert.equal(five.ok, 1, 'exactly one of five identical simultaneous adjustments is applied');
  assert.ok(five.errors.every(e => e instanceof ConflictError), 'the others are told the stock changed');
  assert.equal(await onlineQty(A.id), start - 2);
  const rows = await rowsOf(A.id, `note = 'integrity'`);
  assert.deepEqual(rows.map(r => [r.delta, r.reason, r.balance_after]), [[-2, 'damage', start - 2]], 'one ledger row, with the balance after it');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'inventory.adjust' and entity_id = $1`, [A.id]))[0].n, 1, 'one audit record, with the staff member');
  // put it back (a restock), so the baseline of this size is unchanged
  await adjustStock(admin, root, adjustStockInput.parse({variantId: A.id, direction: 'increase', quantity: 2, reason: 'restock', note: 'integrity back', expectedQty: start - 2}), ctx);
  assert.equal(await onlineQty(A.id), start);
});

test('location adjustment: same rules at a branch; simultaneous identical submissions apply once; stock never goes negative', async () => {
  const adj = (delta, expectedQty, actor = root, reason = delta > 0 ? 'restock' : 'damage') => adjustLocationStock(admin, actor, {locationId: branch, variantId: B.id, delta, reason, note: 'branch integrity', expectedQty}, ctx);
  await assert.rejects(adj(5, 0, support), ForbiddenError);
  await assert.rejects(adj(0, 0), /whole number other than 0/);
  await assert.rejects(adj(5, 3), ConflictError, 'stale quantity is refused');
  assert.deepEqual(await adj(10, 0), {balance: 10});
  const onlineBefore = await onlineQty(B.id);

  const five = await settled(Array.from({length: 5}, () => adj(-3, 10)));
  const left = await here(branch, B.id);
  assert.equal(left, 10 - 3 * five.ok, 'the stock is exactly what the applied adjustments say');
  assert.equal((await rowsOf(B.id, `location_id = '${branch}' and delta = -3`)).length, five.ok, 'one ledger row per applied adjustment, none for a refused one');
  assert.equal(five.ok, 1, 'exactly one of five identical simultaneous adjustments is applied');
  assert.ok(five.errors.every(e => e instanceof ConflictError));

  // More than is there, asked for by six people at once with the right quantity in front of them: at most one wins, never negative.
  const six = await settled(Array.from({length: 6}, () => adj(-left, left)));
  assert.equal(six.ok, 1);
  assert.equal(await here(branch, B.id), 0);
  await assert.rejects(adj(-1, 0), /Not enough stock/, 'nothing to take: refused');
  assert.equal(await onlineQty(B.id), onlineBefore, 'a branch adjustment never touches the online store\'s stock');
  assert.deepEqual(await mismatches(), {n: 0, negative: 0});
});

test('repeated: 30 rounds of five identical simultaneous adjustments — each round exactly one ledger row, one audit row, the exact balance; refused requests leave nothing', async () => {
  const ROUNDS = Number(process.env.INVENTORY_STRESS_ROUNDS ?? 30);
  const [C] = await owner.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').select(['v.id', 'v.sku']).where('p.status', '=', 'active').orderBy('v.sku').offset(2).limit(1).execute();
  const state = async () => (await q(`select
    (select coalesce((select qty from location_stock where location_id = $1::uuid and variant_id = $2::uuid), 0)::int) qty,
    (select count(*)::int from inventory_movements where location_id = $1::uuid and variant_id = $2::uuid) moves,
    (select coalesce(sum(delta), 0)::int from inventory_movements where location_id = $1::uuid and variant_id = $2::uuid) ledger_sum,
    (select count(*)::int from audit_logs where action = 'inventory.location_adjust' and entity_id::text = $2::text and metadata->>'location_id' = $1::text) audits,
    (select stock_qty from product_variants where id = $2::uuid) online`, [branch, C.id]))[0];
  const start = await state();
  assert.deepEqual([start.qty, start.moves, start.audits], [0, 0, 0], 'a size nothing has happened to at this branch');
  const adj = (delta, expectedQty, note) => adjustLocationStock(admin, root, {locationId: branch, variantId: C.id, delta, reason: delta > 0 ? 'restock' : 'correction', note, expectedQty}, ctx);
  let qty = 0, moves = 0;
  const seen = {applied: 0, refused: 0, other: 0};
  for (let round = 1; round <= ROUNDS; round++) {
    // odd rounds add, even rounds take away (so the stock also goes down under contention); the amount differs per round
    const delta = round % 2 ? 2 + (round % 5) : -Math.min(qty, 1 + (round % 3)) || 3;
    const note = `stress round ${round}`;
    const r = await settled(Array.from({length: 5}, () => adj(delta, qty, note)));
    seen.applied += r.ok; seen.refused += r.errors.filter(e => e instanceof ConflictError).length; seen.other += r.errors.filter(e => !(e instanceof ConflictError)).length;
    assert.equal(r.ok, 1, `round ${round}: exactly one of five is applied`);
    assert.ok(r.errors.length === 4 && r.errors.every(e => e instanceof ConflictError && /changed since you opened/.test(e.message)), `round ${round}: the other four are refused as out of date, nothing else goes wrong`);
    qty += delta; moves += 1;
    const now = await state();
    assert.deepEqual([now.qty, now.moves, now.ledger_sum, now.audits], [qty, moves, qty, moves], `round ${round}: stock, ledger rows, ledger sum and audit rows are exactly one step on`);
    const [last] = await q(`select delta, balance_after, note, staff_id from inventory_movements where location_id = $1 and variant_id = $2 order by id desc limit 1`, [branch, C.id]);
    assert.deepEqual([last.delta, last.balance_after, last.note, last.staff_id], [delta, qty, note, root.staffId], `round ${round}: the one ledger row is this adjustment, with the balance after it`);
    assert.equal((await q(`select count(*)::int n from inventory_movements where location_id = $1 and variant_id = $2 and note = $3`, [branch, C.id, note]))[0].n, 1, `round ${round}: one row for the round, not one per request`);
  }
  assert.deepEqual(seen, {applied: ROUNDS, refused: ROUNDS * 4, other: 0});

  // Five DIFFERENT adjustments at the same moment, all made from the same (now stale for four of them) quantity: one applies.
  const mixed = await settled([1, 2, 3, 4, 5].map(d => adj(d, qty, 'stress mixed')));
  assert.equal(mixed.ok, 1);
  const afterMixed = await state();
  const [won] = await q(`select delta, balance_after from inventory_movements where location_id = $1 and variant_id = $2 and note = 'stress mixed'`, [branch, C.id]);
  assert.deepEqual([afterMixed.qty, afterMixed.moves, afterMixed.audits], [qty + won.delta, moves + 1, moves + 1], 'only the winner\'s amount is in the stock; one ledger row and one audit row for it');
  assert.equal(won.balance_after, qty + won.delta);

  // A request that fails inside the transaction AFTER the lock (more than is there) leaves nothing behind: no row, no quantity change, no audit record.
  const before = await state();
  const over = await settled(Array.from({length: 5}, () => adj(-(before.qty + 1), before.qty, 'stress too many')));
  assert.equal(over.ok, 0);
  assert.ok(over.errors.every(e => e instanceof ConflictError));
  assert.deepEqual(await state(), before, 'refused requests wrote nothing at all');
  assert.equal((await q(`select count(*)::int n from inventory_movements where note = 'stress too many'`))[0].n, 0);

  // Put the branch back to nothing for this size (one correction), and check the online stock was never touched.
  await adj(-before.qty, before.qty, 'stress put back');
  const end = await state();
  assert.deepEqual([end.qty, end.ledger_sum, end.online], [0, 0, start.online]);
  assert.deepEqual(await mismatches(), {n: 0, negative: 0});
});

let transferId;
test('transfer: validated; a draft moves nothing; sent once (stock leaves), received once (stock arrives); nothing created or lost', async () => {
  const startOnline = await onlineQty(A.id), startBranch = await here(branch, A.id), total = await everywhere(A.id);
  const mk = (lines, from = online, to = branch, actor = root) => createTransfer(admin, actor, {fromLocationId: from, toLocationId: to, note: 'integrity', lines}, ctx);
  await assert.rejects(mk([{variantId: A.id, qty: 4}], online, branch, support), ForbiddenError);
  await assert.rejects(mk([{variantId: A.id, qty: 4}], online, online), /two different locations/);
  await assert.rejects(mk([{variantId: A.id, qty: 0}]), /at least one size/);
  await assert.rejects(mk([{variantId: A.id, qty: 1.5}]), /whole numbers/);
  await assert.rejects(mk([{variantId: A.id, qty: 1}, {variantId: A.id, qty: 2}]), /listed twice/);

  // more than the source holds: the draft can be written down, but it cannot be sent, and nothing moves
  const tooMany = await mk([{variantId: A.id, qty: startOnline + 5}]);
  await assert.rejects(sendTransfer(admin, root, {transferId: tooMany.id}, ctx), /Not enough stock/);
  assert.equal((await getTransfer(admin, root, tooMany.id)).transfer.status, 'draft');
  assert.deepEqual([await onlineQty(A.id), await here(branch, A.id)], [startOnline, startBranch], 'a transfer that cannot be sent moves nothing');
  await cancelTransfer(admin, root, {transferId: tooMany.id, note: 'test'}, ctx);

  const t = await mk([{variantId: A.id, qty: 4}]);
  transferId = t.id;
  assert.deepEqual([await onlineQty(A.id), await here(branch, A.id)], [startOnline, startBranch], 'a draft moves nothing');
  await assert.rejects(receiveTransfer(admin, root, {transferId: t.id}, ctx), /Only a sent transfer/, 'the stages are kept: a draft cannot be received');
  await assert.rejects(sendTransfer(admin, support, {transferId: t.id}, ctx), ForbiddenError);

  const sends = await settled(Array.from({length: 4}, () => sendTransfer(admin, root, {transferId: t.id}, ctx)));
  assert.equal(sends.ok, 1, 'sent exactly once however many times it is asked');
  assert.deepEqual([await onlineQty(A.id), await here(branch, A.id)], [startOnline - 4, startBranch], 'sent: the stock has left the sender and is in transit');
  const recvs = await settled(Array.from({length: 4}, () => receiveTransfer(admin, root, {transferId: t.id}, ctx)));
  assert.equal(recvs.ok, 1, 'received exactly once');
  assert.deepEqual([await onlineQty(A.id), await here(branch, A.id)], [startOnline - 4, startBranch + 4]);
  assert.equal(await everywhere(A.id), total, 'the same number of pieces exist as before: none created, none lost');
  const rows = await rowsOf(A.id, `transfer_id = '${t.id}'`);
  assert.deepEqual(rows.map(r => [r.delta, r.reason, r.location_id]), [[-4, 'transfer_out', online], [4, 'transfer_in', branch]], 'two ledger rows, each with its location and the transfer');
  assert.ok(rows.every(r => r.staff_id === root.staffId));
  await assert.rejects(cancelTransfer(admin, root, {transferId: t.id, note: 'late'}, ctx), /already closed/, 'a received transfer cannot be cancelled');
});

test('transfer cancelled after sending: the stock goes back to the sender, once', async () => {
  const startOnline = await onlineQty(B.id);
  const t = await createTransfer(admin, root, {fromLocationId: online, toLocationId: branch, note: null, lines: [{variantId: B.id, qty: 3}]}, ctx);
  await sendTransfer(admin, root, {transferId: t.id}, ctx);
  assert.equal(await onlineQty(B.id), startOnline - 3);
  const cancels = await settled(Array.from({length: 3}, () => cancelTransfer(admin, root, {transferId: t.id, note: 'changed our minds'}, ctx)));
  assert.equal(cancels.ok, 1, 'cancelled exactly once');
  assert.equal(await onlineQty(B.id), startOnline, 'the pieces are back at the sender, once');
  assert.equal(await here(branch, B.id), 0, 'and never reached the branch');
  assert.deepEqual((await rowsOf(B.id, `transfer_id = '${t.id}'`)).map(r => r.delta), [-3, 3]);
});

test('the movement history a location shows is the ledger: same rows, same balances', async () => {
  const {movements} = await getLocationStock(admin, root, {locationId: branch});
  const ledger = await q(`select m.id, m.delta, m.balance_after from inventory_movements m where m.location_id = $1 order by m.created_at desc, m.id desc limit 50`, [branch]);
  assert.deepEqual(movements.map(m => [Number(m.id), m.delta, m.balance_after]), ledger.map(m => [Number(m.id), m.delta, m.balance_after]));
  assert.ok(movements.every(m => m.balance_before === m.balance_after - m.delta));
});

test('low stock follows the configured rule (the size\'s reorder level, else the low-stock setting), nothing else', async () => {
  const status = async () => (await listStock(admin, root, {status: 'all', q: A.sku})).rows.find(r => r.variant_id === A.id).stock_status;
  const qty = await onlineQty(A.id);
  assert.equal(await status(), 'in_stock');
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'inventory.low_stock_threshold', value: String(qty)}), ctx);
  assert.equal(await status(), 'low_stock', 'at or below the configured level');
  assert.ok((await listStock(admin, root, {status: 'attention'})).rows.some(r => r.variant_id === A.id));
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'inventory.low_stock_threshold', value: String(qty - 1)}), ctx);
  assert.equal(await status(), 'in_stock', 'above it');
  await q(`update product_variants set reorder_level = $2 where id = $1`, [A.id, qty + 2]);        // the size's own level wins
  assert.equal(await status(), 'low_stock');
  await q(`update product_variants set reorder_level = null where id = $1`, [A.id]);
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'inventory.low_stock_threshold', value: '0'}), ctx);
  assert.equal(await onlineQty(A.id), qty, 'looking at stock levels never changes stock');
});

test('afterwards: stock equals the sum of its ledger rows at every location; nothing negative; 4 pieces now at the branch', async () => {
  assert.deepEqual(await mismatches(), {n: 0, negative: 0});
  assert.equal((await q(`select coalesce(sum(stock_qty),0)::int n from product_variants`))[0].n, 1096);
  assert.equal((await q(`select coalesce(sum(qty),0)::int n from location_stock where location_id = $1`, [branch]))[0].n, 4);
  assert.equal((await getTransfer(admin, root, transferId)).transfer.status, 'received');
});
