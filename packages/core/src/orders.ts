/* Order administration: list, detail, status changes. Order amounts and lines are a historical snapshot and are never
   edited here. The only mutation is a status change along ORDER_TRANSITIONS; it runs in ONE transaction with the order
   row locked, appends to order_status_history, returns reserved/sold stock on cancellation (through adjust_stock), and
   writes the audit record. The audit record carries the history row id, which is how the history shows the staff member
   (order_status_history.changed_by refers to Supabase Auth users, not staff). */
import { recordAudit, sql, type Db, type OrderStatus } from '@kitsyuu/db';
import { canTransition, ConflictError, DomainError, NotFoundError, NOTE_REQUIRED_FOR, ORDER_TRANSITIONS, type OrderListQuery, type UpdateOrderStatusInput } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export const ORDER_PAGE_SIZE = 50;
const OPEN_STATUSES: OrderStatus[] = ['pending_payment', 'paid', 'processing', 'shipped'];
const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function listOrders(db: Db, actor: StaffPrincipal, query: OrderListQuery) {
  requirePermission(actor, 'orders.read');
  let q = db.selectFrom('orders as o')
    .select(['o.id', 'o.order_number', 'o.status', 'o.payment_status', 'o.total_paise', 'o.currency', 'o.created_at', 'o.paid_at',
      sql<string | null>`o.contact->>'name'`.as('contact_name'), sql<string | null>`o.contact->>'email'`.as('contact_email'),
      sql<number>`(select coalesce(sum(i.qty), 0)::int from public.order_items i where i.order_id = o.id)`.as('units'),
      sql<number>`(select count(*)::int from public.order_items i where i.order_id = o.id)`.as('lines')]);
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    const term = query.q;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
    q = q.where(eb => eb.or([
      eb('o.order_number', 'ilike', like),
      sql<boolean>`o.contact->>'email' ilike ${like}`, sql<boolean>`o.contact->>'name' ilike ${like}`, sql<boolean>`o.contact->>'phone' ilike ${like}`,
      sql<boolean>`exists (select 1 from public.order_items i where i.order_id = o.id and i.sku ilike ${like})`,
      sql<boolean>`exists (select 1 from public.customers c where c.id = coalesce(o.customer_id, o.user_id) and c.email ilike ${like})`,
      ...(isUuid ? [eb('o.id', '=', term.toLowerCase())] : []),
    ]));
  }
  if (query.status === 'open') q = q.where('o.status', 'in', OPEN_STATUSES);
  else if (query.status !== 'all') q = q.where('o.status', '=', query.status);
  if (query.payment === 'none') q = q.where('o.payment_status', 'is', null);
  else if (query.payment !== 'all') q = q.where('o.payment_status', '=', query.payment);
  // Dates are business days in India (Asia/Kolkata).
  if (query.from) q = q.where('o.created_at', '>=', sql<Date>`(${query.from}::date)::timestamp at time zone 'Asia/Kolkata'`);
  if (query.to) q = q.where('o.created_at', '<', sql<Date>`((${query.to}::date) + 1)::timestamp at time zone 'Asia/Kolkata'`);
  const rows = await q.orderBy('o.created_at', 'desc').orderBy('o.id', 'desc')
    .limit(ORDER_PAGE_SIZE + 1).offset((query.page - 1) * ORDER_PAGE_SIZE).execute();
  return { rows: rows.slice(0, ORDER_PAGE_SIZE), hasNext: rows.length > ORDER_PAGE_SIZE };
}

export async function getOrder(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'orders.read');
  const o = await db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!o) throw new NotFoundError('Order not found.');
  const [items, history] = await Promise.all([
    db.selectFrom('order_items as i').leftJoin('products as p', 'p.id', 'i.product_id')
      .select(['i.id', 'i.product_id', 'i.variant_id', 'i.sku', 'i.name', 'i.size', 'i.image_path', 'i.unit_price_paise', 'i.qty', 'i.line_total_paise', 'p.status as product_status'])
      .where('i.order_id', '=', orderId).orderBy('i.sku').execute(),
    db.selectFrom('order_status_history as h')
      .leftJoin('audit_logs as a', join => join.on('a.action', '=', 'order.status_update').on('a.entity_id', '=', orderId)
        .on(sql<boolean>`(a.metadata->>'history_id')::bigint = h.id`))
      .leftJoin('staff_users as s', 's.id', 'a.staff_id')
      .select(['h.id', 'h.from_status', 'h.to_status', 'h.note', 'h.created_at', 's.email as staff_email'])
      .where('h.order_id', '=', orderId).orderBy('h.created_at').orderBy('h.id').execute(),
  ]);
  const contact = (o.contact ?? {}) as Record<string, unknown>;
  const ship = (o.shipping_address ?? {}) as Record<string, unknown>;
  const lineSum = items.reduce((n, i) => n + i.line_total_paise, 0);
  const integrity = {
    linesMatchUnitPrices: items.every(i => i.unit_price_paise * i.qty === i.line_total_paise),
    linesMatchSubtotal: lineSum === o.subtotal_paise,
    totalCoversSubtotal: o.total_paise >= 0 && o.subtotal_paise >= 0,
  };
  const customer = can(actor, 'customers.read')
    ? await db.selectFrom('customers').select(['id', 'email', 'status', 'created_at'])
        .where('id', '=', o.customer_id ?? o.user_id).executeTakeFirst() ?? null
    : undefined;                                                   // undefined = not permitted; null = no account row
  const billing = can(actor, 'billing.read') ? {
    payments: await db.selectFrom('payments').select(['id', 'provider', 'provider_payment_id', 'amount_paise', 'currency', 'status', 'method', 'failure_reason', 'captured_at', 'created_at'])
      .where('order_id', '=', orderId).orderBy('created_at').execute(),
    refunds: await db.selectFrom('refunds').select(['id', 'amount_paise', 'reason', 'status', 'processed_at', 'created_at']).where('order_id', '=', orderId).orderBy('created_at').execute(),
    invoices: await db.selectFrom('invoices').select(['id', 'invoice_number', 'status', 'financial_year', 'issued_at', 'total_paise', 'tax_paise', 'prices_include_tax'])
      .where('order_id', '=', orderId).orderBy('issued_at').execute(),
  } : undefined;
  const stock = can(actor, 'inventory.read')
    ? await db.selectFrom('inventory_movements as m').innerJoin('product_variants as v', 'v.id', 'm.variant_id').leftJoin('staff_users as s', 's.id', 'm.staff_id')
        .select(['m.created_at', 'v.sku', 'm.delta', 'm.reason', 'm.balance_after', 'm.note', 's.email as staff_email'])
        .where('m.order_id', '=', orderId).orderBy('m.created_at').execute()
    : undefined;
  return {
    order: {
      id: o.id, orderNumber: o.order_number, status: o.status, paymentStatus: o.payment_status, currency: o.currency,
      subtotalPaise: o.subtotal_paise, totalPaise: o.total_paise, paidAt: o.paid_at, createdAt: o.created_at, updatedAt: o.updated_at,
      razorpayOrderId: o.razorpay_order_id, razorpayPaymentId: o.razorpay_payment_id,
    },
    contact: { name: text(contact.name), email: text(contact.email), phone: text(contact.phone) },
    shipping: { name: text(ship.full_name ?? ship.name), line1: text(ship.line1), line2: text(ship.line2), city: text(ship.city), state: text(ship.state), pin: text(ship.pin), country: text(ship.country) },
    items, history, integrity, customer, billing, stock,
    allowedTransitions: can(actor, 'orders.update_status') ? [...ORDER_TRANSITIONS[o.status]] : [],
  };
}

/** Moves an order to a new status (see ORDER_TRANSITIONS). Refused when the status changed since the page was opened. */
export async function updateOrderStatus(db: Db, actor: StaffPrincipal, input: UpdateOrderStatusInput, ctx: MutationContext) {
  requirePermission(actor, 'orders.update_status');
  if (NOTE_REQUIRED_FOR.includes(input.toStatus) && !input.note) throw new DomainError('invalid', 'Give a reason; it is kept in the order history.');
  return db.transaction().execute(async tx => {
    const o = await tx.selectFrom('orders').select(['id', 'order_number', 'status']).where('id', '=', input.orderId).forUpdate().executeTakeFirst();
    if (!o) throw new NotFoundError('Order not found.');
    if (o.status !== input.expectedStatus)
      throw new ConflictError(`This order changed to "${o.status.replace(/_/g, ' ')}" since you opened it. Reload and review it again.`);
    if (!canTransition(o.status, input.toStatus))
      throw new DomainError('invalid', `An order cannot go from ${o.status.replace(/_/g, ' ')} to ${input.toStatus.replace(/_/g, ' ')}.`);

    const released: { variantId: string; qty: number }[] = [];
    if (input.toStatus === 'cancelled') {
      const money = await tx.selectFrom('payments').select(sql<number>`count(*)::int`.as('n'))
        .where('order_id', '=', o.id).where('status', 'in', ['authorized', 'captured']).executeTakeFirstOrThrow();
      if (money.n > 0) throw new ConflictError('This order has an authorised or captured payment. Cancelling it needs the refund flow, which is not available yet.');
      // Return exactly what this order took from stock (sales minus earlier returns), through the stock ledger.
      const taken = await tx.selectFrom('inventory_movements').select(['variant_id', sql<number>`sum(delta)::int`.as('net')])
        .where('order_id', '=', o.id).where('reason', 'in', ['sale', 'cancel']).groupBy('variant_id').execute();
      for (const t of taken.filter(t => t.net < 0)) {
        await sql`select public.adjust_stock(${t.variant_id}::uuid, ${-t.net}::int, 'cancel', ${actor.staffId}::uuid, ${`Order ${o.order_number} cancelled`}::text, ${o.id}::uuid)`.execute(tx);
        released.push({ variantId: t.variant_id, qty: -t.net });
      }
    }
    await tx.updateTable('orders').set({ status: input.toStatus }).where('id', '=', o.id).execute();
    const h = await tx.insertInto('order_status_history').values({ order_id: o.id, from_status: o.status, to_status: input.toStatus, note: input.note })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.status_update', entityType: 'orders', entityId: o.id,
      before: { status: o.status }, after: { status: input.toStatus },
      metadata: { order_number: o.order_number, history_id: h.id, note: input.note, stock_released: released }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number, from: o.status, to: input.toStatus, historyId: h.id, released };
  });
}
