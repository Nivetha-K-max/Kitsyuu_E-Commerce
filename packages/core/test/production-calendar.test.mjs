/* Production calendar: milestones and tasks (2026-10-12), against the LOCAL test database only.
   Covered: nothing is created automatically (a new production order and a customer order have no entries); one
   "Ready for Trial" and one "Ex-Factory" per production order, never twice (also when two people add at once); the two
   milestones are refused on a customer order, by the service and by the database; tasks on either; changing, completing,
   reopening, removing; the calendar's period, order and "no duplicates"; cancelled orders drop out; permissions; audit.
   Services run as the real kitsyuu_admin role; setup and checks use the owner connection.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/production-calendar.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, milestoneDoneInput, milestoneInput} from '@kitsyuu/contracts';
import {calendarToday, createProductionOrder, deleteMilestone, listMilestones, productionCalendar, saveMilestone, setMilestoneDone, setProductionStatus} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'production-calendar.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'calendar test passphrase', fullName: role}, ctx)).token);
}
// Days relative to today in the business's time zone, so "overdue" is tested against the same clock the service uses.
const day = n => { const d = new Date(`${calendarToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const add = (actor, input) => saveMilestone(db, actor, {title: null, note: null, ...input}, ctx);
const rowsOf = id => q(`select kind, title, to_char(due_on, 'YYYY-MM-DD') due, done_at is not null done from production_milestones where production_order_id = $1 order by due_on, created_at`, [id]);
const total = async () => (await q(`select count(*)::int n from production_milestones`))[0].n;

let manager, viewer, support, variant, a, b, customerOrder, deadOrder;

before(async () => {
  manager = await staff('cal.manager@test.local', 'manager');              // production.read + manage, orders.read
  viewer = await staff('cal.viewer@test.local', 'inventory_manager');      // production.read only; no orders.read
  support = await staff('cal.support@test.local', 'support');              // no production permission
  [variant] = await q(`select id from product_variants order by sku limit 1`);
  a = await createProductionOrder(db, manager, {variantId: variant.id, qty: 12, dueOn: day(10), notes: null}, ctx);
  b = await createProductionOrder(db, manager, {variantId: variant.id, qty: 5, dueOn: null, notes: null}, ctx);
  const [buyer] = await q(`insert into customers (email, full_name, email_verified_at) values ('cal.buyer@test.local', 'Calendar Buyer', now()) returning id`);
  [customerOrder] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-CAL-0001', $1, 'paid', 'paid', 100, 100, '{}', '{}') returning id, order_number`, [buyer.id]);
  [deadOrder] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-CAL-0002', $1, 'cancelled', 'paid', 100, 100, '{}', '{}') returning id, order_number`, [buyer.id]);
});
after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });

test('nothing is automatic: a new production order and a customer order have no milestones or tasks', async () => {
  assert.equal(await total(), 0);
  assert.deepEqual(await listMilestones(db, manager, a.id), []);
  const cal = await productionCalendar(db, manager, {from: day(0), to: day(30)});
  assert.deepEqual(cal.events.map(e => [e.kind, e.date, e.production?.number, e.done, e.overdue]), [['due', day(10), a.number, false, false]], 'only the due date that order already had; the order with no due date is not on the calendar');
});

test('milestones: one "Ready for Trial" and one "Ex-Factory" per production order, never twice', async () => {
  await add(manager, {productionOrderId: a.id, kind: 'ready_for_trial', dueOn: day(4)});
  await add(manager, {productionOrderId: a.id, kind: 'ex_factory', dueOn: day(8), note: 'Truck booked'});
  await assert.rejects(add(manager, {productionOrderId: a.id, kind: 'ready_for_trial', dueOn: day(5)}), e => e instanceof ConflictError && /already has its "Ready for Trial" milestone/.test(e.message));
  await assert.rejects(add(manager, {ref: a.number.toLowerCase(), kind: 'ex_factory', dueOn: day(9)}), ConflictError, 'the same order named by its number is the same order');
  assert.deepEqual((await rowsOf(a.id)).map(r => [r.kind, r.due]), [['ready_for_trial', day(4)], ['ex_factory', day(8)]]);
  // Two people adding the same milestone to the other order at the same moment: exactly one is kept.
  const both = await Promise.allSettled(Array.from({length: 4}, () => add(manager, {productionOrderId: b.id, kind: 'ex_factory', dueOn: day(12)})));
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(both.filter(r => r.status === 'rejected').every(r => r.reason instanceof ConflictError));
  assert.equal((await rowsOf(b.id)).length, 1);
  await assert.rejects(q(`insert into production_milestones (production_order_id, kind, due_on) values ($1, 'ex_factory', current_date)`, [b.id]), /production_milestones_one_of_each/, 'the database refuses a second one too');
  // The milestone's name is fixed: a title sent with it is not stored.
  assert.equal((await q(`select count(*)::int n from production_milestones where kind <> 'task' and title is not null`))[0].n, 0);
});

test('a customer order carries tasks only: the production milestones are refused on it, by the service and by the database', async () => {
  for (const kind of ['ready_for_trial', 'ex_factory'])
    await assert.rejects(add(manager, {ref: customerOrder.order_number, kind, dueOn: day(3)}), e => e instanceof ConflictError && /production milestone: it belongs to a production order, not to a customer order/.test(e.message));
  await assert.rejects(q(`insert into production_milestones (order_id, kind, due_on) values ($1, 'ready_for_trial', current_date)`, [customerOrder.id]), /production_milestones_named_on_production/);
  await assert.rejects(q(`insert into production_milestones (order_id, production_order_id, kind, title, due_on) values ($1, $2, 'task', 'x', current_date)`, [customerOrder.id, a.id]), /production_milestones_one_parent/);
  await assert.rejects(q(`insert into production_milestones (kind, title, due_on) values ('task', 'x', current_date)`), /production_milestones_one_parent/, 'an entry always belongs to an order');
  await add(manager, {ref: customerOrder.order_number, kind: 'task', title: 'Confirm measurements with the customer', dueOn: day(3)});
  assert.deepEqual(await q(`select kind, title from production_milestones where order_id = $1`, [customerOrder.id]), [{kind: 'task', title: 'Confirm measurements with the customer'}]);
  await assert.rejects(add(manager, {ref: deadOrder.order_number, kind: 'task', title: 'x', dueOn: day(3)}), e => e instanceof ConflictError && /is cancelled/.test(e.message));
  await assert.rejects(add(manager, {ref: 'KTS-NOPE-9', kind: 'task', title: 'x', dueOn: day(3)}), NotFoundError);
  await assert.rejects(add(manager, {kind: 'task', title: 'x', dueOn: day(3)}), DomainError, 'it must say which order');
});

test('tasks: several per order, each with a title; inputs are validated', async () => {
  await add(manager, {productionOrderId: a.id, kind: 'task', title: 'Fabric inspection', dueOn: day(-2)});
  await add(manager, {productionOrderId: a.id, kind: 'task', title: 'Fabric inspection', dueOn: day(2)});          // the same words twice are two tasks
  assert.equal((await rowsOf(a.id)).filter(r => r.kind === 'task').length, 2);
  await assert.rejects(add(manager, {productionOrderId: a.id, kind: 'task', dueOn: day(2)}), DomainError, 'a task says what it is');
  await assert.rejects(add(manager, {productionOrderId: a.id, kind: 'task', title: 'x', dueOn: '2026-02-30'}), DomainError, 'a real date');
  await assert.rejects(add(manager, {productionOrderId: a.id, title: 'x', dueOn: day(1)}), DomainError, 'a kind');
  await assert.rejects(add(manager, {productionOrderId: '00000000-0000-4000-8000-000000000000', kind: 'task', title: 'x', dueOn: day(1)}), NotFoundError);
  assert.equal(milestoneInput.safeParse({kind: 'fitting', dueOn: day(1)}).success, false);
  assert.equal(milestoneInput.safeParse({kind: 'task', title: 'x', dueOn: '12/10/2026'}).success, false);
  assert.equal(milestoneInput.safeParse({kind: 'task', title: 'x'.repeat(121), dueOn: day(1)}).success, false);
  assert.equal(milestoneDoneInput.safeParse({milestoneId: a.id, done: 'maybe', expectedDone: 'no'}).success, false);
});

test('changing, completing, reopening and removing', async () => {
  const list = await listMilestones(db, manager, a.id);
  assert.deepEqual(list.map(m => [m.label, m.due, m.done, m.overdue]),
    [['Fabric inspection', day(-2), false, true], ['Fabric inspection', day(2), false, false], ['Ready for Trial', day(4), false, false], ['Ex-Factory', day(8), false, false]]);
  const trial = list.find(m => m.kind === 'ready_for_trial'), late = list[0], later = list[1];
  // A new date: the same milestone moves, no second one appears.
  assert.deepEqual(await saveMilestone(db, manager, {milestoneId: trial.id, title: 'ignored for a milestone', dueOn: day(6), note: 'Moved by the factory'}, ctx), {id: trial.id, changed: true});
  assert.deepEqual(await saveMilestone(db, manager, {milestoneId: trial.id, title: null, dueOn: day(6), note: 'Moved by the factory'}, ctx), {id: trial.id, changed: false});
  assert.deepEqual((await rowsOf(a.id)).filter(r => r.kind === 'ready_for_trial').map(r => [r.due, r.title]), [[day(6), null]]);
  await assert.rejects(saveMilestone(db, manager, {milestoneId: late.id, title: null, dueOn: day(1), note: null}, ctx), DomainError, 'a task keeps a title');
  // Done: who and when; a form from an out-of-date page (or sent twice) is refused instead of undoing someone's change.
  assert.deepEqual(await setMilestoneDone(db, manager, {milestoneId: late.id, done: true, expectedDone: false}, ctx), {done: true, changed: true});
  await assert.rejects(setMilestoneDone(db, manager, {milestoneId: late.id, done: true, expectedDone: false}, ctx), e => e instanceof ConflictError && /Reload/.test(e.message));
  const done = (await listMilestones(db, manager, a.id)).find(m => m.id === late.id);
  assert.deepEqual([done.done, done.overdue, done.done_by], [true, false, 'cal.manager@test.local'], 'done is no longer overdue');
  await assert.rejects(deleteMilestone(db, manager, {milestoneId: late.id}, ctx), e => e instanceof ConflictError && /kept as a record/.test(e.message));
  assert.deepEqual(await setMilestoneDone(db, manager, {milestoneId: late.id, done: false, expectedDone: true}, ctx), {done: false, changed: true});
  assert.equal((await q(`select done_by from production_milestones where id = $1`, [late.id]))[0].done_by, null);
  assert.deepEqual(await deleteMilestone(db, manager, {milestoneId: later.id}, ctx), {deleted: true});
  await assert.rejects(deleteMilestone(db, manager, {milestoneId: later.id}, ctx), NotFoundError);
  assert.equal((await rowsOf(a.id)).length, 3);
});

test('the calendar: every dated thing once, in date order, within the period asked for', async () => {
  const cal = await productionCalendar(db, manager, {from: day(-7), to: day(30)});
  assert.equal(cal.today, calendarToday());
  assert.deepEqual(cal.events.map(e => [e.date, e.kind, e.label, e.production?.number ?? e.order?.number, e.overdue]), [
    [day(-2), 'task', 'Fabric inspection', a.number, true],
    [day(3), 'task', 'Confirm measurements with the customer', 'KTS-CAL-0001', false],
    [day(6), 'ready_for_trial', 'Ready for Trial', a.number, false],
    [day(8), 'ex_factory', 'Ex-Factory', a.number, false],
    [day(10), 'due', 'Production due', a.number, false],
    [day(12), 'ex_factory', 'Ex-Factory', b.number, false],
  ]);
  assert.equal(new Set(cal.events.map(e => e.key)).size, cal.events.length, 'no entry appears twice');
  for (const n of [a.number, b.number]) for (const kind of ['due', 'ready_for_trial', 'ex_factory'])
    assert.ok(cal.events.filter(e => e.production?.number === n && e.kind === kind).length <= 1, `${n}: at most one ${kind}`);
  assert.deepEqual((await productionCalendar(db, manager, {from: day(6), to: day(6)})).events.map(e => e.kind), ['ready_for_trial'], 'one day');
  assert.deepEqual((await productionCalendar(db, manager, {from: day(40), to: day(47)})).events, []);
  await assert.rejects(productionCalendar(db, manager, {from: day(0), to: day(62)}), DomainError, 'at most 62 days at once');
  await assert.rejects(productionCalendar(db, manager, {from: day(5), to: day(1)}), DomainError);
  await assert.rejects(productionCalendar(db, manager, {from: 'today', to: day(1)}), DomainError);
});

test('a cancelled or completed production order: nothing more is scheduled; a cancelled one leaves the calendar', async () => {
  await setProductionStatus(db, manager, {productionOrderId: b.id, status: 'cancelled', expectedStatus: 'planned', note: 'Not needed'}, ctx);
  await assert.rejects(add(manager, {productionOrderId: b.id, kind: 'task', title: 'x', dueOn: day(2)}), e => e instanceof ConflictError && /is cancelled/.test(e.message));
  assert.equal((await productionCalendar(db, manager, {from: day(-7), to: day(30)})).events.filter(e => e.production?.number === b.number).length, 0);
  assert.equal((await rowsOf(b.id)).length, 1, 'its entry is kept as a record, only not shown');
});

test('permissions: reading needs production.read; every change needs production.manage; customer orders only with orders.read', async () => {
  await assert.rejects(productionCalendar(db, support, {from: day(0), to: day(7)}), ForbiddenError);
  await assert.rejects(listMilestones(db, support, a.id), ForbiddenError);
  const seen = await productionCalendar(db, viewer, {from: day(-7), to: day(30)});
  assert.equal(seen.events.length, 4, 'may read the production entries');
  assert.ok(seen.events.every(e => e.order === null), 'but not the task of a customer order (no orders.read)');
  const [first] = await listMilestones(db, viewer, a.id);
  const before = await total();
  for (const actor of [viewer, support]) {
    await assert.rejects(add(actor, {productionOrderId: a.id, kind: 'task', title: 'x', dueOn: day(1)}), ForbiddenError);
    await assert.rejects(saveMilestone(db, actor, {milestoneId: first.id, title: 'x', dueOn: day(1), note: null}, ctx), ForbiddenError);
    await assert.rejects(setMilestoneDone(db, actor, {milestoneId: first.id, done: true, expectedDone: false}, ctx), ForbiddenError);
    await assert.rejects(deleteMilestone(db, actor, {milestoneId: first.id}, ctx), ForbiddenError);
  }
  assert.equal(await total(), before);
  assert.equal((await q(`select has_table_privilege('kitsyuu_website', 'public.production_milestones', 'select') w`))[0].w, false, 'the store has no access to this table');
});

test('audit: every change is recorded with who made it; orders, stock and production figures are untouched', async () => {
  const actions = Object.fromEntries((await q(`select action, count(*)::int n from audit_logs where entity_type = 'production_milestones' group by 1`)).map(r => [r.action, r.n]));
  assert.deepEqual(actions, {'milestone.create': 6, 'milestone.update': 1, 'milestone.done': 1, 'milestone.reopen': 1, 'milestone.delete': 1});
  assert.equal((await q(`select count(*)::int n from audit_logs where entity_type = 'production_milestones' and staff_id is null`))[0].n, 0);
  const [s] = await q(`select (select count(*)::int from inventory_movements) moves, (select coalesce(sum(stock_qty), 0)::int from product_variants) units, (select count(*)::int from orders) orders,
    (select status from production_orders where id = $1) a_status, (select to_char(due_on, 'YYYY-MM-DD') from production_orders where id = $1) a_due`, [a.id]);
  assert.deepEqual(s, {moves: 110, units: 1100, orders: 2, a_status: 'planned', a_due: day(10)}, 'a milestone moves no stock (the 110 rows are the opening stock of the seed) and changes no order');
});
