/* Order administration: list, detail, status changes. Order amounts and lines are a historical snapshot and are never
   edited here. The only mutation is a status change along ORDER_TRANSITIONS; it runs in ONE transaction with the order
   row locked, appends to order_status_history, returns reserved/sold stock on cancellation (through adjust_stock), and
   writes the audit record. The audit record carries the history row id, which is how the history shows the staff member
   (order_status_history.changed_by refers to Supabase Auth users, not staff). */
import { recordAudit, sql, type Db, type OrderStatus, type SelectQueryBuilder } from '@kitsyuu/db';
import { canTransition, ConflictError, DomainError, NotFoundError, NOTE_REQUIRED_FOR, ORDER_TRANSITIONS, type OrderListQuery, type UpdateOrderStatusInput } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { applyOrderTransition, closeUnpaidPayments } from './order-state.ts';
import { getShipment, recordShipmentForTransition } from './fulfilment.ts';
import { listActiveCarriers } from './fulfilment/carrier.ts';
import { cancelledOrderPaymentState, listPaymentExceptions } from './payments-admin.ts';
import { earnForOrder, reverseOrderPoints } from './loyalty.ts';
import { abandonedCheckoutHours } from './checkout-reminders.ts';

export const ORDER_PAGE_SIZE = 50;
const OPEN_STATUSES: OrderStatus[] = ['pending_payment', 'paid', 'processing', 'shipped'];
const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The list filters, shared by the order list and the CSV export so both always select the same orders. */
function filterOrders<QB extends SelectQueryBuilder<any, any, any>>(q: QB, query: Omit<OrderListQuery, 'page'>, abandonHours = 24): QB {
  let r = q as SelectQueryBuilder<any, any, any>;
  // Views (client change request). Draft / Abandoned split the unpaid orders by the abandoned-checkout delay (Settings).
  const view = query.view ?? 'all';
  if (view === 'active') r = r.where('o.status', 'in', ['paid', 'processing', 'shipped']);
  if (view === 'draft' || view === 'abandoned') {
    r = r.where('o.status', 'in', ['pending_payment', 'payment_failed'])
      .where('o.created_at', view === 'draft' ? '>' : '<=', sql<Date>`now() - make_interval(hours => ${abandonHours})`);
  }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    const term = query.q;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
    r = r.where(eb => eb.or([
      eb('o.order_number', 'ilike', like),
      sql<boolean>`o.contact->>'email' ilike ${like}`, sql<boolean>`o.contact->>'name' ilike ${like}`, sql<boolean>`o.contact->>'phone' ilike ${like}`,
      sql<boolean>`exists (select 1 from public.order_items i where i.order_id = o.id and i.sku ilike ${like})`,
      sql<boolean>`exists (select 1 from public.customers c where c.id = coalesce(o.customer_id, o.user_id) and c.email ilike ${like})`,
      ...(isUuid ? [eb('o.id', '=', term.toLowerCase())] : []),
    ]));
  }
  if (query.status === 'open') r = r.where('o.status', 'in', OPEN_STATUSES);
  else if (query.status !== 'all') r = r.where('o.status', '=', query.status);
  if (query.payment === 'none') r = r.where('o.payment_status', 'is', null);
  else if (query.payment !== 'all') r = r.where('o.payment_status', '=', query.payment);
  // Dates are business days in India (Asia/Kolkata).
  if (query.from) r = r.where('o.created_at', '>=', sql<Date>`(${query.from}::date)::timestamp at time zone 'Asia/Kolkata'`);
  if (query.to) r = r.where('o.created_at', '<', sql<Date>`((${query.to}::date) + 1)::timestamp at time zone 'Asia/Kolkata'`);
  return r as QB;
}

export async function listOrders(db: Db, actor: StaffPrincipal, query: OrderListQuery) {
  requirePermission(actor, 'orders.read');
  const hours = await abandonedCheckoutHours(db);
  const q = filterOrders(db.selectFrom('orders as o')
    .select(['o.id', 'o.order_number', 'o.status', 'o.payment_status', 'o.total_paise', 'o.currency', 'o.created_at', 'o.paid_at', 'o.updated_at', 'o.payment_method',
      sql<string | null>`(select r.status from public.checkout_reminders r where r.order_id = o.id)`.as('reminder'),
      sql<string | null>`o.contact->>'name'`.as('contact_name'), sql<string | null>`o.contact->>'email'`.as('contact_email'),
      sql<number>`(select coalesce(sum(i.qty), 0)::int from public.order_items i where i.order_id = o.id)`.as('units'),
      sql<number>`(select count(*)::int from public.order_items i where i.order_id = o.id)`.as('lines')]), query, hours);
  const rows = await q.orderBy('o.created_at', 'desc').orderBy('o.id', 'desc')
    .limit(ORDER_PAGE_SIZE + 1).offset((query.page - 1) * ORDER_PAGE_SIZE).execute();
  return { rows: rows.slice(0, ORDER_PAGE_SIZE), hasNext: rows.length > ORDER_PAGE_SIZE, abandonHours: hours };
}

export const ORDER_EXPORT_MAX_ROWS = 5000;
const csvCell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;                         // never let a spreadsheet run a cell as a formula
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** The filtered order list as CSV (one row per order; no addresses, payments or internal data). Capped and audited. */
export async function exportOrders(db: Db, actor: StaffPrincipal, query: Omit<OrderListQuery, 'page'>, ctx: MutationContext) {
  requirePermission(actor, 'orders.read');
  const rows = await filterOrders(db.selectFrom('orders as o').leftJoin('shipments as sh', 'sh.order_id', 'o.id')
    .select(['o.order_number', 'o.created_at', 'o.status', 'o.payment_status', 'o.paid_at', 'o.total_paise', 'o.currency',
      sql<string | null>`o.contact->>'name'`.as('contact_name'), sql<string | null>`o.contact->>'email'`.as('contact_email'),
      sql<number>`(select coalesce(sum(i.qty), 0)::int from public.order_items i where i.order_id = o.id)`.as('units'),
      'sh.carrier_code', 'sh.tracking_number', 'sh.shipped_at', 'sh.delivered_at']), query, await abandonedCheckoutHours(db))
    .orderBy('o.created_at', 'desc').orderBy('o.id', 'desc').limit(ORDER_EXPORT_MAX_ROWS + 1).execute();
  const truncated = rows.length > ORDER_EXPORT_MAX_ROWS;
  const head = ['Order', 'Placed', 'Status', 'Payment', 'Paid at', 'Total', 'Currency', 'Customer', 'Email', 'Units', 'Courier', 'Tracking', 'Shipped', 'Delivered'];
  const lines = rows.slice(0, ORDER_EXPORT_MAX_ROWS).map(r => [r.order_number, r.created_at, r.status, r.payment_status ?? 'none', r.paid_at,
    (Number(r.total_paise) / 100).toFixed(2), r.currency, r.contact_name, r.contact_email, r.units, r.carrier_code, r.tracking_number, r.shipped_at, r.delivered_at]);
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.export', entityType: 'orders', entityId: null,
    metadata: { filters: query, rows: lines.length, truncated }, ...auditCtx(ctx) }));
  return { csv: [head, ...lines].map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n', rows: lines.length, truncated };
}

export async function getOrder(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'orders.read');
  const o = await db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirst();
  if (!o) throw new NotFoundError('Order not found.');
  const [items, history] = await Promise.all([
    db.selectFrom('order_items as i').leftJoin('products as p', 'p.id', 'i.product_id')
      .select(['i.id', 'i.product_id', 'i.variant_id', 'i.sku', 'i.name', 'i.size', 'i.colour', 'i.image_path', 'i.unit_price_paise', 'i.qty', 'i.line_total_paise', 'p.status as product_status'])
      .where('i.order_id', '=', orderId).orderBy('i.sku').execute(),
    db.selectFrom('order_status_history as h')
      .leftJoin('audit_logs as a', join => join.on('a.action', '=', 'order.status_update').on('a.entity_id', '=', orderId)
        .on(sql<boolean>`(a.metadata->>'history_id')::bigint = h.id`))
      .leftJoin('staff_users as s', 's.id', 'a.staff_id')
      .select(['h.id', 'h.from_status', 'h.to_status', 'h.note', 'h.created_at', 's.email as staff_email',
        // A change the customer made themselves (placing or cancelling the order) is audited in the same transaction.
        sql<boolean>`exists (select 1 from public.audit_logs c where c.entity_type = 'orders' and c.entity_id = ${orderId} and c.actor_type = 'customer'
          and c.action in ('order.placed', 'order.cancelled_by_customer') and c.occurred_at = h.created_at)`.as('by_customer')])
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
  const shipment = await getShipment(db, o.id);
  const payment = can(actor, 'billing.read') ? {
    cancelled: await cancelledOrderPaymentState(db, o.id, o.status),
    exceptions: await listPaymentExceptions(db, { orderId: o.id }),
  } : undefined;
  return {
    order: {
      id: o.id, orderNumber: o.order_number, status: o.status, paymentStatus: o.payment_status, currency: o.currency,
      subtotalPaise: o.subtotal_paise, totalPaise: o.total_paise, paidAt: o.paid_at, createdAt: o.created_at, updatedAt: o.updated_at,
      // Second pass: how it is paid, the COD fee and the points used; the amounts that make up the total.
      paymentMethod: o.payment_method, codStatus: o.cod_status, codFeePaise: o.cod_fee_paise, loyaltyPointsUsed: o.loyalty_points_used,
      loyaltyDiscountPaise: o.loyalty_discount_paise, discountPaise: o.discount_paise, shippingPaise: o.shipping_paise, taxPaise: o.tax_paise, pricesIncludeTax: o.prices_include_tax,
      razorpayOrderId: o.razorpay_order_id, razorpayPaymentId: o.razorpay_payment_id,
    },
    contact: { name: text(contact.name), email: text(contact.email), phone: text(contact.phone) },
    shipping: { name: text(ship.full_name ?? ship.name), line1: text(ship.line1), line2: text(ship.line2), city: text(ship.city), state: text(ship.state), pin: text(ship.pin), country: text(ship.country) },
    // Client change request: a separate billing address (null = same as the delivery address).
    billingAddress: o.billing_address ? (b => ({ name: text(b.name), line1: text(b.line1), line2: text(b.line2), city: text(b.city), state: text(b.state), pin: text(b.pin), country: text(b.country) }))(o.billing_address as Record<string, unknown>) : null,
    items, history, integrity, customer, billing, stock, shipment, payment,
    allowedTransitions: can(actor, 'orders.update_status') ? [...ORDER_TRANSITIONS[o.status]] : [],
    carriers: (await listActiveCarriers(db)).map(c => ({ code: c.code, label: c.label })),
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
    const h = { id: (await applyOrderTransition(tx, o, input.toStatus, { actor: 'staff', note: input.note })).historyId };
    if (input.toStatus === 'cancelled') await closeUnpaidPayments(tx, o.id);
    // Second pass: loyalty points follow the order (given back / taken back on cancellation; earned on delivery if chosen).
    const points = input.toStatus === 'cancelled' ? await reverseOrderPoints(tx, o.id, `Order ${o.order_number} cancelled`)
      : input.toStatus === 'delivered' ? { earned: await earnForOrder(tx, o.id, 'delivered') } : null;
    // Shipped / delivered: the shipment details are written in this same transaction (M8 fulfilment).
    const shipment = await recordShipmentForTransition(tx, o.id, input.toStatus,
      { carrierCode: input.carrierCode, trackingNumber: input.trackingNumber }, actor.staffId);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.status_update', entityType: 'orders', entityId: o.id,
      before: { status: o.status }, after: { status: input.toStatus },
      metadata: { order_number: o.order_number, history_id: h.id, note: input.note, stock_released: released, ...(shipment ? { shipment } : {}), ...(points ? { points } : {}) }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number, from: o.status, to: input.toStatus, historyId: h.id, released };
  });
}
