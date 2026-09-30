/* The one place an order's status changes (M7). Callers (admin status change, payment flow, customer cancellation, payment
   expiry) pass who is acting; the transition is checked against ORDER_TRANSITIONS_BY_ACTOR, the order row must be locked by
   the caller's transaction, and the change is recorded in order_status_history in the same transaction. Stock and audit
   stay with the caller, which knows why the change happens. */
import { sql, type OrderStatus, type Tx } from '@kitsyuu/db';
import { canCodTransition, canTransitionAs, DomainError, type OrderActor } from '@kitsyuu/contracts';

export interface LockedOrder { id: string; order_number: string; status: OrderStatus }

const label = (s: string) => s.replace(/_/g, ' ');

/** Locks the order row for the rest of the transaction and returns its current status. */
export async function lockOrder(tx: Tx, where: { id: string }) {
  const q = tx.selectFrom('orders').select(['id', 'order_number', 'status', 'payment_status', 'customer_id', 'user_id', 'total_paise', 'currency',
    'cart_id', 'payment_expires_at']).where('id', '=', where.id);
  return q.forUpdate().executeTakeFirst();
}

export async function applyOrderTransition(tx: Tx, order: LockedOrder, to: OrderStatus, opts: {
  actor: OrderActor; note?: string | null;
  /** A cash-on-delivery flow (cod.ts / checkout): also allows the COD transitions (COD_TRANSITIONS). */
  cod?: boolean;
  /** Extra columns set with the status (e.g. payment_status, paid_at). */
  set?: { payment_status?: 'unpaid' | 'pending' | 'authorized' | 'paid' | 'failed'; paid_at?: Date };
}): Promise<{ historyId: number; from: OrderStatus; to: OrderStatus }> {
  if (!canTransitionAs(opts.actor, order.status, to) && !(opts.cod && canCodTransition(opts.actor, order.status, to)))
    throw new DomainError('invalid', `An order cannot go from ${label(order.status)} to ${label(to)}.`);
  await tx.updateTable('orders').set({ status: to, ...opts.set }).where('id', '=', order.id).execute();
  const h = await tx.insertInto('order_status_history')
    .values({ order_id: order.id, from_status: order.status, to_status: to, note: opts.note ?? null })
    .returning('id').executeTakeFirstOrThrow();
  return { historyId: h.id, from: order.status, to };
}

/** Closes the payment side of an UNPAID order being cancelled (callers have checked that no payment is authorised or
    captured): an order still waiting for payment becomes 'unpaid', and any payment session that was opened but never used
    ('created') is closed as 'failed' with the reason, since no payment can be completed for a cancelled order any more.
    Declined attempts keep their own status. A payment that still arrives later is recorded against the order and flagged
    for staff (payment.captured_after_cancel), as before. */
export async function closeUnpaidPayments(tx: Tx, orderId: string): Promise<void> {
  await tx.updateTable('orders').set({ payment_status: 'unpaid' }).where('id', '=', orderId).where('payment_status', '=', 'pending').execute();
  await tx.updateTable('payments').set({ status: 'failed', failure_reason: 'Order cancelled before payment' })
    .where('order_id', '=', orderId).where('status', '=', 'created').execute();
}

/** Returns what a cancelled order still holds to stock (ledger reason 'cancel'); a second call returns nothing. */
export async function releaseOrderStock(tx: Tx, orderId: string, note?: string): Promise<number> {
  const r = await sql<{ n: number }>`select public.release_order_stock(${orderId}::uuid, ${note ?? null}::text) as n`.execute(tx);
  return r.rows[0]?.n ?? 0;
}
