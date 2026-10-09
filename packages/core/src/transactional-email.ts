/* The transactional email service (2026-10-08): the ONE place a customer email about an order is sent from.

     order / business event  →  sendTransactionalEmail  →  the configured Mailer  →  customer

   The modules that own the work (orders, fulfilment, returns, payments) decide WHEN something happened and what the
   message says; this service does the rest, the same way for every email:
     · is this email switched on? (Configuration → Customer emails; the order confirmation is always sent)
     · has exactly this email already been sent for this order? → nothing is sent twice (a refresh, a retried request,
       a repeated webhook and two servers at once all end here: a per-email lock, then a look at the log)
     · send it, trying again at once when the provider is briefly unavailable
     · write the attempt to notification_log (sent / failed with the provider's answer), which the order's Activity tab,
       Notifications and System already show
   It never throws and never undoes what caused it: an order stays placed when its email could not be sent. A failed
   email is sent again later by retryTransactionalEmails (a scheduled job, and staff opening Orders).

   No queue table: the log is the record of what was sent, and what should have been sent is worked out from the orders
   themselves, so nothing is stored twice. Sending is never a second workflow: this file changes no order, payment,
   shipment or return. */
import { createHash } from 'node:crypto';
import { sql, type Db, type Queryable } from '@kitsyuu/db';
import type { Mailer, MailMessage } from '@kitsyuu/auth';

/** Every customer email and the Configuration switch that turns it on (null = always sent). */
export const EMAIL_EVENTS = {
  'order.placed': null,                                       // order confirmed: paid online, or cash on delivery when it is placed
  'order.packed': 'notifications.order_packed',
  'order.shipped': 'notifications.order_shipped',
  'order.tracking': 'notifications.order_tracking',           // tracking details added or changed after dispatch; parcel in transit
  'order.delivered': 'notifications.order_delivered',
  'order.cancelled': 'notifications.order_cancelled',
  'order.payment_request': 'notifications.payment_request',
  'return.status': 'notifications.return_status',
  'refund.processed': 'notifications.refund_processed',
  // For the payment gateway (not connected to anything yet): the gateway integration calls sendTransactionalEmail with
  // these when a payment fails or is still pending. A successful payment is the order confirmation ('order.placed').
  'payment.failed': 'notifications.payment_failed',
  'payment.pending': 'notifications.payment_pending',
  // Not about one order (no duplicate check, not retried): unchanged behaviour.
  'support.reply': 'notifications.support_reply',
  'cart.reminder': 'notifications.abandoned_cart',
  'checkout.reminder': 'notifications.abandoned_checkout',
  'cart.auto_reminder': 'notifications.abandoned_cart_auto',
} as const;
export type EmailEvent = keyof typeof EMAIL_EVENTS;

export type BuiltEmail = MailMessage & { orderId?: string | null };
export type TransactionalEmailResult = { sent: true } | { sent: false; reason: 'off' | 'no_recipient' | 'duplicate' | 'failed' | 'error' };

export async function emailEnabled(q: Queryable, event: EmailEvent): Promise<boolean> {
  const key = EMAIL_EVENTS[event];
  if (key === null) return true;
  const r = await q.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  return r?.value === 'on';
}

/** How often one email is tried in one go when the provider is briefly unavailable, and the pauses between. */
const QUICK_TRIES = [0, 400, 1200];
/** No further quick try once this much time has gone into the send: the request that caused the email (a checkout) is
    waiting for it. A provider that answers quickly with "try again" gets its second and third try; one that hangs until
    the timeout is tried once, exactly as before the quick tries existed, and the later retry takes over. */
const QUICK_BUDGET_MS = 4000;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A provider error worth trying again: unreachable, timed out, rate limited or a server error (the Mailer marks these). */
const transient = (e: unknown) => (e as { transient?: boolean })?.transient === true;

/** The same email (event, order, subject, recipient) always has the same key: the provider drops a repeat within its window. */
export const emailIdempotencyKey = (event: string, orderId: string | null | undefined, m: Pick<MailMessage, 'to' | 'subject'>) =>
  createHash('sha256').update([event, orderId ?? '', m.subject, m.to.toLowerCase()].join('\n')).digest('hex').slice(0, 48);

async function deliver(mailer: Mailer, m: MailMessage, tries = QUICK_TRIES, budgetMs = QUICK_BUDGET_MS): Promise<string | null> {
  let error: string | null = null;
  const started = Date.now();
  for (const wait of tries) {
    if (wait) await pause(wait);
    try { await mailer.send(m); return null; }
    catch (e) { error = String((e as Error).message ?? e).slice(0, 500); if (!transient(e) || Date.now() - started >= budgetMs) break; }
  }
  return error;
}

/** Sends one customer email. `build` returns the message for the current state of the record, or null when there is
    nothing to say (wrong state, no email address). With an order, the same email is sent once: a second call answers
    'duplicate'. Never throws. */
export async function sendTransactionalEmail(db: Db, mailer: Mailer, event: EmailEvent, build: (q: Queryable) => Promise<BuiltEmail | null>,
  opts: { /** Skip the switch (used by the retry, which has already checked it). */ checked?: boolean; quickTries?: number[]; quickBudgetMs?: number } = {}): Promise<TransactionalEmailResult> {
  try {
    if (!opts.checked && !(await emailEnabled(db, event))) return { sent: false, reason: 'off' };
    const first = await build(db);
    if (!first || !first.to?.trim()) return { sent: false, reason: 'no_recipient' };
    const log = (q: Queryable, m: BuiltEmail, error: string | null) => q.insertInto('notification_log')
      .values({ event, order_id: m.orderId ?? null, recipient: m.to, subject: m.subject.slice(0, 200), status: error ? 'failed' : 'sent', error }).execute();
    if (!first.orderId) {
      const error = await deliver(mailer, { to: first.to, subject: first.subject, text: first.text, html: first.html }, opts.quickTries, opts.quickBudgetMs);
      await log(db, first, error);
      return error ? { sent: false, reason: 'failed' } : { sent: true };
    }
    // About an order: one at a time per email, and only if it has not been sent already.
    return await db.transaction().execute(async tx => {
      await sql`select pg_advisory_xact_lock(hashtext(${`mail:${event}:${first.orderId}:${first.subject}`}))`.execute(tx);
      const m = await build(tx);       // the state as it is now, under the lock
      if (!m || !m.to?.trim() || !m.orderId) return { sent: false, reason: 'no_recipient' } as const;
      const done = await tx.selectFrom('notification_log').select('id').where('order_id', '=', m.orderId).where('event', '=', event)
        .where('subject', '=', m.subject.slice(0, 200)).where('status', '=', 'sent').executeTakeFirst();
      if (done) return { sent: false, reason: 'duplicate' } as const;
      const error = await deliver(mailer, { to: m.to, subject: m.subject, text: m.text, html: m.html, idempotencyKey: emailIdempotencyKey(event, m.orderId, m) }, opts.quickTries, opts.quickBudgetMs);
      await log(tx, m, error);
      return error ? { sent: false, reason: 'failed' } as const : { sent: true } as const;
    });
  } catch (e) {
    console.error(`[email] ${event} could not be prepared or recorded:`, (e as Error).message);
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------- retry
/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed attempt; after the 5th the email is left as failed. */
export const EMAIL_RETRY_MINUTES = [2, 10, 60, 360] as const;
export const EMAIL_RETRY_WINDOW_HOURS = 72;

/** Rebuilds an order's email from what is recorded now (the retry has only the order and the subject to go on). */
export type EmailRebuilder = (q: Queryable, ref: { orderId: string; orderNumber: string; subject: string }) => Promise<BuiltEmail | null>;
export type EmailRetryRun = { checked: number; sent: number; failed: number; skipped: number; waiting: number; gaveUp: number; missing: number;
  /** Set when nothing was looked at: the console mailer delivers nothing, so there is nothing to send again. */
  noProvider?: true };

/** Sends again what failed, and what was never attempted.
    1. An email whose last attempt failed (no later success), up to 5 attempts, each later than the one before
       (EMAIL_RETRY_MINUTES), within 72 hours. The message is built again from the order as it is now: an order that has
       since been cancelled gets no "confirmed" email.
    2. An online order that is confirmed (paid, or cash on delivery) and has no confirmation attempt at all, e.g. because
       the server stopped between saving the order and sending: its confirmation is sent now.
    Safe to run often and from several places at once (every send goes through sendTransactionalEmail). */
export async function retryTransactionalEmails(db: Db, mailer: Mailer, rebuilders: Partial<Record<EmailEvent, EmailRebuilder>>,
  opts: { limit?: number; now?: Date; quickTries?: number[] } = {}): Promise<EmailRetryRun> {
  const run: EmailRetryRun = { checked: 0, sent: 0, failed: 0, skipped: 0, waiting: 0, gaveUp: 0, missing: 0 };
  if (mailer.kind === 'console') return { ...run, noProvider: true };
  const now = opts.now ?? new Date(), limit = opts.limit ?? 50;
  const since = new Date(now.getTime() - EMAIL_RETRY_WINDOW_HOURS * 3_600_000);
  const tally = (r: TransactionalEmailResult) => { if (r.sent) run.sent++; else if (r.reason === 'failed' || r.reason === 'error') run.failed++; else run.skipped++; };

  const failed = (await sql<{ event: string; order_id: string; order_number: string; subject: string; attempts: number; last_at: Date }>`
    select n.event, n.order_id, o.order_number, n.subject, count(*)::int as attempts, max(n.created_at) as last_at
    from public.notification_log n join public.orders o on o.id = n.order_id
    where n.status = 'failed' and n.created_at >= ${since}
      and not exists (select 1 from public.notification_log s where s.order_id = n.order_id and s.event = n.event and s.subject = n.subject and s.status = 'sent')
    group by n.event, n.order_id, o.order_number, n.subject order by max(n.created_at) limit ${limit}`.execute(db)).rows;
  for (const f of failed) {
    run.checked++;
    const event = f.event as EmailEvent, rebuild = rebuilders[event];
    if (!rebuild || !(event in EMAIL_EVENTS)) { run.skipped++; continue; }
    if (f.attempts > EMAIL_RETRY_MINUTES.length) { run.gaveUp++; continue; }
    if (now.getTime() - new Date(f.last_at).getTime() < EMAIL_RETRY_MINUTES[f.attempts - 1]! * 60_000) { run.waiting++; continue; }
    if (!(await emailEnabled(db, event))) { run.skipped++; continue; }
    // Only the email that failed is sent again: if the record has moved on (another subject, or nothing to say), it is left.
    tally(await sendTransactionalEmail(db, mailer, event, async q => { const m = await rebuild(q, { orderId: f.order_id, orderNumber: f.order_number, subject: f.subject }); return m && m.subject.slice(0, 200) === f.subject ? m : null; },
      { checked: true, quickTries: opts.quickTries }));
  }

  const placed = rebuilders['order.placed'];
  if (placed) {
    const missing = await db.selectFrom('orders as o').select(['o.id', 'o.order_number'])
      .where('o.channel', '=', 'online').where('o.status', '!=', 'cancelled').where('o.created_at', '>=', since).where('o.created_at', '<', new Date(now.getTime() - 3 * 60_000))
      .where(eb => eb.or([eb('o.payment_status', '=', 'paid'), eb.and([eb('o.payment_method', '=', 'cod'), eb('o.cod_status', '=', 'to_collect')])]))
      .where(sql<boolean>`coalesce(btrim(o.contact->>'email'), '') <> ''`)
      .where(sql<boolean>`not exists (select 1 from public.notification_log n where n.order_id = o.id and n.event = 'order.placed')`)
      .orderBy('o.created_at').limit(limit).execute();
    for (const o of missing) {
      run.checked++; run.missing++;
      tally(await sendTransactionalEmail(db, mailer, 'order.placed', q => placed(q, { orderId: o.id, orderNumber: o.order_number, subject: '' }), { checked: true, quickTries: opts.quickTries }));
    }
  }
  return run;
}
