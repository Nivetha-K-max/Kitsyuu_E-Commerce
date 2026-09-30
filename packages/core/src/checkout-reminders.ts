/* Client change request: abandoned checkout. An order placed but not paid (awaiting payment, or the payment failed) counts
   as an abandoned checkout once it is older than Settings → Checkout → "Abandoned checkout after" (the client asked for
   24 hours; that is the value used until the setting is changed).
   Reminder emails:
   - at most ONE per order: a checkout_reminders row is claimed before sending, so two runs can never both send;
   - only while the order is still unpaid (checked again at send time) and has a contact email;
   - never to an address that unsubscribed from the newsletter;
   - only when Settings → Customer emails → "Abandoned checkout reminder" is on AND a real email provider is configured
     (with the console mailer used in local development nothing is sent or claimed, so it is sent later once email works).
   Run by the admin job /api/jobs/abandoned-checkouts (secret) or by staff from Carts → Abandoned checkouts. */
import { sql, type Db, type Queryable } from '@kitsyuu/db';
import { requirePermission, type Mailer, type StaffPrincipal } from '@kitsyuu/auth';
import { customerEmailEnabled, hello, storeLink } from './customer-email.ts';

export const ABANDONED_CHECKOUT_DEFAULT_HOURS = 24;
const UNPAID = ['pending_payment', 'payment_failed'] as const;

export async function abandonedCheckoutHours(q: Queryable): Promise<number> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'checkout.abandoned_after_hours').executeTakeFirst();
  const n = Number(r?.value);
  return Number.isInteger(n) && n > 0 ? n : ABANDONED_CHECKOUT_DEFAULT_HOURS;
}

const abandonedQuery = (q: Queryable, hours: number) => q.selectFrom('orders as o').leftJoin('checkout_reminders as r', 'r.order_id', 'o.id')
  .where('o.status', 'in', [...UNPAID]).where(sql<boolean>`o.created_at < now() - make_interval(hours => ${hours})`);

export async function listAbandonedCheckouts(db: Db, actor: StaffPrincipal, opts: { page: number }) {
  requirePermission(actor, 'carts.read');
  const hours = await abandonedCheckoutHours(db);
  const rows = await abandonedQuery(db, hours)
    .select(['o.id', 'o.order_number', 'o.status', 'o.total_paise', 'o.created_at', sql<string | null>`o.contact->>'email'`.as('email'),
      'r.status as reminder_status', 'r.sent_at as reminder_sent_at', 'r.error as reminder_error'])
    .orderBy('o.created_at', 'desc').limit(41).offset((opts.page - 1) * 40).execute();
  const total = await abandonedQuery(db, hours).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
  return { hours, rows: rows.slice(0, 40), hasNext: rows.length > 40, total: total.n };
}

export type ReminderRun = { skipped?: 'off' | 'no_provider'; checked: number; sent: number; failed: number };

/** Sends the reminders that are due. Safe to run often and concurrently. */
export async function sendAbandonedCheckoutReminders(db: Db, mailer: Mailer, opts: { storeUrl?: string | null; limit?: number } = {}): Promise<ReminderRun> {
  if (!(await customerEmailEnabled(db, 'checkout.reminder'))) return { skipped: 'off', checked: 0, sent: 0, failed: 0 };
  if (mailer.kind === 'console') return { skipped: 'no_provider', checked: 0, sent: 0, failed: 0 };
  const hours = await abandonedCheckoutHours(db);
  const due = await abandonedQuery(db, hours).select(['o.id']).where('r.order_id', 'is', null)
    .where(sql<boolean>`coalesce(o.contact->>'email', '') <> ''`)
    .where(sql<boolean>`not exists (select 1 from public.newsletter_subscribers n where n.email = lower(o.contact->>'email') and n.status = 'unsubscribed')`)
    .orderBy('o.created_at').limit(opts.limit ?? 50).execute();
  let sent = 0, failed = 0;
  for (const { id } of due) {
    const o = await db.selectFrom('orders').select(['id', 'order_number', 'status', 'contact']).where('id', '=', id).executeTakeFirst();
    const contact = (o?.contact ?? {}) as Record<string, unknown>;
    const to = typeof contact.email === 'string' ? contact.email.trim() : '';
    if (!o || !(UNPAID as readonly string[]).includes(o.status) || !to) continue;
    // Claim: only the run that inserts the row sends.
    const claimed = await db.insertInto('checkout_reminders').values({ order_id: o.id, status: 'sending', recipient: to })
      .onConflict(oc => oc.column('order_id').doNothing()).returning('order_id').executeTakeFirst();
    if (!claimed) continue;
    const subject = `Your KITSYUU order ${o.order_number} is waiting for payment`;
    const text = [hello(contact.name), '', `Your order ${o.order_number} has not been paid yet, so it has not been confirmed.`,
      'You can complete the payment from your order page.', '', ...storeLink(opts.storeUrl, `/account/orders/${encodeURIComponent(o.order_number)}`, 'Your order')].join('\n');
    let error: string | null = null;
    try { await mailer.send({ to, subject, text }); } catch (e) { error = String((e as Error).message ?? e).slice(0, 500); }
    await db.updateTable('checkout_reminders').set({ status: error ? 'failed' : 'sent', error, sent_at: error ? null : new Date() }).where('order_id', '=', o.id).execute();
    await db.insertInto('notification_log').values({ event: 'checkout.reminder', order_id: o.id, recipient: to, subject, status: error ? 'failed' : 'sent', error }).execute();
    if (error) failed++; else sent++;
  }
  return { checked: due.length, sent, failed };
}
