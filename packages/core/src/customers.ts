/* Customer administration for staff (M8). Reads only non-secret columns: the admin database role cannot read password
   hashes, session token hashes or customers' one-time link tokens at all (migration 1800), and nothing here asks for them.
   Session and login activity is shown as times and states only (no IP addresses, user agents or token material).
   Disabling an account reuses the customer-auth rules (M6): sessions are ended with revokeAllCustomerSessions and a
   disabled account cannot log in or use a session. Every change is audited with the staff member and a reason. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, NotFoundError, uuid, type CustomerListQuery, type SetCustomerStatusInput, type UpdateCustomerContactInput } from '@kitsyuu/contracts';
import { can, requirePermission, revokeAllCustomerSessions, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export const CUSTOMER_PAGE_SIZE = 50;
const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const like = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;

export async function listCustomers(db: Db, actor: StaffPrincipal, query: CustomerListQuery) {
  requirePermission(actor, 'customers.read');
  const points = sql<number>`coalesce((select la.balance from public.loyalty_accounts la where la.customer_id = s.customer_id), 0)::int`;
  const hasOrder = (cond: ReturnType<typeof sql>) => sql<boolean>`exists (select 1 from public.orders o where o.customer_id = s.customer_id and o.status not in ('cancelled') and ${cond})`;
  let q = db.selectFrom('v_customer_summary as s').innerJoin('customers as c', 'c.id', 's.customer_id')
    .select(['s.customer_id', 's.email', 's.full_name', 's.status', 's.created_at', 's.last_login_at', 's.orders_count', 's.paid_orders_count',
      's.lifetime_value_paise', 's.last_order_at', 'c.phone', 'c.email_verified_at', points.as('points'),
      sql<boolean>`exists (select 1 from public.newsletter_subscribers n where n.email = lower(s.email) and n.status = 'subscribed')`.as('subscribed')]);
  if (query.q) {
    const l = like(query.q);
    q = q.where(eb => eb.or([eb('s.email', 'ilike', l), eb('s.full_name', 'ilike', l), eb('c.phone', 'ilike', l)]));
  }
  if (query.status !== 'all') q = q.where('s.status', '=', query.status);
  if (query.verified === 'verified') q = q.where('c.email_verified_at', 'is not', null);
  else if (query.verified === 'unverified') q = q.where('c.email_verified_at', 'is', null);
  if (query.orders === 'with') q = q.where('s.orders_count', '>', 0);
  else if (query.orders === 'without') q = q.where('s.orders_count', '=', 0);
  // 2026-10-01 filters (all combine). "New" = joined in the last 30 days.
  if (query.segment === 'new') q = q.where(sql<boolean>`s.created_at >= now() - interval '30 days'`);
  else if (query.segment === 'existing') q = q.where(sql<boolean>`s.created_at < now() - interval '30 days'`);
  if (query.channel === 'online') q = q.where(hasOrder(sql`o.channel = 'online'`));
  else if (query.channel === 'offline') q = q.where(hasOrder(sql`o.channel = 'retail'`));
  if (query.payment === 'cod') q = q.where(hasOrder(sql`o.payment_method = 'cod'`));
  else if (query.payment === 'online') q = q.where(hasOrder(sql`o.payment_method = 'online'`));
  if (query.minOrders !== undefined) q = q.where('s.orders_count', '>=', query.minOrders);
  if (query.maxOrders !== undefined) q = q.where('s.orders_count', '<=', query.maxOrders);
  if (query.minSpend !== undefined) q = q.where('s.lifetime_value_paise', '>=', query.minSpend * 100);
  if (query.minPoints !== undefined) q = q.where(points, '>=', query.minPoints);
  if (query.maxPoints !== undefined) q = q.where(points, '<=', query.maxPoints);
  if (query.lastOrderFrom) q = q.where('s.last_order_at', '>=', new Date(query.lastOrderFrom + 'T00:00:00+05:30'));
  if (query.lastOrderTo) q = q.where('s.last_order_at', '<', sql<Date>`(${query.lastOrderTo}::date + 1)::timestamp at time zone 'Asia/Kolkata'`);
  if (query.joinedFrom) q = q.where('s.created_at', '>=', new Date(query.joinedFrom + 'T00:00:00+05:30'));
  if (query.joinedTo) q = q.where('s.created_at', '<', sql<Date>`(${query.joinedTo}::date + 1)::timestamp at time zone 'Asia/Kolkata'`);
  const subscribed = sql<boolean>`exists (select 1 from public.newsletter_subscribers n where n.email = lower(s.email) and n.status = 'subscribed')`;
  if (query.subscribed === 'yes') q = q.where(subscribed);
  else if (query.subscribed === 'no') q = q.where(sql<boolean>`not ${subscribed}`);
  if (query.place) q = q.where(sql<boolean>`exists (select 1 from public.addresses a where a.customer_id = s.customer_id and (a.city ilike ${like(query.place)} or a.state ilike ${like(query.place)} or a.pin like ${query.place.replace(/[\\%_]/g, '') + '%'}))`);
  const order = { newest: [sql`s.created_at desc`], spend: [sql`s.lifetime_value_paise desc`], orders: [sql`s.orders_count desc`],
    last_order: [sql`s.last_order_at desc nulls last`], points: [sql`${points} desc`] }[query.sort];
  const rows = await q.orderBy(order[0]).orderBy('s.customer_id').limit(CUSTOMER_PAGE_SIZE + 1).offset((query.page - 1) * CUSTOMER_PAGE_SIZE).execute();
  const totals = await db.selectFrom('customers').select([sql<number>`count(*)::int`.as('total'),
    sql<number>`(count(*) filter (where status = 'disabled'))::int`.as('disabled')]).executeTakeFirstOrThrow();
  return {
    rows: rows.slice(0, CUSTOMER_PAGE_SIZE).map(r => ({ id: r.customer_id, email: r.email, fullName: r.full_name, phone: r.phone, status: r.status,
      verified: !!r.email_verified_at, createdAt: r.created_at as Date, lastLoginAt: r.last_login_at as Date | null, ordersCount: r.orders_count,
      paidOrdersCount: r.paid_orders_count, lifetimeValuePaise: Number(r.lifetime_value_paise), lastOrderAt: r.last_order_at as Date | null,
      points: r.points, subscribed: r.subscribed })),
    hasNext: rows.length > CUSTOMER_PAGE_SIZE, totals,
  };
}

/** Orders and addresses of a customer, including rows from before M6 that still name the Supabase Auth user. */
const ownedBy = (id: string, legacy: string | null) => (eb: any) => eb.or([eb('customer_id', '=', id),
  ...(legacy ? [eb.and([eb('customer_id', 'is', null), eb('user_id', '=', legacy)])] : [])]);

/* ---- one customer's records (2026-10-10): the loaders of the customer page. Each checks its own permission and that the
   customer exists; pages call these and never query the database themselves. The helpers below are shared with the
   services that own the records (payments-admin, returns, finance, support, engagement). */
export interface CustomerRef { id: string; email: string; legacy: string | null; emailVerifiedAt: Date | null; createdAt: Date }

/** The customer a record loader was asked about. NotFoundError for an id that is not a customer (or not an id at all). */
export async function customerRef(q: Queryable, customerId: string): Promise<CustomerRef> {
  if (!uuid.safeParse(customerId).success) throw new NotFoundError('Customer not found.');
  const c = await q.selectFrom('customers').select(['id', 'email', 'legacy_auth_user_id', 'email_verified_at', 'created_at']).where('id', '=', customerId).executeTakeFirst();
  if (!c) throw new NotFoundError('Customer not found.');
  return { id: c.id, email: c.email, legacy: c.legacy_auth_user_id, emailVerifiedAt: c.email_verified_at as Date | null, createdAt: c.created_at as Date };
}
/** ownedBy for a query that joins the orders table as `o` (payments, refunds, emails of the customer's orders). */
export const ordersOwnedBy = (c: Pick<CustomerRef, 'id' | 'legacy'>) => (c.legacy
  ? sql<boolean>`(o.customer_id = ${c.id} or (o.customer_id is null and o.user_id = ${c.legacy}))` : sql<boolean>`(o.customer_id = ${c.id})`);
/** The customer's returns, for a query with return_requests as `r` and its order as `o`: the return names the customer,
    or (a return opened on an order from before M6) names nobody and belongs to one of the customer's orders. */
export const returnsOwnedBy = (c: Pick<CustomerRef, 'id' | 'legacy'>) => sql<boolean>`(r.customer_id = ${c.id} or (r.customer_id is null and ${ordersOwnedBy(c)}))`;

export const CUSTOMER_ORDERS_PAGE_SIZE = 25;
const packingStateSql = sql<string | null>`(select sh.packing_state from public.shipments sh where sh.order_id = o.id order by sh.created_at desc limit 1)`;

/** One page of a customer's orders, newest first (the order id breaks ties, so pages never overlap), each with how it is
    paid and its packing state. A page past the end is empty. Needs customers.read and orders.read. */
export async function customerOrdersPage(db: Db, actor: StaffPrincipal, customerId: string, query: { page?: number } = {}) {
  requirePermission(actor, 'customers.read'); requirePermission(actor, 'orders.read');
  const c = await customerRef(db, customerId);
  const page = Number.isInteger(query.page) && query.page! >= 1 ? Math.min(query.page!, 10_000) : 1;
  const rows = await db.selectFrom('orders as o')
    .select(['o.id', 'o.order_number', 'o.status', 'o.payment_status', 'o.total_paise', 'o.currency', 'o.created_at', 'o.channel', 'o.pos_number',
      'o.payment_method', 'o.cod_status', 'o.paid_at', packingStateSql.as('packing_state')])
    .where(ordersOwnedBy(c)).orderBy('o.created_at', 'desc').orderBy('o.id', 'desc')
    .limit(CUSTOMER_ORDERS_PAGE_SIZE + 1).offset((page - 1) * CUSTOMER_ORDERS_PAGE_SIZE).execute();
  return { rows: rows.slice(0, CUSTOMER_ORDERS_PAGE_SIZE), page, pageSize: CUSTOMER_ORDERS_PAGE_SIZE, hasNext: rows.length > CUSTOMER_ORDERS_PAGE_SIZE };
}

/** How many returns and support tickets the customer has (the counts on the page's tabs); null where the staff member
    may not see that kind of record. */
export async function customerRecordCounts(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'customers.read');
  const c = await customerRef(db, customerId);
  const [returns, tickets] = await Promise.all([
    can(actor, 'returns.read') ? db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id').select(sql<number>`count(*)::int`.as('n'))
      .where(returnsOwnedBy(c)).executeTakeFirstOrThrow().then(r => r.n) : null,
    can(actor, 'support.read') ? db.selectFrom('support_tickets').select(sql<number>`count(*)::int`.as('n')).where('customer_id', '=', c.id).executeTakeFirstOrThrow().then(r => r.n) : null,
  ]);
  return { returns, tickets };
}

export type CustomerPart = 'orders' | 'addresses' | 'sessions' | 'audit';
const CUSTOMER_PARTS: readonly CustomerPart[] = ['orders', 'addresses', 'sessions', 'audit'];

/** The customer, their order figures and the parts asked for (all of them unless `parts` names fewer: a tab of the
    customer page reads only what it shows). A part that was not asked for comes back empty (audit: undefined).
    `orders` are the 50 most recent, for the overview and the timeline; the Orders tab pages through all of them
    (customerOrdersPage). */
export async function getCustomer(db: Db, actor: StaffPrincipal, customerId: string, opts: { parts?: readonly CustomerPart[] } = {}) {
  requirePermission(actor, 'customers.read');
  const want = (p: CustomerPart) => (opts.parts ?? CUSTOMER_PARTS).includes(p);
  const part = <T>(p: CustomerPart, run: () => Promise<T[]>): Promise<T[]> => (want(p) ? run() : Promise.resolve([]));
  const c = await db.selectFrom('customers')
    .select(['id', 'email', 'full_name', 'phone', 'status', 'email_verified_at', 'last_login_at', 'password_changed_at', 'legacy_auth_user_id', 'created_at', 'updated_at'])
    .where('id', '=', customerId).executeTakeFirst();
  if (!c) throw new NotFoundError('Customer not found.');
  const summary = await db.selectFrom('v_customer_summary').select(['orders_count', 'paid_orders_count', 'lifetime_value_paise', 'last_order_at'])
    .where('customer_id', '=', c.id).executeTakeFirstOrThrow();
  const legacy = c.legacy_auth_user_id;
  const [orders, addresses, sessions, attempts] = await Promise.all([
    // With how each is paid and its packing state, so the page asks for nothing more about them.
    part('orders', () => db.selectFrom('orders as o').select(['o.id', 'o.order_number', 'o.status', 'o.payment_status', 'o.total_paise', 'o.currency', 'o.created_at', 'o.channel', 'o.pos_number',
      'o.payment_method', 'o.cod_status', 'o.paid_at', packingStateSql.as('packing_state')])
      .where(ordersOwnedBy({ id: c.id, legacy })).orderBy('o.created_at', 'desc').orderBy('o.id', 'desc').limit(50).execute()),
    part('addresses', () => db.selectFrom('addresses').select(['id', 'full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country', 'is_default', 'created_at'])
      .where(ownedBy(c.id, legacy)).orderBy('is_default', 'desc').orderBy('created_at').execute()),
    // Safe metadata only: no token hash, no IP address, no user agent.
    part('sessions', () => db.selectFrom('customer_sessions').select(['id', 'created_at', 'last_seen_at', 'idle_expires_at', 'expires_at', 'revoked_at'])
      .where('customer_id', '=', c.id).orderBy('created_at', 'desc').limit(20).execute()),
    part('sessions', () => db.selectFrom('auth_attempts').select(['attempted_at', 'succeeded', 'failure_reason'])
      .where('realm', '=', 'customer').where('email', '=', c.email).orderBy('attempted_at', 'desc').limit(10).execute()),
  ]);
  // How an order is paid and packed is order detail: as before 2026-10-10, only staff with orders.read get it (the page
  // then shows no cash-to-collect line and no packing stage); the order's number, status and total stay with customers.read.
  const seeOrderDetail = can(actor, 'orders.read');
  const shownOrders = seeOrderDetail ? orders : orders.map(o => ({ ...o, payment_method: null, cod_status: null, paid_at: null, packing_state: null }));
  const now = Date.now();
  const audit = can(actor, 'audit.read') && want('audit')
    ? await db.selectFrom('audit_logs as a').leftJoin('staff_users as s', 's.id', 'a.staff_id')
        .select(['a.id', 'a.occurred_at', 'a.actor_type', 'a.action', 'a.entity_type', 'a.entity_id', 's.email as staff_email'])
        .where(eb => eb.or([eb('a.customer_id', '=', c.id), eb.and([eb('a.entity_type', '=', 'customers'), eb('a.entity_id', '=', c.id)])]))
        .orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(25).execute()
    : undefined;                                                      // undefined = not permitted (or not asked for)
  return {
    customer: { id: c.id, email: c.email, fullName: c.full_name, phone: c.phone, status: c.status, emailVerifiedAt: c.email_verified_at as Date | null,
      lastLoginAt: c.last_login_at as Date | null, passwordChangedAt: c.password_changed_at as Date | null, createdAt: c.created_at as Date,
      updatedAt: c.updated_at as Date, platformLogin: !legacy },
    summary: { ordersCount: summary.orders_count, paidOrdersCount: summary.paid_orders_count, lifetimeValuePaise: Number(summary.lifetime_value_paise),
      lastOrderAt: summary.last_order_at as Date | null },
    orders: shownOrders, addresses,
    sessions: sessions.map(s => ({ id: s.id, createdAt: s.created_at as Date, lastSeenAt: s.last_seen_at as Date, expiresAt: s.expires_at as Date,
      revokedAt: s.revoked_at as Date | null,
      active: !s.revoked_at && (s.expires_at as Date).getTime() > now && (s.idle_expires_at as Date).getTime() > now })),
    loginAttempts: attempts.map(a => ({ at: a.attempted_at as Date, success: a.succeeded, reason: a.failure_reason })),
    audit,
    canManage: can(actor, 'customers.manage'),
  };
}

async function lockCustomer(q: Queryable, customerId: string) {
  const c = await q.selectFrom('customers').select(['id', 'email', 'status', 'full_name', 'phone']).where('id', '=', customerId).forUpdate().executeTakeFirst();
  if (!c) throw new NotFoundError('Customer not found.');
  return c;
}

/** Disables or re-enables an account. Disabling ends every session at once; the customer can no longer log in. */
export async function setCustomerStatus(db: Db, actor: StaffPrincipal, input: SetCustomerStatusInput, ctx: MutationContext) {
  requirePermission(actor, 'customers.manage');
  return db.transaction().execute(async tx => {
    const c = await lockCustomer(tx, input.customerId);
    if (c.status !== input.expectedStatus) throw new ConflictError(`This account changed to "${c.status}" since you opened it. Reload and review it again.`);
    await tx.updateTable('customers').set({ status: input.status }).where('id', '=', c.id).execute();
    const sessionsEnded = input.status === 'disabled' ? await revokeAllCustomerSessions(tx, c.id) : 0;
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: input.status === 'disabled' ? 'customer.disable' : 'customer.enable',
      entityType: 'customers', entityId: c.id, customerId: c.id, before: { status: c.status }, after: { status: input.status },
      metadata: { email: c.email, note: input.note, sessions_ended: sessionsEnded }, ...auditCtx(ctx) });
    return { email: c.email, status: input.status, sessionsEnded };
  });
}

/** Corrects a customer's name and mobile number (the email is the login identity and is not changed here). */
export async function updateCustomerContact(db: Db, actor: StaffPrincipal, input: UpdateCustomerContactInput, ctx: MutationContext) {
  requirePermission(actor, 'customers.manage');
  return db.transaction().execute(async tx => {
    const c = await lockCustomer(tx, input.customerId);
    if (c.full_name === input.fullName && c.phone === input.phone) return { email: c.email, changed: false };
    await tx.updateTable('customers').set({ full_name: input.fullName, phone: input.phone }).where('id', '=', c.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'customer.update_contact', entityType: 'customers', entityId: c.id,
      customerId: c.id, before: { full_name: c.full_name, phone: c.phone }, after: { full_name: input.fullName, phone: input.phone },
      metadata: { email: c.email }, ...auditCtx(ctx) });
    return { email: c.email, changed: true };
  });
}
