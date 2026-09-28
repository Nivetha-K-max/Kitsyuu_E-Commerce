/* Payment operations for staff (M8): payment attempts, provider notifications (webhooks) and payment exceptions.
   Read-mostly: payment records are written by the verified payment flow (checkout.ts, M7), which this module never
   changes. Exceptions are DERIVED from existing payment and order records (no new payment states):
   · captured_after_cancel  money was captured for an order that is cancelled;
   · amount_mismatch        a captured payment's amount or currency differs from the order total;
   · duplicate_capture      an order has more than one captured payment;
   · paid_without_capture   an order is marked paid but has no captured payment record.
   There is no returns/refunds workflow (business decision). The one staff action is recording that money received for
   an already-cancelled order needs a MANUAL refund: a 'requested' refunds row plus an audit record. No provider is called. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, NotFoundError, type PaymentEventListQuery, type PaymentExceptionKind, type PaymentListQuery, type RecordManualRefundInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { lockOrder } from './order-state.ts';
import type { PaymentProvider } from './payments/provider.ts';

export const PAYMENT_PAGE_SIZE = 50;
const like = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;

/** The exception of one payment row (p) of an order (o), or null. One rule, used by lists, the queue and order pages. */
export const paymentExceptionSql = sql<PaymentExceptionKind | null>`case
  when p.status = 'captured' and o.status = 'cancelled' then 'captured_after_cancel'
  when p.status = 'captured' and (p.amount_paise <> o.total_paise or p.currency <> o.currency) then 'amount_mismatch'
  when p.status = 'captured' and exists (select 1 from public.payments p2 where p2.order_id = p.order_id and p2.status = 'captured' and p2.id <> p.id)
    then 'duplicate_capture'
end`;
const manualRefundSql = sql<string | null>`(select r.id::text from public.refunds r where r.payment_id = p.id order by r.created_at limit 1)`;

export async function listPayments(db: Db, actor: StaffPrincipal, query: PaymentListQuery) {
  requirePermission(actor, 'billing.read');
  let q = db.selectFrom('payments as p').innerJoin('orders as o', 'o.id', 'p.order_id')
    .select(['p.id', 'p.provider', 'p.provider_order_id', 'p.provider_payment_id', 'p.amount_paise', 'p.currency', 'p.status', 'p.method',
      'p.failure_reason', 'p.captured_at', 'p.created_at', 'o.id as order_id', 'o.order_number', 'o.status as order_status', 'o.total_paise as order_total_paise',
      sql<string | null>`o.contact->>'email'`.as('customer_email'), paymentExceptionSql.as('exception'), manualRefundSql.as('manual_refund_id')]);
  if (query.q) {
    const l = like(query.q);
    q = q.where(eb => eb.or([eb('o.order_number', 'ilike', l), eb('p.provider_payment_id', 'ilike', l), eb('p.provider_order_id', 'ilike', l),
      sql<boolean>`o.contact->>'email' ilike ${l}`]));
  }
  if (query.status !== 'all') q = q.where('p.status', '=', query.status);
  if (query.provider !== 'all') q = q.where('p.provider', '=', query.provider);
  if (query.exception === 'any') q = q.where(sql<boolean>`(${paymentExceptionSql}) is not null`);
  else if (query.exception !== 'all') q = q.where(sql<boolean>`(${paymentExceptionSql}) = ${query.exception}`);
  const rows = await q.orderBy('p.created_at', 'desc').orderBy('p.id').limit(PAYMENT_PAGE_SIZE + 1).offset((query.page - 1) * PAYMENT_PAGE_SIZE).execute();
  const providers = (await db.selectFrom('payments').select('provider').distinct().orderBy('provider').execute()).map(r => r.provider);
  return { rows: rows.slice(0, PAYMENT_PAGE_SIZE), hasNext: rows.length > PAYMENT_PAGE_SIZE, providers };
}

export interface PaymentException {
  kind: PaymentExceptionKind; orderId: string; orderNumber: string; orderStatus: string; paymentId: string | null; provider: string | null;
  providerPaymentId: string | null; amountPaise: number | null; orderTotalPaise: number; at: Date;
  manualRefund: { id: string; status: string; reason: string; requestedBy: string | null; createdAt: Date } | null;
}

/** Every open or recorded payment exception, newest first (payment-level ones plus orders marked paid without a capture). */
export async function listPaymentExceptions(q: Queryable, opts: { orderId?: string } = {}): Promise<PaymentException[]> {
  let pq = q.selectFrom('payments as p').innerJoin('orders as o', 'o.id', 'p.order_id')
    .leftJoin('refunds as r', join => join.onRef('r.payment_id', '=', 'p.id')).leftJoin('staff_users as s', 's.id', 'r.requested_by')
    .select(['p.id as payment_id', 'p.provider', 'p.provider_payment_id', 'p.amount_paise', 'p.created_at', 'o.id as order_id', 'o.order_number',
      'o.status as order_status', 'o.total_paise', paymentExceptionSql.as('kind'), 'r.id as refund_id', 'r.status as refund_status', 'r.reason as refund_reason',
      'r.created_at as refund_at', 's.email as refund_by'])
    .where(sql<boolean>`(${paymentExceptionSql}) is not null`);
  let oq = q.selectFrom('orders as o').select(['o.id as order_id', 'o.order_number', 'o.status as order_status', 'o.total_paise', 'o.updated_at'])
    .where('o.payment_status', '=', 'paid')
    .where(sql<boolean>`not exists (select 1 from public.payments p where p.order_id = o.id and p.status = 'captured')`);
  if (opts.orderId) { pq = pq.where('o.id', '=', opts.orderId); oq = oq.where('o.id', '=', opts.orderId); }
  const [pay, ord] = await Promise.all([pq.execute(), oq.execute()]);
  const list: PaymentException[] = [
    ...pay.map(r => ({ kind: r.kind as PaymentExceptionKind, orderId: r.order_id, orderNumber: r.order_number, orderStatus: r.order_status, paymentId: r.payment_id,
      provider: r.provider, providerPaymentId: r.provider_payment_id, amountPaise: r.amount_paise, orderTotalPaise: r.total_paise, at: r.created_at as Date,
      manualRefund: r.refund_id ? { id: r.refund_id, status: r.refund_status!, reason: r.refund_reason!, requestedBy: r.refund_by, createdAt: r.refund_at as Date } : null })),
    ...ord.map(r => ({ kind: 'paid_without_capture' as const, orderId: r.order_id, orderNumber: r.order_number, orderStatus: r.order_status, paymentId: null,
      provider: null, providerPaymentId: null, amountPaise: null, orderTotalPaise: r.total_paise, at: r.updated_at as Date, manualRefund: null })),
  ];
  return list.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export async function getPaymentExceptions(db: Db, actor: StaffPrincipal, kind: PaymentExceptionKind | 'all' = 'all') {
  requirePermission(actor, 'billing.read');
  const all = await listPaymentExceptions(db);
  const open = all.filter(e => !e.manualRefund);
  return { rows: kind === 'all' ? all : all.filter(e => e.kind === kind), openCount: open.length };
}

/** Records that money received for an already-cancelled order must be refunded manually. No provider is called. */
export async function recordManualRefund(db: Db, actor: StaffPrincipal, input: RecordManualRefundInput, ctx: MutationContext) {
  requirePermission(actor, 'refunds.create');
  return db.transaction().execute(async tx => {
    const pay = await tx.selectFrom('payments').select(['id', 'order_id', 'status', 'amount_paise', 'currency', 'provider', 'provider_payment_id'])
      .where('id', '=', input.paymentId).executeTakeFirst();
    if (!pay) throw new NotFoundError('Payment not found.');
    const o = (await lockOrder(tx, { id: pay.order_id }))!;
    if (pay.status !== 'captured' || o.status !== 'cancelled')
      throw new ConflictError('Only money received for a cancelled order can be recorded for a manual refund.');
    const existing = await tx.selectFrom('refunds').select('id').where('payment_id', '=', pay.id).executeTakeFirst();
    if (existing) throw new ConflictError('A manual refund is already recorded for this payment.');
    const r = await tx.insertInto('refunds').values({ payment_id: pay.id, order_id: o.id, amount_paise: pay.amount_paise, reason: input.note,
      status: 'requested', requested_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'payment.manual_refund_recorded', entityType: 'orders', entityId: o.id,
      after: { refund_id: r.id, status: 'requested', amount_paise: pay.amount_paise },
      metadata: { order_number: o.order_number, payment_id: pay.id, provider: pay.provider, provider_payment_id: pay.provider_payment_id, note: input.note },
      ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { orderNumber: o.order_number, refundId: r.id, amountPaise: pay.amount_paise };
  });
}

export async function listPaymentEvents(db: Db, actor: StaffPrincipal, query: PaymentEventListQuery) {
  requirePermission(actor, 'billing.read');
  let q = db.selectFrom('payment_events as e').leftJoin('orders as o', 'o.id', 'e.order_id')
    .select(['e.id', 'e.provider', 'e.type', 'e.outcome', 'e.received_at', 'e.processed_at', 'o.id as order_id', 'o.order_number']);
  if (query.q) { const l = like(query.q); q = q.where(eb => eb.or([eb('e.id', 'ilike', l), eb('e.type', 'ilike', l), eb('o.order_number', 'ilike', l)])); }
  if (query.provider !== 'all') q = q.where('e.provider', '=', query.provider);
  if (query.outcome !== 'all') q = q.where('e.outcome', '=', query.outcome);
  const rows = await q.orderBy('e.received_at', 'desc').orderBy('e.id').limit(PAYMENT_PAGE_SIZE + 1).offset((query.page - 1) * PAYMENT_PAGE_SIZE).execute();
  return { rows: rows.slice(0, PAYMENT_PAGE_SIZE), hasNext: rows.length > PAYMENT_PAGE_SIZE };
}

/** How a cancelled order stands with money (for order pages): no money, money received needing attention, or money
    received with a manual refund recorded. null for orders that are not cancelled. */
export async function cancelledOrderPaymentState(q: Queryable, orderId: string, orderStatus: string) {
  if (orderStatus !== 'cancelled') return null;
  const ex = (await listPaymentExceptions(q, { orderId })).filter(e => e.kind === 'captured_after_cancel');
  if (!ex.length) return { kind: 'cancelled_unpaid' as const, exceptions: [] };
  return ex.every(e => e.manualRefund) ? { kind: 'cancelled_paid_refund_recorded' as const, exceptions: ex } : { kind: 'cancelled_payment_exception' as const, exceptions: ex };
}

export interface ReconciliationRow { sessionRef: string; providerPaymentId: string; providerStatus: string; recordedStatus: string | null; result: 'match' | 'missing' | 'differs' }

/** Compares what the payment provider holds for an order's payment sessions with the recorded payments. Read-only: it
    reports differences for staff; it never writes. Needs the order's provider to be configured in this app. */
export async function reconcileOrderPayments(db: Db, actor: StaffPrincipal, providers: Record<string, PaymentProvider>, orderId: string) {
  requirePermission(actor, 'billing.read');
  const sessions = await db.selectFrom('payments').select(['provider', 'provider_order_id']).distinct()
    .where('order_id', '=', orderId).where('provider_order_id', 'is not', null).execute();
  const rows: ReconciliationRow[] = [], unavailable: string[] = [];
  for (const s of sessions) {
    const provider = providers[s.provider];
    const list = provider ? await provider.listPayments(s.provider_order_id!).catch(() => null) : null;
    if (!list) { unavailable.push(s.provider); continue; }
    const recorded = new Map((await db.selectFrom('payments').select(['provider_payment_id', 'status']).where('order_id', '=', orderId)
      .where('provider', '=', s.provider).execute()).map(r => [r.provider_payment_id, r.status]));
    for (const p of list) {
      const rec = recorded.get(p.id) ?? null;
      rows.push({ sessionRef: s.provider_order_id!, providerPaymentId: p.id, providerStatus: p.status, recordedStatus: rec,
        result: rec === null ? 'missing' : rec === p.status ? 'match' : 'differs' });
    }
  }
  return { rows, unavailable: [...new Set(unavailable)] };
}
