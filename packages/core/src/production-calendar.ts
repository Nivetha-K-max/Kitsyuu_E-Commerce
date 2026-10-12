/* Production calendar: milestones and tasks (2026-10-12; migration 20261012004700, local only until reviewed).
   The calendar is a view of dates, not a second record of production: it shows each production order's own due date and
   the dated entries staff add to it.
     · Milestones "Ready for Trial" and "Ex-Factory" belong to a production order, at most one of each (checked here
       under the order's row lock, and by a unique index), so a milestone never appears twice.
     · Tasks (a title and a date) belong to a production order or to a customer order.
   Nothing is created automatically: no order, of any kind, receives a milestone or a task by itself. A customer order can
   carry tasks only, never the two production milestones (refused here and by the database).
   Reading needs production.read; adding, changing, completing and removing need production.manage. Entries of a customer
   order are shown only to staff who may read orders. Every change is audited in the same transaction. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

export const MILESTONE_KINDS = ['ready_for_trial', 'ex_factory', 'task'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
export const MILESTONE_LABEL: Record<MilestoneKind, string> = { ready_for_trial: 'Ready for Trial', ex_factory: 'Ex-Factory', task: 'Task' };
/** The longest period one calendar request may cover (a month view with its leading and trailing days fits). */
export const CALENDAR_MAX_DAYS = 62;

/** Today in the business's time zone, as YYYY-MM-DD. */
export const calendarToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const realDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const dayText = (col: 'm.due_on' | 'o.due_on') => sql<string>`to_char(${sql.ref(col)}, 'YYYY-MM-DD')`;
const duplicate = (e: unknown) => (e as { code?: string })?.code === '23505';

/** The milestones and tasks of one production order, by date. */
export async function listMilestones(db: Db, actor: StaffPrincipal, productionOrderId: string) {
  requirePermission(actor, 'production.read');
  const today = calendarToday();
  const rows = await db.selectFrom('production_milestones as m').leftJoin('staff_users as s', 's.id', 'm.done_by')
    .select(['m.id', 'm.kind', 'm.title', dayText('m.due_on').as('due'), 'm.note', 'm.done_at', 's.email as done_by'])
    .where('m.production_order_id', '=', productionOrderId).orderBy('m.due_on').orderBy('m.created_at').execute();
  return rows.map(r => ({ ...r, label: r.kind === 'task' ? r.title! : MILESTONE_LABEL[r.kind], done: r.done_at !== null, overdue: r.done_at === null && r.due < today }));
}

export type MilestoneInput = {
  /** set: change this entry's date, note (and a task's title); its kind and its order never change */ milestoneId?: string;
  productionOrderId?: string;
  /** a production order number or a customer order number, as typed (used when productionOrderId is not given) */ ref?: string | null;
  kind?: MilestoneKind; title: string | null; dueOn: string; note: string | null;
};

export async function saveMilestone(db: Db, actor: StaffPrincipal, input: MilestoneInput, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  if (!realDay(input.dueOn)) throw new DomainError('invalid', 'Choose a date.');
  return db.transaction().execute(async tx => {
    if (input.milestoneId) {
      const m = await tx.selectFrom('production_milestones').select(['id', 'kind', 'title', sql<string>`to_char(due_on, 'YYYY-MM-DD')`.as('due'), 'note', 'production_order_id'])
        .where('id', '=', input.milestoneId).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundError('That entry no longer exists.');
      if (m.kind === 'task' && !input.title) throw new DomainError('invalid', 'Say what the task is.');
      const after = { title: m.kind === 'task' ? input.title : null, due: input.dueOn, note: input.note };
      const before = { title: m.title, due: m.due, note: m.note };
      if (JSON.stringify(before) === JSON.stringify(after)) return { id: m.id, changed: false };
      await tx.updateTable('production_milestones').set({ title: after.title, due_on: after.due, note: after.note }).where('id', '=', m.id).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'milestone.update', entityType: 'production_milestones', entityId: m.id, before, after, metadata: { kind: m.kind } });
      return { id: m.id, changed: true };
    }
    const kind = input.kind;
    if (!kind) throw new DomainError('invalid', 'Choose what to add.');
    if (kind === 'task' && !input.title) throw new DomainError('invalid', 'Say what the task is.');
    // Whose entry it is: the production order given, or the number typed (a production order first, then a customer order).
    let production = input.productionOrderId
      ? await tx.selectFrom('production_orders').select(['id', 'number', 'status']).where('id', '=', input.productionOrderId).forUpdate().executeTakeFirst()
      : undefined;
    if (input.productionOrderId && !production) throw new NotFoundError('Production order not found.');
    let order: { id: string; order_number: string; status: string } | undefined;
    if (!production) {
      const ref = (input.ref ?? '').trim();
      if (!ref) throw new DomainError('invalid', 'Enter the production order or customer order number this is for.');
      production = await tx.selectFrom('production_orders').select(['id', 'number', 'status']).where(sql<boolean>`upper(number) = upper(${ref})`).forUpdate().executeTakeFirst();
      if (!production) {
        // A customer order is named only to staff who may read orders; to anyone else it is simply "not found".
        order = can(actor, 'orders.read') ? await tx.selectFrom('orders').select(['id', 'order_number', 'status']).where(sql<boolean>`upper(order_number) = upper(${ref})`).executeTakeFirst() : undefined;
        if (!order) throw new NotFoundError(`No production order or customer order has the number ${ref}.`);
      }
    }
    if (production) {
      if (production.status !== 'planned' && production.status !== 'in_progress') throw new ConflictError(`${production.number} is ${production.status}: nothing more can be scheduled on it.`);
      if (kind !== 'task' && await tx.selectFrom('production_milestones').select('id').where('production_order_id', '=', production.id).where('kind', '=', kind).executeTakeFirst())
        throw new ConflictError(`${production.number} already has its "${MILESTONE_LABEL[kind]}" milestone. Change its date instead of adding it again.`);
    } else {
      if (kind !== 'task') throw new ConflictError(`"${MILESTONE_LABEL[kind]}" is a production milestone: it belongs to a production order, not to a customer order. Add a task instead.`);
      if (['cancelled', 'refunded', 'payment_failed'].includes(order!.status)) throw new ConflictError(`Order ${order!.order_number} is ${order!.status.replace('_', ' ')}: nothing can be scheduled on it.`);
    }
    try {
      const m = await tx.insertInto('production_milestones').values({ production_order_id: production?.id ?? null, order_id: production ? null : order!.id, kind,
        title: kind === 'task' ? input.title : null, due_on: input.dueOn, note: input.note, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'milestone.create', entityType: 'production_milestones', entityId: m.id,
        after: { kind, title: kind === 'task' ? input.title : null, due: input.dueOn, note: input.note }, metadata: production ? { production_order: production.number } : { order: order!.order_number } });
      return { id: m.id, changed: true };
    } catch (e) {
      if (duplicate(e)) throw new ConflictError('That milestone already exists on this production order.');
      throw e;
    }
  });
}

/** Mark an entry done, or not done again. `expectedDone` is what the page showed, so two people (or a form sent twice) cannot undo each other. */
export async function setMilestoneDone(db: Db, actor: StaffPrincipal, input: { milestoneId: string; done: boolean; expectedDone: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  return db.transaction().execute(async tx => {
    const m = await tx.selectFrom('production_milestones').select(['id', 'kind', 'done_at', 'order_id']).where('id', '=', input.milestoneId).forUpdate().executeTakeFirst();
    if (!m || (m.order_id && !can(actor, 'orders.read'))) throw new NotFoundError('That entry no longer exists.');   // a customer order's task exists only for staff who may read orders
    if ((m.done_at !== null) !== input.expectedDone) throw new ConflictError('Someone else has just changed this. Reload the page to see where it stands.');
    if (input.done === input.expectedDone) return { done: input.done, changed: false };
    await tx.updateTable('production_milestones').set({ done_at: input.done ? new Date() : null, done_by: input.done ? actor.staffId : null }).where('id', '=', m.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.done ? 'milestone.done' : 'milestone.reopen', entityType: 'production_milestones', entityId: m.id, metadata: { kind: m.kind } });
    return { done: input.done, changed: true };
  });
}

/** Remove an entry added by mistake. One that was marked done is part of the record and is kept (reopen it first). */
export async function deleteMilestone(db: Db, actor: StaffPrincipal, input: { milestoneId: string }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  return db.transaction().execute(async tx => {
    const m = await tx.selectFrom('production_milestones').select(['id', 'kind', 'title', sql<string>`to_char(due_on, 'YYYY-MM-DD')`.as('due'), 'done_at', 'production_order_id', 'order_id'])
      .where('id', '=', input.milestoneId).forUpdate().executeTakeFirst();
    if (!m || (m.order_id && !can(actor, 'orders.read'))) throw new NotFoundError('That entry no longer exists.');
    if (m.done_at !== null) throw new ConflictError('This is marked done and is kept as a record. Mark it not done first if it was a mistake.');
    await tx.deleteFrom('production_milestones').where('id', '=', m.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'milestone.delete', entityType: 'production_milestones', entityId: m.id,
      before: { kind: m.kind, title: m.title, due: m.due }, metadata: { production_order_id: m.production_order_id, order_id: m.order_id } });
    return { deleted: true };
  });
}

export type CalendarEvent = {
  /** unique on the calendar: one per production order due date, one per milestone or task */ key: string;
  date: string; kind: 'due' | MilestoneKind; label: string; done: boolean; overdue: boolean; milestoneId: string | null; note: string | null;
  production: { id: string; number: string; status: string; product: string; size: string; qty: number } | null;
  order: { id: string; number: string; status: string } | null;
};

/** Everything dated between `from` and `to` (inclusive, YYYY-MM-DD): the due date of each production order that is not
    cancelled, and the milestones and tasks staff added. A cancelled production order and its entries are left out. */
export async function productionCalendar(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'production.read');
  if (!realDay(range.from) || !realDay(range.to) || range.to < range.from) throw new DomainError('invalid', 'Choose a valid period.');
  if ((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 >= CALENDAR_MAX_DAYS) throw new DomainError('invalid', `A calendar period is at most ${CALENDAR_MAX_DAYS} days.`);
  const today = calendarToday(), seeOrders = can(actor, 'orders.read');
  const [due, entries] = await Promise.all([
    db.selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
      .select(['o.id', 'o.number', 'o.status', 'o.qty_planned', 'p.name as product', 'v.size', dayText('o.due_on').as('due')])
      .where('o.status', '<>', 'cancelled').where(sql<boolean>`o.due_on between ${range.from}::date and ${range.to}::date`).orderBy('o.number').execute(),
    db.selectFrom('production_milestones as m').leftJoin('production_orders as o', 'o.id', 'm.production_order_id').leftJoin('product_variants as v', 'v.id', 'o.variant_id')
      .leftJoin('products as p', 'p.id', 'v.product_id').leftJoin('orders as c', 'c.id', 'm.order_id')
      .select(['m.id', 'm.kind', 'm.title', 'm.note', 'm.done_at', dayText('m.due_on').as('due'), 'o.id as po_id', 'o.number', 'o.status', 'o.qty_planned', 'p.name as product', 'v.size',
        'c.id as order_id', 'c.order_number', 'c.status as order_status'])
      .where(sql<boolean>`m.due_on between ${range.from}::date and ${range.to}::date`).where(eb => eb.or([eb('o.status', 'is', null), eb('o.status', '<>', 'cancelled')]))
      .orderBy('m.due_on').orderBy('m.created_at').execute(),
  ]);
  const events: CalendarEvent[] = [
    ...due.map(o => ({ key: `due:${o.id}`, date: o.due, kind: 'due' as const, label: 'Production due', done: o.status === 'completed', overdue: o.status !== 'completed' && o.due < today,
      milestoneId: null, note: null, production: { id: o.id, number: o.number, status: o.status as string, product: o.product, size: o.size, qty: o.qty_planned }, order: null })),
    ...entries.filter(m => m.po_id || seeOrders).map(m => ({ key: `m:${m.id}`, date: m.due, kind: m.kind, label: m.kind === 'task' ? m.title! : MILESTONE_LABEL[m.kind], done: m.done_at !== null,
      overdue: m.done_at === null && m.due < today, milestoneId: m.id, note: m.note,
      production: m.po_id ? { id: m.po_id, number: m.number!, status: m.status as string, product: m.product!, size: m.size!, qty: m.qty_planned! } : null,
      order: m.order_id ? { id: m.order_id, number: m.order_number!, status: m.order_status as string } : null })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return { from: range.from, to: range.to, today, events };
}
