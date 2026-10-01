/* Commerce workflow emails (2026-10-01), on the existing customer-email system (customer-email.ts: one switch per email in
   Settings → Customer emails, OFF until the business turns it on; every attempt in notification_log; a failed email never
   blocks what caused it).
   - order.packed: when staff mark an order packed.
   - order.payment_request: when staff confirm a draft order for online payment (the link to pay it from the account).
   - cart.auto_reminder: the automatic "your cart is waiting" email (below). */
import { sql, type Db, type Queryable } from '@kitsyuu/db';
import type { Mailer } from '@kitsyuu/auth';
import { customerEmailEnabled, hello, sendCustomerEmail, storeLink, type EmailResult } from './customer-email.ts';
import { lineLabel, pricedLine, variantQuery } from './cart.ts';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const contactOf = (c: unknown) => { const o = (c ?? {}) as Record<string, unknown>; return { email: typeof o.email === 'string' ? o.email.trim() : '', name: o.name }; };

export async function notifyOrderPacked(db: Db, mailer: Mailer, orderId: string, storeUrl?: string | null): Promise<EmailResult> {
  return sendCustomerEmail(db, mailer, 'order.packed', async () => {
    const o = await db.selectFrom('orders').select(['id', 'order_number', 'contact', 'channel']).where('id', '=', orderId).executeTakeFirst();
    if (!o || o.channel !== 'online') return null;
    const c = contactOf(o.contact);
    return { orderId: o.id, to: c.email, subject: `Your KITSYUU order ${o.order_number} is packed`,
      text: [hello(c.name), '', `Your order ${o.order_number} is packed and will be handed to the courier next.`, '',
        ...storeLink(storeUrl, `/account/orders/${encodeURIComponent(o.order_number)}`, 'Your order')].join('\n') };
  });
}

export async function notifyPaymentRequest(db: Db, mailer: Mailer, orderId: string, storeUrl?: string | null): Promise<EmailResult> {
  return sendCustomerEmail(db, mailer, 'order.payment_request', async () => {
    const o = await db.selectFrom('orders').select(['id', 'order_number', 'contact', 'total_paise', 'status']).where('id', '=', orderId).executeTakeFirst();
    if (!o || o.status !== 'pending_payment') return null;
    const c = contactOf(o.contact);
    return { orderId: o.id, to: c.email, subject: `Your KITSYUU order ${o.order_number} is ready to pay`,
      text: [hello(c.name), '', `We have prepared your order ${o.order_number} (${inr(o.total_paise)}).`,
        'Sign in to your account and open the order to pay it. The items are set aside for you until then.', '',
        ...storeLink(storeUrl, `/account/orders/${encodeURIComponent(o.order_number)}`, 'Pay your order')].join('\n') };
  });
}

// ---------------------------------------------------------------- automatic "your cart is waiting"
/** Minutes a cart must stay unchanged before the reminder: ABANDONED_CART_DELAY_MINUTES (15–1440), else 45. */
export function abandonedCartDelayMinutes(env: string | undefined = process.env.ABANDONED_CART_DELAY_MINUTES): number {
  const n = Number(env);
  return Number.isInteger(n) && n >= 15 && n <= 1440 ? n : 45;
}

async function wording(q: Queryable) {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['emails.cart_reminder_subject', 'emails.cart_reminder_intro']).execute();
  const v = (k: string) => { const r = rows.find(x => x.key === k)?.value; return typeof r === 'string' && r.trim() ? r.trim() : null; };
  return { subject: v('emails.cart_reminder_subject') ?? 'Your cart is waiting for you', intro: v('emails.cart_reminder_intro') ?? 'You left these items in your KITSYUU cart.' };
}

export type CartReminderRun = { skipped?: 'off' | 'no_provider'; delayMinutes: number; checked: number; sent: number; failed: number; noStock: number };

/** Sends the due cart reminders. One per cart, ever (cart_recovery.auto_reminded_at is claimed before sending, so two runs
    never both send). Only for a signed-in customer's active cart that has not changed for the delay, that did not go on to
    a checkout (an unpaid order from it is the abandoned-checkout reminder's job), whose customer has not ordered since, and
    never to an address that unsubscribed. Only items still in stock are listed; with none in stock nothing is sent (the
    cart is looked at again on the next run, e.g. after a restock). Safe to run often and concurrently. */
export async function sendAbandonedCartReminders(db: Db, mailer: Mailer, opts: { storeUrl?: string | null; delayMinutes?: number; limit?: number } = {}): Promise<CartReminderRun> {
  const delayMinutes = opts.delayMinutes ?? abandonedCartDelayMinutes();
  const empty = { delayMinutes, checked: 0, sent: 0, failed: 0, noStock: 0 };
  if (!(await customerEmailEnabled(db, 'cart.auto_reminder'))) return { skipped: 'off', ...empty };
  if (mailer.kind === 'console') return { skipped: 'no_provider', ...empty };
  const lastChange = sql<Date>`greatest(c.updated_at, (select max(i.updated_at) from public.cart_items i where i.cart_id = c.id))`;
  const due = await db.selectFrom('carts as c').innerJoin('customers as u', 'u.id', 'c.customer_id').leftJoin('cart_recovery as r', 'r.cart_id', 'c.id')
    .select(['c.id', 'c.customer_id', 'u.email', 'u.full_name', lastChange.as('last_change')])
    .where('c.status', '=', 'active').where('u.status', '=', 'active').where('r.auto_reminded_at', 'is', null)
    .where(sql<boolean>`exists (select 1 from public.cart_items i where i.cart_id = c.id)`)
    .where(sql<boolean>`${lastChange} < now() - make_interval(mins => ${delayMinutes})`)
    .where(sql<boolean>`not exists (select 1 from public.orders o where o.customer_id = c.customer_id and (o.cart_id = c.id or o.created_at >= ${lastChange}))`)
    .where(sql<boolean>`not exists (select 1 from public.newsletter_subscribers n where n.email = lower(u.email) and n.status = 'unsubscribed')`)
    .orderBy('c.updated_at').limit(opts.limit ?? 50).execute();
  const words = await wording(db);
  let sent = 0, failed = 0, noStock = 0;
  for (const cart of due) {
    const items = await db.selectFrom('cart_items').select(['variant_id', 'qty']).where('cart_id', '=', cart.id).execute();
    const rows = new Map((await variantQuery(db).where('v.id', 'in', items.map(i => i.variant_id)).execute()).map(r => [r.variant_id, r]));
    const lines = items.filter(i => rows.has(i.variant_id)).map(i => pricedLine(rows.get(i.variant_id)!, i.qty));
    const inStock = lines.filter(l => !l.problem || l.problem === 'insufficient_stock');
    if (!inStock.length) { noStock++; continue; }
    // Claim: only the run that sets auto_reminded_at sends.
    await db.insertInto('cart_recovery').values({ cart_id: cart.id }).onConflict(oc => oc.column('cart_id').doNothing()).execute();
    const claimed = await db.updateTable('cart_recovery').set({ auto_reminded_at: sql`now()`, status: 'emailed', emailed_at: sql`now()`, email_count: sql`email_count + 1`, updated_at: sql`now()` })
      .where('cart_id', '=', cart.id).where('auto_reminded_at', 'is', null).returning('cart_id').executeTakeFirst();
    if (!claimed) continue;
    const gone = lines.length - inStock.length;
    const text = [hello(cart.full_name), '', words.intro, '',
      ...inStock.map(l => `- ${lineLabel(l)}${l.problem === 'insufficient_stock' ? ` (only ${l.available} left)` : ''}: ${inr(l.unitPaise)}${l.qty > 1 ? ` × ${l.qty}` : ''}`),
      ...(gone ? ['', `${gone === 1 ? 'One item is' : `${gone} items are`} no longer in stock and ${gone === 1 ? 'was' : 'were'} left out.`] : []),
      '', 'Items in a cart are not reserved: they can sell out before you check out.', '', ...storeLink(opts.storeUrl, '/cart', 'Your cart')].join('\n');
    let error: string | null = null;
    try { await mailer.send({ to: cart.email, subject: words.subject, text }); } catch (e) { error = String((e as Error).message ?? e).slice(0, 500); }
    await db.insertInto('notification_log').values({ event: 'cart.auto_reminder', order_id: null, recipient: cart.email, subject: words.subject.slice(0, 200), status: error ? 'failed' : 'sent', error }).execute();
    if (error) failed++; else sent++;
  }
  return { delayMinutes, checked: due.length, sent, failed, noStock };
}
