/* ERP module 8: customer emails for the new workflows (delivery, returns, refunds, support replies, abandoned carts).
   Same rules as the M17 order emails (engagement.ts): each email has its own switch in Configuration → Customer emails and is
   OFF until the business turns it on; every attempt is written to notification_log (sent / failed); a failed email is
   logged and never undoes or blocks the change that caused it. Messages state facts only (no promised dates or amounts
   beyond what was recorded). The mailer is whatever the deployment configured (MAILER): with no real provider set up,
   the console mailer only logs the message; nothing pretends it was delivered.
   2026-10-08: sending itself is the transactional email service (transactional-email.ts: switch, no duplicates for an
   order, a quick second try, the log, the later retry). This file keeps the names the workflows already use. */
import type { Db, Queryable } from '@kitsyuu/db';
import type { Mailer, MailMessage } from '@kitsyuu/auth';
import { emailEnabled, sendTransactionalEmail, type TransactionalEmailResult } from './transactional-email.ts';

export const CUSTOMER_EMAILS = {
  'order.delivered': 'notifications.order_delivered',
  'return.status': 'notifications.return_status',
  'refund.processed': 'notifications.refund_processed',
  'support.reply': 'notifications.support_reply',
  'cart.reminder': 'notifications.abandoned_cart',
  'checkout.reminder': 'notifications.abandoned_checkout',
  // Commerce workflows (2026-10-01): workflow-emails.ts.
  'order.packed': 'notifications.order_packed',
  'order.payment_request': 'notifications.payment_request',
  'cart.auto_reminder': 'notifications.abandoned_cart_auto',
  // 2026-10-08: tracking details added or changed after dispatch, or the parcel is in transit.
  'order.tracking': 'notifications.order_tracking',
} as const;
export type CustomerEmailEvent = keyof typeof CUSTOMER_EMAILS;

export const customerEmailEnabled = (q: Queryable, event: CustomerEmailEvent): Promise<boolean> => emailEnabled(q, event);

export type EmailResult = TransactionalEmailResult;

/** Sends one customer email when its switch is on, and logs the attempt. About an order (orderId set), the same email is
    sent once. Never throws. */
export function sendCustomerEmail(db: Db, mailer: Mailer, event: CustomerEmailEvent, build: (q: Queryable) => Promise<(MailMessage & { orderId?: string | null }) | null>): Promise<EmailResult> {
  return sendTransactionalEmail(db, mailer, event, build);
}

export const hello = (name: unknown) => `Hello${typeof name === 'string' && name.trim() ? ' ' + name.trim() : ''},`;
export const storeLink = (storeUrl: string | null | undefined, path: string, label: string) => (storeUrl ? [`${label}: ${new URL(path, storeUrl).toString()}`] : []);
