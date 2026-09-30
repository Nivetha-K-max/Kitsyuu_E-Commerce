/* ERP module 8: customer emails for the new workflows (delivery, returns, refunds, support replies, abandoned carts).
   Same rules as the M17 order emails (engagement.ts): each email has its own switch in Settings → Customer emails and is
   OFF until the business turns it on; every attempt is written to notification_log (sent / failed); a failed email is
   logged and never undoes or blocks the change that caused it. Messages state facts only (no promised dates or amounts
   beyond what was recorded). The mailer is whatever the deployment configured (MAILER): with no real provider set up,
   the console mailer only logs the message; nothing pretends it was delivered. */
import type { Db, Queryable } from '@kitsyuu/db';
import type { Mailer, MailMessage } from '@kitsyuu/auth';

export const CUSTOMER_EMAILS = {
  'order.delivered': 'notifications.order_delivered',
  'return.status': 'notifications.return_status',
  'refund.processed': 'notifications.refund_processed',
  'support.reply': 'notifications.support_reply',
  'cart.reminder': 'notifications.abandoned_cart',
} as const;
export type CustomerEmailEvent = keyof typeof CUSTOMER_EMAILS;

export async function customerEmailEnabled(q: Queryable, event: CustomerEmailEvent): Promise<boolean> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', CUSTOMER_EMAILS[event]).executeTakeFirst();
  return r?.value === 'on';
}

export type EmailResult = { sent: true } | { sent: false; reason: 'off' | 'no_recipient' | 'failed' | 'error' };

/** Sends one customer email when its switch is on, and logs the attempt. Never throws. */
export async function sendCustomerEmail(db: Db, mailer: Mailer, event: CustomerEmailEvent, build: () => Promise<(MailMessage & { orderId?: string | null }) | null>): Promise<EmailResult> {
  try {
    if (!(await customerEmailEnabled(db, event))) return { sent: false, reason: 'off' };
    const m = await build();
    if (!m || !m.to) return { sent: false, reason: 'no_recipient' };
    let error: string | null = null;
    try { await mailer.send({ to: m.to, subject: m.subject, text: m.text }); } catch (e) { error = String((e as Error).message ?? e).slice(0, 500); }
    await db.insertInto('notification_log').values({ event, order_id: m.orderId ?? null, recipient: m.to, subject: m.subject.slice(0, 200), status: error ? 'failed' : 'sent', error }).execute();
    return error ? { sent: false, reason: 'failed' } : { sent: true };
  } catch (e) {
    console.error(`[notifications] ${event} email could not be prepared`, e);
    return { sent: false, reason: 'error' };
  }
}

export const hello = (name: unknown) => `Hello${typeof name === 'string' && name.trim() ? ' ' + name.trim() : ''},`;
export const storeLink = (storeUrl: string | null | undefined, path: string, label: string) => (storeUrl ? [`${label}: ${new URL(path, storeUrl).toString()}`] : []);
