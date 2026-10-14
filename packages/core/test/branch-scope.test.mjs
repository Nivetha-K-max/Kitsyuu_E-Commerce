/* Staff branch scope (2026-10-14), against the LOCAL test database: a staff member with no assigned locations works at every
   branch; one with assignments only at those (POS, branch stock and adjustments, transfers, stock counts, branch drafts, and
   the lists of each); staff.manage holders and administrators are never limited. Assignments are made under staff.manage
   and audited. The online stock is never touched; two counter sales are made (one per branch). */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError, NotFoundError} from '@kitsyuu/contracts';
import {
  adjustLocationStock, adjustStock, cancelDraftOrder, cancelTransfer, cancelStockCount, completePosSale, createDraftOrder, createTransfer, getLocationStock, getPosSale, getStaff,
  getStockCount, getTransfer, listDraftOrders, listLocations, listPosBranchStock, listPosSales, listPosSessions, listStockCounts, listTransfers, onlineLocationId,
  openPosSession, openStockCount, posContext, posReport, quotePosSale, receiveTransfer, saveLocation, searchPosProducts, sendTransfer, setStaffLocations, voidPosSale,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'branch-scope.test', requestId: 'test'};
const key = () => randomBytes(16).toString('hex');
const today = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Kolkata'});
const NOT_ASSIGNED = /not assigned to this branch/;

const tokens = new Map();
async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const session = (await acceptStaffInvite(admin, {token, password: 'scope test passphrase', fullName: role}, ctx)).token;
  tokens.set(email, session);
  return validateStaffSession(admin, session);
}
/** The principal as the next request sees it (assignments are read on every request). */
const relog = p => validateStaffSession(admin, tokens.get(p.email));
const variant = async sku => (await q(`select v.id, v.sku from product_variants v where v.sku = $1`, [sku]))[0];
async function sell(actor, sessionId, locationId, lines) {
  const quote = await quotePosSale(admin, actor, {locationId, lines, discount: null});
  return completePosSale(admin, actor, {sessionId, idempotencyKey: key(), lines, discount: null, contact: {name: 'Walk-in', phone: null},
    payment: {method: 'cash', tenderedPaise: quote.totals.totalPaise}, expectedTotalPaise: quote.totals.totalPaise}, ctx);
}

let root, adminUser, manager, cashier, free, online, A, B, C, V1, V2;
let saleA, saleB;
before(async () => {
  root = await staff('scope.root@test.local', 'super_admin');
  adminUser = await staff('scope.admin@test.local', 'admin');
  manager = await staff('scope.manager@test.local', 'manager');
  cashier = await staff('scope.cashier@test.local', 'sales');
  free = await staff('scope.free@test.local', 'sales');
  online = await onlineLocationId(admin);
  A = (await saveLocation(admin, root, {code: 'SCOPE-A', name: 'Scope A', kind: 'retail', address: 'A street', active: true}, ctx)).id;
  B = (await saveLocation(admin, root, {code: 'SCOPE-B', name: 'Scope B', kind: 'retail', address: 'B street', active: true}, ctx)).id;
  C = (await saveLocation(admin, root, {code: 'SCOPE-W', name: 'Scope Warehouse', kind: 'warehouse', address: null, active: true}, ctx)).id;
  [V1, V2] = await Promise.all(['KTS-TOP-001-M', 'KTS-BTM-001-L'].map(variant));
  for (const v of [V1, V2]) assert.ok(v, 'catalogue seed sizes exist');
  for (const loc of [A, B, C]) for (const v of [V1, V2])
    await adjustLocationStock(admin, root, {locationId: loc, variantId: v.id, delta: 5, reason: 'restock', note: 'scope test stock', expectedQty: 0}, ctx);
});
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

test('unassigned staff are unrestricted: every branch, as before', async () => {
  assert.equal(free.locationIds, null);
  const c = await posContext(admin, free);
  assert.ok(['Scope A', 'Scope B'].every(n => c.locations.some(l => l.name === n)));
  await openPosSession(admin, free, {locationId: B, openingCashPaise: 0}, ctx);
  const s = (await posContext(admin, free)).session;
  saleB = await sell(free, s.id, B, [{variantId: V1.id, qty: 1}]);
  assert.ok((await listLocations(admin, manager)).some(l => l.is_online), 'the online location too');
});

test('assigning branches: staff.manage only, audited; none = all branches; unknown locations refused', async () => {
  await assert.rejects(setStaffLocations(admin, manager, {staffId: cashier.staffId, locationIds: [A]}, ctx), ForbiddenError);
  await assert.rejects(setStaffLocations(admin, root, {staffId: cashier.staffId, locationIds: ['00000000-0000-4000-8000-000000000000']}, ctx), NotFoundError);
  await setStaffLocations(admin, root, {staffId: cashier.staffId, locationIds: [A]}, ctx);
  await setStaffLocations(admin, root, {staffId: manager.staffId, locationIds: [B]}, ctx);
  const audit = await q(`select before_data as before, after_data as after from audit_logs where action = 'staff.locations_update' and entity_id = $1`, [cashier.staffId]);
  assert.equal(audit.length, 1); assert.deepEqual(audit[0].before, {locations: []}); assert.deepEqual(audit[0].after, {locations: ['SCOPE-A']});
  const g = await getStaff(admin, root, cashier.staffId);
  assert.deepEqual(g.locations.map(l => l.code), ['SCOPE-A']); assert.equal(g.alwaysAllBranches, false);
  cashier = await relog(cashier); manager = await relog(manager);
  assert.deepEqual([...cashier.locationIds], [A]);
  assert.deepEqual([...manager.locationIds], [B]);
  // the same list again changes nothing (no second audit row); an empty list makes them unrestricted again
  await setStaffLocations(admin, root, {staffId: cashier.staffId, locationIds: [A]}, ctx);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'staff.locations_update' and entity_id = $1`, [cashier.staffId]))[0].n, 1);
  await setStaffLocations(admin, root, {staffId: free.staffId, locationIds: [A]}, ctx);
  await setStaffLocations(admin, root, {staffId: free.staffId, locationIds: []}, ctx);
  assert.equal((await relog(free)).locationIds, null);
});

test('a cashier assigned to Scope A opens, searches, quotes and sells there, and is refused at Scope B', async () => {
  assert.deepEqual((await posContext(admin, cashier)).locations.map(l => l.name), ['Scope A'], 'only their branch is offered');
  await assert.rejects(openPosSession(admin, cashier, {locationId: B, openingCashPaise: 0}, ctx), NOT_ASSIGNED);
  await assert.rejects(searchPosProducts(admin, cashier, {locationId: B, q: V1.sku}), ForbiddenError);
  await assert.rejects(listPosBranchStock(admin, cashier, {locationId: B}), ForbiddenError);
  await assert.rejects(quotePosSale(admin, cashier, {locationId: B, lines: [{variantId: V1.id, qty: 1}], discount: null}), ForbiddenError);
  assert.equal((await searchPosProducts(admin, cashier, {locationId: A, q: V1.sku})).exact.stock, 5);
  await openPosSession(admin, cashier, {locationId: A, openingCashPaise: 0}, ctx);
  const s = (await posContext(admin, cashier)).session;
  assert.equal(s.location_id, A);
  saleA = await sell(cashier, s.id, A, [{variantId: V2.id, qty: 1}]);
  await assert.rejects(getPosSale(admin, cashier, saleB.orderId), ForbiddenError, 'another branch’s bill');
  assert.equal((await getPosSale(admin, cashier, saleA.orderId)).sale.pos_number, saleA.posNumber);
});

test('lists are limited to the staff member’s branches; another branch’s sale cannot be voided', async () => {
  const sessions = await listPosSessions(admin, manager, {all: true});
  assert.ok(sessions.length >= 1); assert.ok(sessions.every(s => s.location_name === 'Scope B'));
  const sales = await listPosSales(admin, manager);
  assert.deepEqual(sales.map(s => s.id), [saleB.orderId]);
  const report = await posReport(admin, manager, {from: today, to: today});
  assert.deepEqual(report.byLocation.map(l => l.name), ['Scope B']); assert.equal(report.transactions, 1);
  await assert.rejects(posReport(admin, manager, {from: today, to: today, locationId: A}), ForbiddenError);
  await assert.rejects(voidPosSale(admin, manager, {orderId: saleA.orderId, reason: 'not my branch'}, ctx), NOT_ASSIGNED);
  assert.equal((await q(`select status from orders where id = $1`, [saleA.orderId]))[0].status, 'delivered', 'nothing changed');
  // an administrator still sees both branches
  assert.deepEqual((await posReport(admin, root, {from: today, to: today})).byLocation.map(l => l.name).sort(), ['Scope A', 'Scope B']);
});

test('branch stock: only assigned locations are listed, shown and adjusted (the online location included)', async () => {
  assert.deepEqual((await listLocations(admin, manager)).map(l => l.id), [B]);
  await assert.rejects(getLocationStock(admin, manager, {locationId: A}), ForbiddenError);
  assert.equal((await getLocationStock(admin, manager, {locationId: B})).location.id, B);
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: A, variantId: V1.id, delta: 1, reason: 'restock', note: null, expectedQty: 5}, ctx), NOT_ASSIGNED);
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: online, variantId: V1.id, delta: 1, reason: 'restock', note: null, expectedQty: 10}, ctx), NOT_ASSIGNED);
  await assert.rejects(adjustStock(admin, manager, {variantId: V1.id, direction: 'increase', quantity: 1, reason: 'restock', note: null, expectedQty: 10}, ctx), NOT_ASSIGNED);
  await adjustLocationStock(admin, manager, {locationId: B, variantId: V2.id, delta: 1, reason: 'restock', note: 'own branch', expectedQty: 5}, ctx);
});

test('transfers: created and sent from an assigned source, received at an assigned destination; only transfers touching their branches', async () => {
  const line = [{variantId: V2.id, qty: 1}];
  await assert.rejects(createTransfer(admin, manager, {fromLocationId: A, toLocationId: B, note: null, lines: line}, ctx), NOT_ASSIGNED);
  const out = await createTransfer(admin, manager, {fromLocationId: B, toLocationId: A, note: null, lines: line}, ctx);   // to anywhere
  await sendTransfer(admin, manager, {transferId: out.id}, ctx);
  await assert.rejects(receiveTransfer(admin, manager, {transferId: out.id}, ctx), NOT_ASSIGNED, 'received at Scope A, not theirs');
  await receiveTransfer(admin, root, {transferId: out.id}, ctx);
  const elsewhere = await createTransfer(admin, root, {fromLocationId: A, toLocationId: C, note: null, lines: line}, ctx);
  await assert.rejects(sendTransfer(admin, manager, {transferId: elsewhere.id}, ctx), NOT_ASSIGNED);
  await assert.rejects(getTransfer(admin, manager, elsewhere.id), ForbiddenError);
  const incoming = await createTransfer(admin, root, {fromLocationId: C, toLocationId: B, note: null, lines: line}, ctx);
  await sendTransfer(admin, root, {transferId: incoming.id}, ctx);
  await receiveTransfer(admin, manager, {transferId: incoming.id}, ctx);
  const seen = (await listTransfers(admin, manager)).map(t => t.id).sort();
  assert.deepEqual(seen, [out.id, incoming.id].sort());
  assert.equal((await listTransfers(admin, root)).length, 3);
});

test('cancelling a transfer: the receiving branch only while it is a draft (no stock moved); the sending branch as before', async () => {
  // The manager is assigned to Scope B only; a second manager works at the warehouse (Scope W) only.
  let wh = await staff('scope.warehouse@test.local', 'manager');
  await setStaffLocations(admin, root, {staffId: wh.staffId, locationIds: [C]}, ctx);
  wh = await relog(wh);
  const line = [{variantId: V1.id, qty: 2}];
  const at = async (loc, v = V1) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, v.id]))[0].n;
  const moves = async id => (await q(`select count(*)::int n from inventory_movements where transfer_id = $1`, [id]))[0].n;
  const status = async id => (await q(`select status from stock_transfers where id = $1`, [id]))[0].status;
  const c0 = await at(C), b0 = await at(B);

  // 1. A draft W → B: the receiving branch may cancel it; nothing was posted, nothing moves; audited as the receiving side.
  const draft = await createTransfer(admin, wh, {fromLocationId: C, toLocationId: B, note: null, lines: line}, ctx);
  await assert.rejects(cancelTransfer(admin, manager, {transferId: draft.id, note: '  '}, ctx), /Give a reason/);
  assert.deepEqual(await cancelTransfer(admin, manager, {transferId: draft.id, note: 'Not needed at B'}, ctx), {unitsReturned: 0});
  assert.equal(await status(draft.id), 'cancelled');
  assert.deepEqual([await moves(draft.id), await at(C), await at(B)], [0, c0, b0], 'no stock movement');
  const [a] = await q(`select staff_id, before_data as before, after_data as after, metadata from audit_logs where action = 'transfer.cancel' and entity_id = $1`, [draft.id]);
  assert.deepEqual([a.staff_id, a.before.status, a.after.status, a.metadata.cancelled_by, a.metadata.note], [manager.staffId, 'draft', 'cancelled', 'receiving branch', 'Not needed at B']);
  await assert.rejects(cancelTransfer(admin, manager, {transferId: draft.id, note: 'again'}, ctx), /already closed/);

  // 2. Once sent, the stock has left the sender: the receiving branch can no longer cancel it (nothing changes) ...
  const sent = await createTransfer(admin, wh, {fromLocationId: C, toLocationId: B, note: null, lines: line}, ctx);
  await sendTransfer(admin, wh, {transferId: sent.id}, ctx);
  assert.equal(await at(C), c0 - 2, 'in transit');
  await assert.rejects(cancelTransfer(admin, manager, {transferId: sent.id, note: 'Wrong pieces'}, ctx), /only the sending branch can cancel it/);
  assert.deepEqual([await status(sent.id), await moves(sent.id), await at(C), await at(B)], ['sent', 1, c0 - 2, b0]);
  // ... and the sending branch still can, exactly as before: its stock comes back.
  assert.deepEqual(await cancelTransfer(admin, wh, {transferId: sent.id, note: 'Recalled'}, ctx), {unitsReturned: 2});
  assert.deepEqual([await status(sent.id), await at(C), await at(B)], ['cancelled', c0, b0]);
  assert.equal((await q(`select metadata from audit_logs where action = 'transfer.cancel' and entity_id = $1`, [sent.id]))[0].metadata.cancelled_by, 'sending branch');

  // 3. A sending branch keeps cancelling its drafts; a branch on neither side cannot touch a transfer; a received one is closed.
  const own = await createTransfer(admin, wh, {fromLocationId: C, toLocationId: A, note: null, lines: line}, ctx);
  await assert.rejects(cancelTransfer(admin, manager, {transferId: own.id, note: 'not ours'}, ctx), /not assigned to either branch/);
  await cancelTransfer(admin, wh, {transferId: own.id, note: 'Changed plan'}, ctx);
  const done = await createTransfer(admin, wh, {fromLocationId: C, toLocationId: B, note: null, lines: [{variantId: V1.id, qty: 1}]}, ctx);
  await sendTransfer(admin, wh, {transferId: done.id}, ctx);
  await receiveTransfer(admin, manager, {transferId: done.id}, ctx);
  await assert.rejects(cancelTransfer(admin, manager, {transferId: done.id, note: 'too late'}, ctx), /already closed/);
  assert.deepEqual([await at(C), await at(B)], [c0 - 1, b0 + 1]);

  // 4. The sender sends while the receiver cancels the same draft, at the same moment: exactly one of them happens, and the
  //    stock matches it (rounds, because it is a race).
  for (let round = 0; round < 5; round++) {
    const c1 = await at(C), b1 = await at(B);
    const t = await createTransfer(admin, wh, {fromLocationId: C, toLocationId: B, note: null, lines: [{variantId: V1.id, qty: 1}]}, ctx);
    const [s, x] = await Promise.allSettled([sendTransfer(admin, wh, {transferId: t.id}, ctx), cancelTransfer(admin, manager, {transferId: t.id, note: 'race'}, ctx)]);
    assert.equal([s, x].filter(r => r.status === 'fulfilled').length, 1, `round ${round}: one of them`);
    const st = await status(t.id);
    if (s.status === 'fulfilled') {
      assert.deepEqual([st, await at(C), await moves(t.id)], ['sent', c1 - 1, 1]);
      await cancelTransfer(admin, wh, {transferId: t.id, note: 'tidy up'}, ctx);   // back to the sender for the next round
    } else assert.deepEqual([st, await at(C), await moves(t.id)], ['cancelled', c1, 0]);
    assert.equal(await at(B), b1);
  }
  // Every location's stock still equals its ledger rows.
  assert.equal((await q(`select count(*)::int n from location_stock s where s.qty <> (select coalesce(sum(m.delta), 0) from inventory_movements m
    where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)`))[0].n, 0);
});

test('stock counts: opened, seen and listed only at assigned locations', async () => {
  await assert.rejects(openStockCount(admin, manager, {note: null, locationId: A}, ctx), NOT_ASSIGNED);
  await assert.rejects(openStockCount(admin, manager, {note: null, locationId: null}, ctx), NOT_ASSIGNED, 'no location = the online one');
  const mine = await openStockCount(admin, manager, {note: null, locationId: B}, ctx);
  const theirs = await openStockCount(admin, root, {note: null, locationId: A}, ctx);
  await assert.rejects(getStockCount(admin, manager, theirs.id), ForbiddenError);
  await assert.rejects(cancelStockCount(admin, manager, {stockCountId: theirs.id}, ctx), ForbiddenError);
  assert.deepEqual((await listStockCounts(admin, manager)).map(c => c.id), [mine.id]);
  await cancelStockCount(admin, manager, {stockCountId: mine.id}, ctx);
  await cancelStockCount(admin, root, {stockCountId: theirs.id}, ctx);
});

test('branch draft orders: started, opened and listed only at assigned branches', async () => {
  await assert.rejects(createDraftOrder(admin, cashier, {channel: 'retail', locationId: B, contact: {name: 'Priya'}}, ctx), NOT_ASSIGNED);
  const d = await createDraftOrder(admin, cashier, {channel: 'retail', locationId: A, contact: {name: 'Priya'}}, ctx);
  assert.ok(!(await listDraftOrders(admin, manager)).some(x => x.id === d.id), 'a Scope A draft is not listed for Scope B');
  assert.ok((await listDraftOrders(admin, root)).some(x => x.id === d.id));
  await cancelDraftOrder(admin, cashier, {draftId: d.id}, ctx);
});

test('administrators and staff.manage holders are never limited, whatever is assigned', async () => {
  await setStaffLocations(admin, root, {staffId: adminUser.staffId, locationIds: [A]}, ctx);
  await setStaffLocations(admin, root, {staffId: root.staffId, locationIds: [A]}, ctx);
  adminUser = await relog(adminUser); root = await relog(root);
  assert.equal(adminUser.locationIds, null); assert.equal(root.locationIds, null);
  assert.equal((await getStaff(admin, root, adminUser.staffId)).alwaysAllBranches, true);
  assert.ok((await posContext(admin, adminUser)).locations.some(l => l.id === B));
  assert.ok((await listLocations(admin, adminUser)).some(l => l.is_online));
  assert.equal((await getLocationStock(admin, adminUser, {locationId: B})).location.id, B);
  // a principal built without the field (older callers, tests) is unrestricted too
  const {locationIds: _, ...plain} = manager;
  assert.equal((await getLocationStock(admin, plain, {locationId: A})).location.id, A);
});
