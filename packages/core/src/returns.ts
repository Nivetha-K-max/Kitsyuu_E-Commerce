/* ERP module 3: returns and refunds.
   OFF by default: the business decision is "all sales are final". Customers can only request a return when the business
   switches returns.enabled on AND sets a window (returns.window_days, counted from delivery). Nothing here decides who
   gets a refund or how much: staff review each request and enter the amount; the platform only checks it is possible
   (never more than was captured and not yet refunded).
   Workflow (RETURN_FLOW below): requested → under review / information requested → approved (refund or exchange) or
   rejected → pickup scheduled → picked up → received → inspected → refund pending / exchange pending → refunded /
   exchanged → completed. Cancelled by the customer while still requested, or by staff before the goods arrive.
   Stock: returned items go back through the stock ledger only when staff restock them ('return'); an exchange takes the
   replacement size out through the ledger ('exchange').
   Refunds: through the payment provider's refund API when the provider offers one (marked processed only when the
   provider says so; a refusal is recorded as failed and raised as an alert), or recorded by staff as paid outside the
   platform with its reference. A refund is never marked done without one of those. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type CustomerPrincipal, type Mailer, type RequestContext, type StaffPrincipal } from '@kitsyuu/auth';
import type { PaymentProvider } from './payments/provider.ts';
import type { MutationContext } from './staff.ts';
import { raiseAlertSafely } from './alerts.ts';
import { hello, sendCustomerEmail, storeLink } from './customer-email.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
export const RETURN_PAGE_SIZE = 40;
const OPEN = ['requested', 'under_review', 'info_requested', 'approved', 'pickup_scheduled', 'picked_up', 'received', 'inspection', 'refund_pending', 'exchange_pending', 'refunded', 'exchanged'] as const;

export type ReturnStatus = 'requested' | 'under_review' | 'info_requested' | 'approved' | 'rejected' | 'pickup_scheduled' | 'picked_up' | 'received'
  | 'inspection' | 'refund_pending' | 'refunded' | 'exchange_pending' | 'exchanged' | 'completed' | 'cancelled';
type Action = 'review' | 'request_info' | 'approve' | 'reject' | 'schedule_pickup' | 'picked_up' | 'receive' | 'inspect' | 'ship_exchange' | 'complete' | 'cancel';

/** Which staff action is allowed from which status, and where it leads (inspect / complete are resolved below). */
export const RETURN_FLOW: Record<Action, { from: readonly ReturnStatus[]; to: ReturnStatus | null }> = {
  review: { from: ['requested', 'info_requested'], to: 'under_review' },
  request_info: { from: ['requested', 'under_review'], to: 'info_requested' },
  approve: { from: ['requested', 'under_review', 'info_requested'], to: 'approved' },
  reject: { from: ['requested', 'under_review', 'info_requested', 'received', 'inspection'], to: 'rejected' },
  schedule_pickup: { from: ['approved', 'pickup_scheduled'], to: 'pickup_scheduled' },
  picked_up: { from: ['pickup_scheduled'], to: 'picked_up' },
  receive: { from: ['approved', 'pickup_scheduled', 'picked_up'], to: 'received' },
  inspect: { from: ['received', 'inspection'], to: null },
  ship_exchange: { from: ['exchange_pending'], to: 'exchanged' },
  complete: { from: ['refunded', 'exchanged'], to: 'completed' },
  cancel: { from: ['requested', 'under_review', 'info_requested', 'approved', 'pickup_scheduled'], to: 'cancelled' },
};
export const actionsFor = (status: string): Action[] => (Object.keys(RETURN_FLOW) as Action[]).filter(a => RETURN_FLOW[a].from.includes(status as ReturnStatus));

// ---------------------------------------------------------------- settings
export async function returnSettings(q: Queryable): Promise<{ enabled: boolean; windowDays: number | null }> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['returns.enabled', 'returns.window_days']).execute();
  const v = (k: string) => rows.find(r => r.key === k)?.value;
  const days = Number(v('returns.window_days'));
  return { enabled: v('returns.enabled') === 'on', windowDays: Number.isInteger(days) && days > 0 ? days : null };
}

async function event(tx: Tx, returnId: string, from: string | null, to: string, note: string | null, actor: { type: 'customer' | 'staff' | 'system'; staffId?: string | null }) {
  await tx.insertInto('return_events').values({ return_id: returnId, from_status: from, to_status: to, note, actor_type: actor.type, staff_user_id: actor.staffId ?? null }).execute();
}

/** Units of each order line already in other (not rejected / cancelled) return requests. */
async function alreadyReturned(q: Queryable, orderId: string, exceptReturnId?: string) {
  let query = q.selectFrom('return_items as i').innerJoin('return_requests as r', 'r.id', 'i.return_id')
    .select(['i.order_item_id', sql<number>`sum(i.qty)::int`.as('qty')]).where('r.order_id', '=', orderId).where('r.status', 'not in', ['rejected', 'cancelled'])
    .groupBy('i.order_item_id');
  if (exceptReturnId) query = query.where('r.id', '<>', exceptReturnId);
  return new Map((await query.execute()).map(r => [r.order_item_id, r.qty]));
}

// ---------------------------------------------------------------- customer side (store)
/** Whether this customer may request a return for this order now, and the lines and quantities they can choose. */
export async function customerReturnOptions(db: Db, p: CustomerPrincipal, orderNumber: string) {
  const s = await returnSettings(db);
  const o = await db.selectFrom('orders').select(['id', 'order_number', 'status']).where('order_number', '=', orderNumber).where('customer_id', '=', p.customerId).executeTakeFirst();
  if (!o) throw new NotFoundError('Order not found.');
  const requests = await db.selectFrom('return_requests').select(['number', 'status', 'requested_at']).where('order_id', '=', o.id).orderBy('requested_at', 'desc').execute();
  const closed = (reason: string) => ({ allowed: false as const, reason, requests, lines: [], reasons: [] });
  if (!s.enabled || !s.windowDays) return closed('Returns are not offered. All sales are final.');
  if (o.status !== 'delivered') return closed('A return can be requested once the order has been delivered.');
  const d = await db.selectFrom('order_status_history').select(sql<Date>`max(created_at)`.as('at')).where('order_id', '=', o.id).where('to_status', '=', 'delivered').executeTakeFirst();
  const deliveredAt = d?.at ? new Date(d.at) : null;
  const until = deliveredAt ? new Date(deliveredAt.getTime() + s.windowDays * 86_400_000) : null;
  if (!until || until < new Date()) return closed(`The ${s.windowDays}-day return window for this order has ended.`);
  const taken = await alreadyReturned(db, o.id);
  const items = await db.selectFrom('order_items').select(['id', 'name', 'size', 'colour', 'sku', 'qty', 'unit_price_paise']).where('order_id', '=', o.id).orderBy('name').execute();
  const lines = items.map(i => ({ ...i, returnable: Math.max(0, i.qty - (taken.get(i.id) ?? 0)) })).filter(i => i.returnable > 0);
  if (!lines.length) return closed('Every item of this order is already in a return request.');
  const reasons = await db.selectFrom('return_reasons').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute();
  return { allowed: true as const, reason: null, until, requests, lines, reasons };
}

export async function requestReturn(db: Db, p: CustomerPrincipal, input: { orderNumber: string; reasonCode: string; description: string | null; items: { orderItemId: string; qty: number }[] }, ctx: RequestContext) {
  const opts = await customerReturnOptions(db, p, input.orderNumber);
  if (!opts.allowed) throw new ForbiddenError(opts.reason);
  if (!opts.reasons.some(r => r.code === input.reasonCode)) throw new DomainError('invalid', 'Choose a reason.');
  const created = await db.transaction().execute(async tx => {
    const o = await tx.selectFrom('orders').select(['id', 'order_number']).where('order_number', '=', input.orderNumber).where('customer_id', '=', p.customerId)
      .forUpdate().executeTakeFirstOrThrow();
    const taken = await alreadyReturned(tx, o.id);
    const lines = await tx.selectFrom('order_items').select(['id', 'qty']).where('order_id', '=', o.id).execute();
    for (const it of input.items) {
      const l = lines.find(x => x.id === it.orderItemId);
      if (!l) throw new NotFoundError('One of the items is not part of this order.');
      if (it.qty > l.qty - (taken.get(l.id) ?? 0)) throw new ConflictError('You chose more units than can still be returned for one of the items.');
    }
    const r = await tx.insertInto('return_requests').values({ order_id: o.id, customer_id: p.customerId, reason_code: input.reasonCode, description: input.description })
      .returning(['id', 'number']).executeTakeFirstOrThrow();
    await tx.insertInto('return_items').values(input.items.map(i => ({ return_id: r.id, order_item_id: i.orderItemId, qty: i.qty }))).execute();
    await event(tx, r.id, null, 'requested', null, { type: 'customer' });
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'return.request', entityType: 'return_requests', entityId: r.id,
      after: { order_number: o.order_number, reason: input.reasonCode, items: input.items }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { id: r.id, number: r.number, orderNumber: o.order_number };
  });
  await raiseAlertSafely(db, { kind: 'return.requested', title: `Return ${created.number} requested for order ${created.orderNumber}`, entityType: 'return_requests',
    entityId: created.id, link: `/returns/${created.id}`, dedupeKey: `return.requested:${created.id}` });
  return created;
}

export async function listCustomerReturns(db: Db, p: CustomerPrincipal) {
  const rows = await db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id')
    .select(['r.id', 'r.number', 'r.status', 'r.resolution', 'r.requested_at', 'r.updated_at', 'o.order_number'])
    .where('r.customer_id', '=', p.customerId).orderBy('r.requested_at', 'desc').execute();
  return rows;
}

export async function getCustomerReturn(db: Db, p: CustomerPrincipal, number: string) {
  const r = await db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id').innerJoin('return_reasons as rr', 'rr.code', 'r.reason_code')
    .select(['r.id', 'r.number', 'r.status', 'r.resolution', 'r.description', 'r.requested_at', 'r.pickup_at', 'r.refund_amount_paise', 'o.order_number', 'rr.label as reason'])
    .where('r.number', '=', number).where('r.customer_id', '=', p.customerId).executeTakeFirst();
  if (!r) throw new NotFoundError('Return not found.');
  const items = await db.selectFrom('return_items as i').innerJoin('order_items as oi', 'oi.id', 'i.order_item_id')
    .select(['i.id', 'oi.name', 'oi.size', 'oi.colour', 'i.qty']).where('i.return_id', '=', r.id).execute();
  // Customers see the status history, but never staff-only notes.
  const events = await db.selectFrom('return_events').select(['to_status', 'created_at']).where('return_id', '=', r.id).orderBy('created_at').orderBy('id').execute();
  return { ...r, items, events };
}

export async function cancelReturnByCustomer(db: Db, p: CustomerPrincipal, input: { returnNumber: string }, ctx: RequestContext) {
  await db.transaction().execute(async tx => {
    const r = await tx.selectFrom('return_requests').select(['id', 'status']).where('number', '=', input.returnNumber).where('customer_id', '=', p.customerId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Return not found.');
    if (!['requested', 'under_review', 'info_requested'].includes(r.status)) throw new ConflictError('This return can no longer be cancelled online. Contact us.');
    await tx.updateTable('return_requests').set({ status: 'cancelled' }).where('id', '=', r.id).execute();
    await event(tx, r.id, r.status, 'cancelled', 'Cancelled by the customer', { type: 'customer' });
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'return.cancel', entityType: 'return_requests', entityId: r.id,
      before: { status: r.status }, after: { status: 'cancelled' }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
  });
}

// ---------------------------------------------------------------- staff side
export async function listReturns(db: Db, actor: StaffPrincipal, query: { q?: string; status: string; page: number }) {
  requirePermission(actor, 'returns.read');
  let q = db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id').leftJoin('customers as c', 'c.id', 'r.customer_id')
    .innerJoin('return_reasons as rr', 'rr.code', 'r.reason_code')
    .select(['r.id', 'r.number', 'r.status', 'r.resolution', 'r.requested_at', 'r.updated_at', 'r.refund_amount_paise', 'o.id as order_id', 'o.order_number',
      'c.email as customer_email', 'rr.label as reason', sql<number>`(select coalesce(sum(i.qty), 0)::int from public.return_items i where i.return_id = r.id)`.as('units')]);
  if (query.status === 'open') q = q.where('r.status', 'in', [...OPEN]);
  else if (query.status !== 'all') q = q.where('r.status', '=', query.status as ReturnStatus);
  if (query.q) { const t = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('r.number', 'ilike', t), eb('o.order_number', 'ilike', t), eb('c.email', 'ilike', t)])); }
  const rows = await q.orderBy('r.requested_at', 'desc').limit(RETURN_PAGE_SIZE + 1).offset((query.page - 1) * RETURN_PAGE_SIZE).execute();
  const counts = await db.selectFrom('return_requests').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
  return { rows: rows.slice(0, RETURN_PAGE_SIZE), hasNext: rows.length > RETURN_PAGE_SIZE, counts: Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number> };
}

/** Money on the order that can still be refunded: captured payments minus refunds that are processed or still pending. */
export async function refundable(q: Queryable, orderId: string) {
  const pays = await q.selectFrom('payments').select(['id', 'provider', 'provider_payment_id', 'amount_paise', 'currency', 'status'])
    .where('order_id', '=', orderId).where('status', 'in', ['captured', 'partially_refunded', 'refunded']).orderBy('created_at').execute();
  const refunded = await q.selectFrom('refunds').select(['payment_id', sql<number>`coalesce(sum(amount_paise), 0)::int`.as('n')])
    .where('order_id', '=', orderId).where('status', 'in', ['requested', 'pending', 'processed']).groupBy('payment_id').execute();
  const used = new Map(refunded.map(r => [r.payment_id, r.n]));
  return pays.map(p => ({ ...p, left: p.amount_paise - (used.get(p.id) ?? 0) }));
}

export async function getReturn(db: Db, actor: StaffPrincipal, returnId: string) {
  requirePermission(actor, 'returns.read');
  const r = await db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id').leftJoin('customers as c', 'c.id', 'r.customer_id')
    .innerJoin('return_reasons as rr', 'rr.code', 'r.reason_code')
    .select(['r.id', 'r.number', 'r.status', 'r.resolution', 'r.reason_code', 'rr.label as reason', 'r.description', 'r.staff_note', 'r.pickup_at', 'r.pickup_ref',
      'r.received_at', 'r.inspection_result', 'r.inspection_note', 'r.refund_amount_paise', 'r.requested_at', 'r.updated_at', 'r.completed_at',
      'o.id as order_id', 'o.order_number', 'o.status as order_status', 'o.total_paise', 'o.payment_status', 'c.id as customer_id', 'c.email as customer_email', 'c.full_name as customer_name'])
    .where('r.id', '=', returnId).executeTakeFirst();
  if (!r) throw new NotFoundError('Return not found.');
  const [items, events, refunds, payments] = await Promise.all([
    db.selectFrom('return_items as i').innerJoin('order_items as oi', 'oi.id', 'i.order_item_id').leftJoin('product_variants as ev', 'ev.id', 'i.exchange_variant_id')
      .select(['i.id', 'i.order_item_id', 'oi.name', 'oi.size', 'oi.colour', 'oi.sku', 'oi.variant_id', 'oi.product_id', 'oi.unit_price_paise', 'i.qty', 'i.restock', 'i.restocked_qty',
        'i.exchange_variant_id', 'ev.size as exchange_size', 'ev.sku as exchange_sku']).where('i.return_id', '=', returnId).execute(),
    db.selectFrom('return_events as e').leftJoin('staff_users as s', 's.id', 'e.staff_user_id')
      .select(['e.id', 'e.from_status', 'e.to_status', 'e.note', 'e.actor_type', 'e.created_at', 's.email as staff_email']).where('e.return_id', '=', returnId).orderBy('e.created_at').orderBy('e.id').execute(),
    db.selectFrom('refunds as f').leftJoin('staff_users as s', 's.id', 'f.processed_by')
      .select(['f.id', 'f.amount_paise', 'f.status', 'f.method', 'f.reference', 'f.provider_refund_id', 'f.failure_reason', 'f.reason', 'f.created_at', 'f.processed_at', 's.email as processed_by_email'])
      .where('f.return_id', '=', returnId).orderBy('f.created_at').execute(),
    refundable(db, r.order_id),
  ]);
  const sizes = await db.selectFrom('product_variants').select(['id', 'product_id', 'size', 'sku', 'stock_qty', 'is_active'])
    .where('product_id', 'in', [...new Set(items.map(i => i.product_id).filter((x): x is string => !!x)), '__none__']).orderBy('sort_order').execute();
  const itemsValuePaise = items.reduce((n, i) => n + i.unit_price_paise * i.qty, 0);
  return { ret: r, items, events: events.map(e => ({ ...e, id: String(e.id) })), refunds, payments, sizes, itemsValuePaise, actions: actionsFor(r.status) };
}

/** A staff step in the workflow. Each step checks the current status; the event and audit are written with it. */
export async function returnAction(db: Db, actor: StaffPrincipal,
  input: { returnId: string; action: Action | 'restock'; note: string | null; resolution?: 'refund' | 'exchange'; pickupAt: Date | null; pickupRef: string | null;
    inspectionResult?: 'ok' | 'damaged' | 'not_returnable'; refundAmount: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'returns.manage');
  if (input.action === 'restock') throw new DomainError('invalid', 'Restock items from the item list.');
  const flow = RETURN_FLOW[input.action];
  if (!flow) throw new DomainError('invalid', 'Unknown step.');
  return db.transaction().execute(async tx => {
    const r = await tx.selectFrom('return_requests').selectAll().where('id', '=', input.returnId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Return not found.');
    if (!flow.from.includes(r.status as ReturnStatus)) throw new ConflictError(`This return is ${r.status.replace(/_/g, ' ')}; that step is not possible now. Reload the page.`);
    const set: Record<string, unknown> = {};
    let to = flow.to as ReturnStatus;
    switch (input.action) {
      case 'request_info': case 'reject':
        if (!input.note) throw new DomainError('invalid', input.action === 'reject' ? 'Give the reason (the customer sees the status only; the reason is kept here).' : 'Say what information is needed.');
        break;
      case 'approve':
        if (!input.resolution) throw new DomainError('invalid', 'Choose refund or exchange.');
        set.resolution = input.resolution;
        break;
      case 'schedule_pickup':
        if (!input.pickupAt) throw new DomainError('invalid', 'Choose the pickup date and time.');
        set.pickup_at = input.pickupAt; set.pickup_ref = input.pickupRef;
        break;
      case 'receive':
        set.received_at = sql<Date>`now()`;
        break;
      case 'inspect':
        if (!input.inspectionResult) throw new DomainError('invalid', 'Choose the inspection result.');
        set.inspection_result = input.inspectionResult; set.inspection_note = input.note;
        if (input.inspectionResult === 'not_returnable') to = 'rejected';
        else if (r.resolution === 'exchange') to = 'exchange_pending';
        else {
          to = 'refund_pending';
          if (input.refundAmount !== null) set.refund_amount_paise = input.refundAmount;
        }
        break;
      case 'ship_exchange': {
        const items = await tx.selectFrom('return_items').select(['id', 'qty', 'exchange_variant_id']).where('return_id', '=', r.id).execute();
        if (items.some(i => !i.exchange_variant_id)) throw new ConflictError('Choose the replacement size for every item first.');
        const o = await tx.selectFrom('orders').select('order_number').where('id', '=', r.order_id).executeTakeFirstOrThrow();
        for (const i of items) {
          try {
            await sql`select public.adjust_stock(${i.exchange_variant_id}::uuid, ${-i.qty}::int, 'exchange', ${actor.staffId}::uuid, ${`Exchange ${r.number} (order ${o.order_number})`}::text, ${r.order_id}::uuid)`.execute(tx);
          } catch (e) {
            if ((e as { code?: string }).code === '23514') throw new ConflictError('A replacement size is out of stock.');
            throw e;
          }
        }
        break;
      }
      case 'complete':
        set.completed_at = sql<Date>`now()`;
        break;
    }
    if (input.note && !['inspect'].includes(input.action)) set.staff_note = input.note;
    set.status = to;
    await tx.updateTable('return_requests').set(set).where('id', '=', r.id).execute();
    await event(tx, r.id, r.status, to, input.note, { type: 'staff', staffId: actor.staffId });
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: `return.${input.action}`, entityType: 'return_requests', entityId: r.id,
      before: { status: r.status }, after: { status: to, ...Object.fromEntries(Object.entries(set).filter(([k]) => !['received_at', 'completed_at'].includes(k))) } });
    return { number: r.number, from: r.status, to };
  });
}

/** Staff: how many units of a returned line go back into stock (through the ledger), and the replacement size for an exchange. */
export async function updateReturnItem(db: Db, actor: StaffPrincipal, input: { returnId: string; returnItemId: string; restockQty?: number; exchangeVariantId?: string }, ctx: MutationContext) {
  requirePermission(actor, 'returns.manage');
  return db.transaction().execute(async tx => {
    const r = await tx.selectFrom('return_requests').select(['id', 'number', 'status', 'order_id', 'resolution']).where('id', '=', input.returnId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Return not found.');
    const i = await tx.selectFrom('return_items as i').innerJoin('order_items as oi', 'oi.id', 'i.order_item_id')
      .select(['i.id', 'i.qty', 'i.restocked_qty', 'i.exchange_variant_id', 'oi.variant_id', 'oi.product_id'])
      .where('i.id', '=', input.returnItemId).where('i.return_id', '=', r.id).executeTakeFirst();
    if (!i) throw new NotFoundError('Item not found.');
    const changes: Record<string, unknown> = {};
    if (input.restockQty !== undefined && input.restockQty > 0) {
      if (!['received', 'inspection', 'refund_pending', 'refunded', 'exchange_pending', 'exchanged', 'completed', 'rejected'].includes(r.status) || (r.status === 'rejected' && !(await tx.selectFrom('return_requests').select('received_at').where('id', '=', r.id).executeTakeFirst())?.received_at))
        throw new ConflictError('Items can be put back into stock once they have been received.');
      if (!i.variant_id) throw new ConflictError('This size no longer exists, so it cannot be restocked.');
      if (i.restocked_qty + input.restockQty > i.qty) throw new ConflictError(`Only ${i.qty - i.restocked_qty} more can be restocked for this item.`);
      await sql`select public.adjust_stock(${i.variant_id}::uuid, ${input.restockQty}::int, 'return', ${actor.staffId}::uuid, ${`Return ${r.number}`}::text, ${r.order_id}::uuid)`.execute(tx);
      await tx.updateTable('return_items').set({ restocked_qty: i.restocked_qty + input.restockQty, restock: true }).where('id', '=', i.id).execute();
      changes.restocked = input.restockQty;
    }
    if (input.exchangeVariantId && input.exchangeVariantId !== i.exchange_variant_id) {
      if (r.resolution !== 'exchange' || ['exchanged', 'completed', 'cancelled', 'rejected'].includes(r.status)) throw new ConflictError('A replacement size can be chosen for an open exchange only.');
      const v = await tx.selectFrom('product_variants').select(['id', 'product_id', 'is_active']).where('id', '=', input.exchangeVariantId).executeTakeFirst();
      if (!v || v.product_id !== i.product_id || !v.is_active) throw new DomainError('invalid', 'Choose an active size of the same product.');
      await tx.updateTable('return_items').set({ exchange_variant_id: v.id }).where('id', '=', i.id).execute();
      changes.exchange_variant_id = v.id;
    }
    if (!Object.keys(changes).length) return { changed: false };
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'return.item_update', entityType: 'return_requests', entityId: r.id, after: { item: i.id, ...changes } });
    return { changed: true, ...changes };
  });
}

export async function markPaymentRefunded(tx: Tx, orderId: string, paymentId: string) {
  const [p] = await refundable(tx, orderId).then(ps => ps.filter(x => x.id === paymentId));
  const processed = await tx.selectFrom('refunds').select(sql<number>`coalesce(sum(amount_paise), 0)::int`.as('n')).where('payment_id', '=', paymentId).where('status', '=', 'processed').executeTakeFirstOrThrow();
  if (!p) return;
  const full = processed.n >= p.amount_paise;
  await tx.updateTable('payments').set({ status: full ? 'refunded' : 'partially_refunded' }).where('id', '=', paymentId).execute();
  const all = await refundable(tx, orderId);
  const allProcessed = await tx.selectFrom('refunds').select(sql<number>`coalesce(sum(amount_paise), 0)::int`.as('n')).where('order_id', '=', orderId).where('status', '=', 'processed').executeTakeFirstOrThrow();
  const captured = all.reduce((n, x) => n + x.amount_paise, 0);
  await tx.updateTable('orders').set({ payment_status: allProcessed.n >= captured ? 'refunded' : 'partially_refunded' }).where('id', '=', orderId).execute();
}

/** Refunds a return: through the payment provider (when it can refund), or recorded as paid by staff outside the platform
    with the reference. Needs refunds.create. */
export async function refundReturn(db: Db, actor: StaffPrincipal, provider: PaymentProvider | null,
  input: { returnId: string; mode: 'provider' | 'manual'; amount: number; reference: string | null; note: string }, ctx: MutationContext) {
  requirePermission(actor, 'returns.manage');
  requirePermission(actor, 'refunds.create');
  // 1. Record the refund (pending) with every check under lock.
  const pending = await db.transaction().execute(async tx => {
    const r = await tx.selectFrom('return_requests').select(['id', 'number', 'status', 'order_id']).where('id', '=', input.returnId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Return not found.');
    if (r.status !== 'refund_pending') throw new ConflictError('A refund can be made once the return is inspected and waiting for its refund.');
    const open = await tx.selectFrom('refunds').select('id').where('return_id', '=', r.id).where('status', 'in', ['requested', 'pending']).executeTakeFirst();
    if (open) throw new ConflictError('A refund for this return is already in progress.');
    const pays = (await refundable(tx, r.order_id)).filter(p => p.left > 0);
    const pay = pays.find(p => p.left >= input.amount);
    if (!pay) throw new ConflictError(`At most ${(Math.max(0, ...pays.map(p => p.left)) / 100).toFixed(2)} can be refunded on this order's payment.`);
    if (input.mode === 'provider') {
      if (!provider?.refund || provider.code !== pay.provider)
        throw new ConflictError(`Refunds through ${pay.provider} are not available from the admin. Refund it in the provider's dashboard or by bank transfer, then record it here as a manual refund with its reference.`);
      if (!pay.provider_payment_id) throw new ConflictError('This payment has no provider payment id, so the provider cannot refund it. Record a manual refund instead.');
    }
    const o = await tx.selectFrom('orders').select('order_number').where('id', '=', r.order_id).executeTakeFirstOrThrow();
    const f = await tx.insertInto('refunds').values({ payment_id: pay.id, order_id: r.order_id, return_id: r.id, amount_paise: input.amount, reason: input.note,
      status: input.mode === 'manual' ? 'processed' : 'pending', method: input.mode, reference: input.reference, requested_by: actor.staffId,
      ...(input.mode === 'manual' ? { processed_at: sql<Date>`now()`, processed_by: actor.staffId } : {}) }).returning('id').executeTakeFirstOrThrow();
    if (input.mode === 'manual') {
      await markPaymentRefunded(tx, r.order_id, pay.id);
      await tx.updateTable('return_requests').set({ status: 'refunded', refund_amount_paise: input.amount }).where('id', '=', r.id).execute();
      await event(tx, r.id, r.status, 'refunded', `Refund recorded as paid outside the platform (${input.reference})`, { type: 'staff', staffId: actor.staffId });
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.mode === 'manual' ? 'refund.manual_record' : 'refund.provider_request', entityType: 'refunds', entityId: f.id,
      after: { amount_paise: input.amount, method: input.mode, reference: input.reference, status: input.mode === 'manual' ? 'processed' : 'pending' },
      metadata: { return_number: r.number, order_number: o.order_number, payment_id: pay.id, note: input.note } });
    return { refundId: f.id, number: r.number, orderId: r.order_id, orderNumber: o.order_number, payment: pay };
  });
  if (input.mode === 'manual') return { status: 'processed' as const, number: pending.number };

  // 2. Ask the provider (outside any transaction), then record exactly what it answered.
  let answer: Awaited<ReturnType<NonNullable<PaymentProvider['refund']>>> | null = null; let failure: string | null = null;
  try {
    answer = await provider!.refund!({ paymentId: pending.payment.provider_payment_id!, amountPaise: input.amount, currency: pending.payment.currency,
      notes: { return_number: pending.number, order_number: pending.orderNumber } });
    if (answer.status === 'failed') failure = 'The provider reported the refund as failed.';
  } catch (e) {
    failure = e instanceof DomainError ? e.message : `The provider did not accept the refund: ${String((e as Error).message ?? e).slice(0, 200)}`;
  }
  await db.transaction().execute(async tx => {
    const r = await tx.selectFrom('return_requests').select(['id', 'status']).where('id', '=', input.returnId).forUpdate().executeTakeFirstOrThrow();
    if (failure) {
      await tx.updateTable('refunds').set({ status: 'failed', failure_reason: failure.slice(0, 300), provider_refund_id: answer?.id ?? null }).where('id', '=', pending.refundId).execute();
      await event(tx, r.id, r.status, r.status, `Refund failed: ${failure}`.slice(0, 1000), { type: 'system' });
    } else {
      const done = answer!.status === 'processed';
      await tx.updateTable('refunds').set({ status: done ? 'processed' : 'pending', provider_refund_id: answer!.id, ...(done ? { processed_at: sql<Date>`now()`, processed_by: actor.staffId } : {}) })
        .where('id', '=', pending.refundId).execute();
      if (done) {
        await markPaymentRefunded(tx, pending.orderId, pending.payment.id);
        await tx.updateTable('return_requests').set({ status: 'refunded', refund_amount_paise: input.amount }).where('id', '=', r.id).execute();
        await event(tx, r.id, r.status, 'refunded', `Refunded through ${pending.payment.provider} (${answer!.id})`, { type: 'system' });
      } else {
        await event(tx, r.id, r.status, r.status, `Refund ${answer!.id} accepted by ${pending.payment.provider}; waiting for it to be processed`, { type: 'system' });
      }
    }
    await recordAudit(tx, { actorType: 'system', action: failure ? 'refund.provider_failed' : 'refund.provider_answer', entityType: 'refunds', entityId: pending.refundId,
      after: failure ? { status: 'failed', failure_reason: failure } : { status: answer!.status, provider_refund_id: answer!.id } });
  });
  if (failure) {
    await raiseAlertSafely(db, { kind: 'refund.failed', title: `Refund failed for return ${pending.number}`, body: failure, entityType: 'return_requests', entityId: input.returnId, link: `/returns/${input.returnId}` });
    throw new ConflictError(`${failure} Nothing was refunded.`);
  }
  return { status: answer!.status, number: pending.number };
}

/** Customer email about a return (approved, rejected, information needed, completed) or a refund; only when switched on. */
export async function notifyReturn(db: Db, mailer: Mailer, returnId: string, kind: 'status' | 'refund', opts: { storeUrl?: string | null } = {}) {
  return sendCustomerEmail(db, mailer, kind === 'refund' ? 'refund.processed' : 'return.status', async () => {
    const r = await db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id')
      .select(['r.number', 'r.status', 'r.refund_amount_paise', 'o.id as order_id', 'o.order_number', 'o.contact']).where('r.id', '=', returnId).executeTakeFirst();
    if (!r) return null;
    const contact = (r.contact ?? {}) as Record<string, unknown>;
    const to = typeof contact.email === 'string' ? contact.email : '';
    const link = storeLink(opts.storeUrl, `/account/returns/${r.number}`, 'Your return');
    if (kind === 'refund') {
      if (r.status !== 'refunded' || !r.refund_amount_paise) return null;
      return { to, orderId: r.order_id, subject: `Refund for your KITSYUU return ${r.number}`, text: [hello(contact.name), '',
        `A refund of ₹${(r.refund_amount_paise / 100).toFixed(2)} for return ${r.number} (order ${r.order_number}) has been made.`,
        'How long it takes to reach your account depends on your bank or payment method.', '', ...link].join('\n') };
    }
    const lines: Record<string, string> = {
      approved: `Your return ${r.number} for order ${r.order_number} has been approved. We will contact you about the next step.`,
      rejected: `Your return request ${r.number} for order ${r.order_number} could not be accepted. Reply to this email if you have questions.`,
      info_requested: `We need a little more information about your return ${r.number}. Please reply to this email.`,
      completed: `Your return ${r.number} for order ${r.order_number} is complete.`,
    };
    if (!lines[r.status]) return null;
    return { to, orderId: r.order_id, subject: `Your KITSYUU return ${r.number}`, text: [hello(contact.name), '', lines[r.status], '', ...link].join('\n') };
  });
}

/** Returns and refunds for a period: requests by status and reason, units restocked, refunds by method and status. */
export async function returnsReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'returns.read');
  const inRange = (col: string) => sql<boolean>`(${sql.ref(col)} at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`;
  const [byStatus, byReason, refunds, restocked] = await Promise.all([
    db.selectFrom('return_requests as r').select(['r.status', sql<number>`count(*)::int`.as('n')]).where(inRange('r.requested_at')).groupBy('r.status').execute(),
    db.selectFrom('return_requests as r').innerJoin('return_reasons as rr', 'rr.code', 'r.reason_code').select(['rr.label', sql<number>`count(*)::int`.as('n')])
      .where(inRange('r.requested_at')).groupBy('rr.label').orderBy(sql`count(*)`, 'desc').execute(),
    db.selectFrom('refunds as f').select(['f.method', 'f.status', sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(f.amount_paise), 0)::int`.as('paise')])
      .where(inRange('f.created_at')).groupBy(['f.method', 'f.status']).execute(),
    db.selectFrom('inventory_movements as m').select(sql<number>`coalesce(sum(m.delta), 0)::int`.as('units')).where('m.reason', '=', 'return').where(inRange('m.created_at')).executeTakeFirstOrThrow(),
  ]);
  return { byStatus, byReason, refunds, restockedUnits: restocked.units };
}
