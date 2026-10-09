/* Sending again what failed (2026-10-08): the message builders of every order email, by event, for the transactional
   email service's retry (transactional-email.ts → retryTransactionalEmails). The retry knows only the order and the
   subject of the email that failed; each builder here writes that email again from what is recorded now, with the same
   function the workflow used the first time, so a retried email can never differ from a first one.

   Called by the scheduled job (admin: /api/jobs/retry-emails) and, at most every few minutes, when staff open Orders.
   Nothing here changes an order, a payment, a shipment or a return. */
import type { Db } from '@kitsyuu/db';
import type { Mailer } from '@kitsyuu/auth';
import { orderStatusEmail } from './engagement.ts';
import { orderPlacedMessage } from './notifications.ts';
import { returnEmail } from './returns.ts';
import { orderDeliveredEmail } from './shipping-admin.ts';
import { retryTransactionalEmails, type EmailEvent, type EmailRebuilder, type EmailRetryRun } from './transactional-email.ts';
import { orderPackedEmail, orderTrackingEmail, paymentRequestEmail } from './workflow-emails.ts';

export interface EmailRetryOptions {
  /** The store's public address, for the links in the emails (none when unset, as in the first send). */
  storeUrl?: string | null;
  /** The returns-policy line of the order confirmation (the store adds it; staff-side sends have none). */
  policy?: string;
  limit?: number; now?: Date; quickTries?: number[];
}

export function orderEmailRebuilders(opts: EmailRetryOptions = {}): Partial<Record<EmailEvent, EmailRebuilder>> {
  const store = opts.storeUrl || null;
  const withOrder = <T extends object>(orderId: string, m: T | null) => (m ? { ...m, orderId } : null);
  // A return's email: the order may have several returns; the one whose email carries the failed subject is sent again.
  const ofReturn = (kind: 'status' | 'refund'): EmailRebuilder => async (q, ref) => {
    const returns = await q.selectFrom('return_requests').select('id').where('order_id', '=', ref.orderId).execute();
    for (const r of returns) { const m = await returnEmail(q, r.id, kind, { storeUrl: store }); if (m && m.subject === ref.subject) return m; }
    return null;
  };
  return {
    'order.placed': (q, ref) => orderPlacedMessage(q, ref.orderNumber, { orderUrl: store ? new URL(`/account/orders/${encodeURIComponent(ref.orderNumber)}`, store).toString() : '', policy: opts.policy }),
    'order.packed': (q, ref) => orderPackedEmail(q, ref.orderId, store),
    'order.shipped': async (q, ref) => withOrder(ref.orderId, await orderStatusEmail(q, ref.orderId, 'order.shipped', { storeUrl: store })),
    'order.cancelled': async (q, ref) => withOrder(ref.orderId, await orderStatusEmail(q, ref.orderId, 'order.cancelled', { storeUrl: store })),
    'order.tracking': (q, ref) => orderTrackingEmail(q, ref.orderId, store),
    'order.delivered': (q, ref) => orderDeliveredEmail(q, ref.orderId, { storeUrl: store }),
    'order.payment_request': (q, ref) => paymentRequestEmail(q, ref.orderId, store),
    'return.status': ofReturn('status'),
    'refund.processed': ofReturn('refund'),
  };
}

/** Sends again the order emails that failed (up to 5 attempts each, further apart every time, within 72 hours) and the
    order confirmations that were never attempted. Safe to call often and from several places at once. */
export function retryOrderEmails(db: Db, mailer: Mailer, opts: EmailRetryOptions = {}): Promise<EmailRetryRun> {
  return retryTransactionalEmails(db, mailer, orderEmailRebuilders(opts), { limit: opts.limit, now: opts.now, quickTries: opts.quickTries });
}

/** The same, at most once every `everyMs` per server instance and never throwing: for calling after a page was served. */
const g = globalThis as unknown as { __kitsyuuEmailRetryAt?: number };
export async function retryOrderEmailsThrottled(db: Db, mailer: Mailer, opts: EmailRetryOptions = {}, everyMs = 5 * 60_000): Promise<EmailRetryRun | null> {
  const now = Date.now();
  if (g.__kitsyuuEmailRetryAt && now - g.__kitsyuuEmailRetryAt < everyMs) return null;
  g.__kitsyuuEmailRetryAt = now;
  try { return await retryOrderEmails(db, mailer, opts); }
  catch (e) { console.error('[email] retry run failed:', (e as Error).message); return null; }
}
