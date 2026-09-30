/* ERP module 5: customer support tickets.
   Customers open tickets from their account (optionally about one of their orders) and follow the conversation; staff
   open tickets for customers who phoned or emailed. Staff reply (the customer sees it, and gets an email when that email
   is switched on) or add internal notes (never shown to the customer: the database policy hides them from the store).
   Status: open → assigned → in progress → waiting for the customer → resolved → closed; a customer reply reopens a
   ticket that was waiting, resolved or… (closed tickets stay closed: the customer opens a new one). Every step is audited;
   message text is not copied into the audit log. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type CustomerPrincipal, type Mailer, type RequestContext, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { raiseAlertSafely } from './alerts.ts';
import { hello, sendCustomerEmail, storeLink } from './customer-email.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
export const TICKET_PAGE_SIZE = 40;
type TicketStatus = 'open' | 'assigned' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
const ACTIVE: TicketStatus[] = ['open', 'assigned', 'in_progress', 'waiting_customer'];

export async function supportCategories(db: Db) {
  return db.selectFrom('support_categories').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute();
}

async function orderFor(q: Tx, orderNumber: string | null, customerId: string | null) {
  if (!orderNumber) return null;
  let query = q.selectFrom('orders').select('id').where('order_number', '=', orderNumber);
  if (customerId) query = query.where('customer_id', '=', customerId);
  const o = await query.executeTakeFirst();
  if (!o) throw new NotFoundError(customerId ? 'We could not find that order in your account.' : 'Order not found.');
  return o.id;
}

// ---------------------------------------------------------------- customer side
export async function openCustomerTicket(db: Db, p: CustomerPrincipal, input: { subject: string; categoryCode: string; orderNumber: string | null; body: string }, ctx: RequestContext) {
  const t = await db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('support_categories').select('code').where('code', '=', input.categoryCode).executeTakeFirst())) throw new DomainError('invalid', 'Choose a topic.');
    const me = await tx.selectFrom('customers').select(['email', 'full_name']).where('id', '=', p.customerId).executeTakeFirstOrThrow();
    const orderId = await orderFor(tx, input.orderNumber, p.customerId);
    const t = await tx.insertInto('support_tickets').values({ customer_id: p.customerId, contact_email: me.email, contact_name: me.full_name, order_id: orderId,
      subject: input.subject, category_code: input.categoryCode, channel: 'store', last_customer_reply_at: sql<Date>`now()` }).returning(['id', 'number']).executeTakeFirstOrThrow();
    await tx.insertInto('support_messages').values({ ticket_id: t.id, author_type: 'customer', customer_id: p.customerId, body: input.body }).execute();
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'support.ticket_open', entityType: 'support_tickets', entityId: t.id,
      metadata: { number: t.number, category: input.categoryCode }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return t;
  });
  await raiseAlertSafely(db, { kind: 'support.ticket', title: `New ticket ${t.number}: ${input.subject}`, entityType: 'support_tickets', entityId: t.id, link: `/support/${t.id}`, dedupeKey: `support.ticket:${t.id}` });
  return t;
}

export async function listCustomerTickets(db: Db, p: CustomerPrincipal) {
  return db.selectFrom('support_tickets as t').leftJoin('orders as o', 'o.id', 't.order_id')
    .select(['t.number', 't.subject', 't.status', 't.created_at', 't.updated_at', 'o.order_number']).where('t.customer_id', '=', p.customerId).orderBy('t.updated_at', 'desc').execute();
}

export async function getCustomerTicket(db: Db, p: CustomerPrincipal, number: string) {
  const t = await db.selectFrom('support_tickets as t').leftJoin('orders as o', 'o.id', 't.order_id').innerJoin('support_categories as c', 'c.code', 't.category_code')
    .select(['t.id', 't.number', 't.subject', 't.status', 't.created_at', 'o.order_number', 'c.label as category']).where('t.number', '=', number).where('t.customer_id', '=', p.customerId).executeTakeFirst();
  if (!t) throw new NotFoundError('Ticket not found.');
  // is_internal is filtered here as well as by the database policy.
  const messages = await db.selectFrom('support_messages').select(['id', 'author_type', 'body', 'created_at']).where('ticket_id', '=', t.id).where('is_internal', '=', false)
    .orderBy('created_at').orderBy('id').execute();
  return { ...t, messages: messages.map(m => ({ ...m, id: String(m.id) })) };
}

export async function replyAsCustomer(db: Db, p: CustomerPrincipal, input: { ticketNumber: string; body: string }, ctx: RequestContext) {
  const t = await db.transaction().execute(async tx => {
    const t = await tx.selectFrom('support_tickets').select(['id', 'number', 'status', 'assigned_to']).where('number', '=', input.ticketNumber).where('customer_id', '=', p.customerId).forUpdate().executeTakeFirst();
    if (!t) throw new NotFoundError('Ticket not found.');
    if (t.status === 'closed') throw new ConflictError('This ticket is closed. Open a new one and mention this ticket number.');
    await tx.insertInto('support_messages').values({ ticket_id: t.id, author_type: 'customer', customer_id: p.customerId, body: input.body }).execute();
    const status: TicketStatus = t.status === 'waiting_customer' || t.status === 'resolved' ? (t.assigned_to ? 'in_progress' : 'open') : t.status as TicketStatus;
    await tx.updateTable('support_tickets').set({ status, last_customer_reply_at: sql<Date>`now()` }).where('id', '=', t.id).execute();
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'support.customer_reply', entityType: 'support_tickets', entityId: t.id,
      before: { status: t.status }, after: { status }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return t;
  });
  await raiseAlertSafely(db, { kind: 'support.reply', title: `Customer replied on ${t.number}`, entityType: 'support_tickets', entityId: t.id, link: `/support/${t.id}` });
}

// ---------------------------------------------------------------- staff side
export async function listTickets(db: Db, actor: StaffPrincipal, query: { q?: string; status: string; priority: string; assignee: string; category?: string; page: number }) {
  requirePermission(actor, 'support.read');
  let q = db.selectFrom('support_tickets as t').leftJoin('staff_users as s', 's.id', 't.assigned_to').leftJoin('orders as o', 'o.id', 't.order_id')
    .innerJoin('support_categories as c', 'c.code', 't.category_code')
    .select(['t.id', 't.number', 't.subject', 't.status', 't.priority', 't.channel', 't.contact_email', 't.created_at', 't.updated_at', 't.last_customer_reply_at',
      't.last_staff_reply_at', 's.email as assignee', 'o.order_number', 'c.label as category']);
  if (query.status === 'active') q = q.where('t.status', 'in', ACTIVE);
  else if (query.status !== 'all') q = q.where('t.status', '=', query.status as TicketStatus);
  if (query.priority !== 'all') q = q.where('t.priority', '=', query.priority as 'low');
  if (query.assignee === 'me') q = q.where('t.assigned_to', '=', actor.staffId);
  if (query.assignee === 'unassigned') q = q.where('t.assigned_to', 'is', null);
  if (query.category) q = q.where('t.category_code', '=', query.category);
  if (query.q) { const l = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('t.number', 'ilike', l), eb('t.subject', 'ilike', l), eb('t.contact_email', 'ilike', l), eb('o.order_number', 'ilike', l)])); }
  const rows = await q.orderBy(sql`case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`).orderBy('t.updated_at', 'desc')
    .limit(TICKET_PAGE_SIZE + 1).offset((query.page - 1) * TICKET_PAGE_SIZE).execute();
  const counts = await db.selectFrom('support_tickets').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
  return { rows: rows.slice(0, TICKET_PAGE_SIZE), hasNext: rows.length > TICKET_PAGE_SIZE, counts: Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number> };
}

export async function getTicket(db: Db, actor: StaffPrincipal, ticketId: string) {
  requirePermission(actor, 'support.read');
  const t = await db.selectFrom('support_tickets as t').leftJoin('staff_users as s', 's.id', 't.assigned_to').leftJoin('orders as o', 'o.id', 't.order_id')
    .leftJoin('customers as cu', 'cu.id', 't.customer_id')
    .select(['t.id', 't.number', 't.subject', 't.status', 't.priority', 't.category_code', 't.channel', 't.contact_email', 't.contact_name', 't.customer_id', 't.assigned_to',
      't.created_at', 't.updated_at', 't.resolved_at', 't.closed_at', 's.email as assignee', 'o.id as order_id', 'o.order_number', 'o.status as order_status', 'cu.full_name as customer_name'])
    .where('t.id', '=', ticketId).executeTakeFirst();
  if (!t) throw new NotFoundError('Ticket not found.');
  const messages = await db.selectFrom('support_messages as m').leftJoin('staff_users as s', 's.id', 'm.staff_user_id')
    .select(['m.id', 'm.author_type', 'm.body', 'm.is_internal', 'm.created_at', 's.email as staff_email']).where('m.ticket_id', '=', ticketId).orderBy('m.created_at').orderBy('m.id').execute();
  const staff = can(actor, 'support.manage') ? await db.selectFrom('staff_users as s')
    .select(['s.id', 's.email', 's.full_name']).where('s.status', '=', 'active')
    .where(eb => eb.exists(eb.selectFrom('staff_user_roles as ur').innerJoin('role_permissions as rp', 'rp.role_id', 'ur.role_id')
      .select('ur.staff_user_id').whereRef('ur.staff_user_id', '=', 's.id').where('rp.permission_code', '=', 'support.manage')))
    .orderBy('s.email').execute() : [];
  const categories = await supportCategories(db);
  return { ticket: t, messages: messages.map(m => ({ ...m, id: String(m.id) })), staff, categories };
}

export async function openStaffTicket(db: Db, actor: StaffPrincipal,
  input: { customerEmail: string; contactName: string | null; subject: string; categoryCode: string; priority: 'low' | 'medium' | 'high' | 'urgent'; orderNumber: string | null; body: string }, ctx: MutationContext) {
  requirePermission(actor, 'support.manage');
  return db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('support_categories').select('code').where('code', '=', input.categoryCode).executeTakeFirst())) throw new DomainError('invalid', 'Choose a category.');
    const customer = await tx.selectFrom('customers').select(['id', 'full_name']).where(sql`lower(email)`, '=', input.customerEmail).executeTakeFirst();
    const orderId = await orderFor(tx, input.orderNumber, null);
    const t = await tx.insertInto('support_tickets').values({ customer_id: customer?.id ?? null, contact_email: input.customerEmail, contact_name: input.contactName ?? customer?.full_name ?? null,
      order_id: orderId, subject: input.subject, category_code: input.categoryCode, priority: input.priority, channel: 'staff', status: 'assigned', assigned_to: actor.staffId })
      .returning(['id', 'number']).executeTakeFirstOrThrow();
    // What the customer reported, recorded by staff: an internal note (the customer did not write it).
    await tx.insertInto('support_messages').values({ ticket_id: t.id, author_type: 'staff', staff_user_id: actor.staffId, body: input.body, is_internal: true }).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'support.ticket_open', entityType: 'support_tickets', entityId: t.id, metadata: { number: t.number, channel: 'staff' } });
    return t;
  });
}

/** Staff reply (the customer sees it) or internal note (staff only), optionally changing the status. */
export async function replyToTicket(db: Db, actor: StaffPrincipal, input: { ticketId: string; body: string; internal: boolean; status?: TicketStatus }, ctx: MutationContext) {
  requirePermission(actor, 'support.manage');
  return db.transaction().execute(async tx => {
    const t = await tx.selectFrom('support_tickets').select(['id', 'number', 'status', 'assigned_to', 'customer_id', 'contact_email']).where('id', '=', input.ticketId).forUpdate().executeTakeFirst();
    if (!t) throw new NotFoundError('Ticket not found.');
    if (t.status === 'closed' && !input.internal) throw new ConflictError('This ticket is closed. Reopen it first to reply to the customer.');
    await tx.insertInto('support_messages').values({ ticket_id: t.id, author_type: 'staff', staff_user_id: actor.staffId, body: input.body, is_internal: input.internal }).execute();
    const status: TicketStatus = input.status ?? (!input.internal && ACTIVE.includes(t.status as TicketStatus) ? 'waiting_customer' : t.status as TicketStatus);
    await tx.updateTable('support_tickets').set({ status, ...(input.internal ? {} : { last_staff_reply_at: sql<Date>`now()` }),
      ...(t.assigned_to ? {} : { assigned_to: actor.staffId }), ...stamps(t.status as TicketStatus, status) }).where('id', '=', t.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.internal ? 'support.internal_note' : 'support.staff_reply', entityType: 'support_tickets', entityId: t.id,
      before: { status: t.status }, after: { status } });
    return { number: t.number, emailCustomer: !input.internal };
  });
}

const stamps = (from: TicketStatus, to: TicketStatus) => ({
  ...(to === 'resolved' && from !== 'resolved' ? { resolved_at: sql<Date>`now()` } : {}),
  ...(to === 'closed' && from !== 'closed' ? { closed_at: sql<Date>`now()` } : {}),
  ...(ACTIVE.includes(to) ? { resolved_at: null, closed_at: null } : {}),
});

export async function updateTicket(db: Db, actor: StaffPrincipal, input: { ticketId: string; status: TicketStatus; priority: 'low' | 'medium' | 'high' | 'urgent'; categoryCode: string; assignedTo: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'support.manage');
  return db.transaction().execute(async tx => {
    const t = await tx.selectFrom('support_tickets').select(['id', 'status', 'priority', 'category_code', 'assigned_to']).where('id', '=', input.ticketId).forUpdate().executeTakeFirst();
    if (!t) throw new NotFoundError('Ticket not found.');
    if (input.assignedTo && !(await tx.selectFrom('staff_users').select('id').where('id', '=', input.assignedTo).where('status', '=', 'active').executeTakeFirst()))
      throw new DomainError('invalid', 'Choose an active staff member.');
    if (!(await tx.selectFrom('support_categories').select('code').where('code', '=', input.categoryCode).executeTakeFirst())) throw new DomainError('invalid', 'Choose a category.');
    // Assigning an open ticket marks it assigned; unassigning an assigned one puts it back to open.
    let status = input.status;
    if (status === 'open' && input.assignedTo) status = 'assigned';
    if (status === 'assigned' && !input.assignedTo) status = 'open';
    const after = { status, priority: input.priority, category_code: input.categoryCode, assigned_to: input.assignedTo };
    if (t.status === after.status && t.priority === after.priority && t.category_code === after.category_code && t.assigned_to === after.assigned_to) return { changed: false };
    await tx.updateTable('support_tickets').set({ ...after, ...stamps(t.status as TicketStatus, status) }).where('id', '=', t.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'support.ticket_update', entityType: 'support_tickets', entityId: t.id,
      before: { status: t.status, priority: t.priority, category_code: t.category_code, assigned_to: t.assigned_to }, after });
    return { changed: true };
  });
}

/** Emails the customer the newest staff reply of a ticket (only when switched on; internal notes are never sent). */
export async function notifyTicketReply(db: Db, mailer: Mailer, ticketId: string, opts: { storeUrl?: string | null } = {}) {
  return sendCustomerEmail(db, mailer, 'support.reply', async () => {
    const t = await db.selectFrom('support_tickets').select(['number', 'subject', 'contact_email', 'contact_name', 'order_id', 'customer_id']).where('id', '=', ticketId).executeTakeFirst();
    const m = await db.selectFrom('support_messages').select(['body']).where('ticket_id', '=', ticketId).where('author_type', '=', 'staff').where('is_internal', '=', false)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!t || !m) return null;
    return { to: t.contact_email, orderId: t.order_id, subject: `Re: ${t.subject} [${t.number}]`,
      text: [hello(t.contact_name), '', m.body, '', ...(t.customer_id ? storeLink(opts.storeUrl, `/account/support/${t.number}`, 'Your ticket') : [])].join('\n') };
  });
}

/** Support report: tickets opened / resolved in a period, by category and status, and median first-response time. */
export async function supportReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'support.read');
  const inRange = sql<boolean>`(t.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`;
  const [byCategory, byStatus, response] = await Promise.all([
    db.selectFrom('support_tickets as t').innerJoin('support_categories as c', 'c.code', 't.category_code').select(['c.label', sql<number>`count(*)::int`.as('n')])
      .where(inRange).groupBy('c.label').orderBy(sql`count(*)`, 'desc').execute(),
    db.selectFrom('support_tickets as t').select(['t.status', sql<number>`count(*)::int`.as('n')]).where(inRange).groupBy('t.status').execute(),
    db.selectFrom('support_tickets as t').select([
      sql<number | null>`round((percentile_cont(0.5) within group (order by extract(epoch from (
        (select min(m.created_at) from public.support_messages m where m.ticket_id = t.id and m.author_type = 'staff' and not m.is_internal) - t.created_at)) / 3600))::numeric, 1)::float8`.as('median_hours'),
      sql<number>`count(*) filter (where t.resolved_at is not null)::int`.as('resolved')]).where(inRange).executeTakeFirstOrThrow(),
  ]);
  return { byCategory, byStatus, medianFirstResponseHours: response.median_hours, resolved: response.resolved };
}
