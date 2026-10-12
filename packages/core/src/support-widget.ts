/* Storefront help widget (2026-10-12). No schema change: it uses the existing support tickets and the existing orders.
   Three things, all deterministic (no model, no generated text, nothing that claims to be a person or an AI):
     · Help topics: a fixed list of questions with answers built from the business's own settings (returns on/off and
       window). A question typed by the visitor is matched to topics by keywords, nothing more.
     · A message to the team: a support ticket. A signed-in customer's ticket is their own (openCustomerTicket); a
       guest's ticket carries the name and email they typed, has no account, and is answered by email.
     · Order status for a guest: the order number AND the contact the order was placed with (its email, or the last ten
       digits of its phone). Only the status and the shipping facts are returned; never the name, address, items or
       amounts. A wrong number and a wrong contact give the same answer, so the lookup does not confirm that an order
       number exists. The store's action limits how often it can be tried, per address and per order number.
   Runs as the store's database role; staff permissions do not apply here. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { DomainError } from '@kitsyuu/contracts';
import type { RequestContext } from '@kitsyuu/auth';
import { raiseAlertSafely } from './alerts.ts';
import { returnSettings } from './returns.ts';

export type HelpTopic = { id: string; question: string; answer: string; keywords: string[]; link?: { href: string; label: string } };

/** The help topics, in the order shown. Answers state only what the platform knows to be true. */
export async function helpTopics(q: Queryable): Promise<HelpTopic[]> {
  const r = await returnSettings(q);
  const returns = r.enabled && r.windowDays
    ? `A return can be requested within ${r.windowDays} day${r.windowDays === 1 ? '' : 's'} of delivery, from the order's page in your account. Our team reviews each request and tells you what happens next.`
    : 'All sales are final: returns and exchanges are not offered at the moment. If something arrived damaged or wrong, send us a message with your order number.';
  return [
    { id: 'order-status', question: 'Where is my order?', keywords: ['where', 'order', 'status', 'track', 'tracking', 'shipped', 'delivery', 'delivered', 'arrive', 'late', 'courier'],
      answer: 'Use "Check an order" here with your order number and the email or phone number you ordered with. If you have an account, every order and its tracking is under My account → Orders.' },
    { id: 'returns', question: 'Can I return or exchange an item?', keywords: ['return', 'returns', 'exchange', 'refund', 'size', 'fit', 'damaged', 'wrong', 'replace'], answer: returns },
    { id: 'change-order', question: 'Can I change or cancel my order?', keywords: ['change', 'cancel', 'edit', 'address', 'modify', 'mistake'],
      answer: 'Send us a message with your order number as soon as you can. Our team will tell you what is still possible for that order; an order that has already been shipped cannot be changed.' },
    { id: 'delivery-charge', question: 'What does delivery cost?', keywords: ['delivery', 'shipping', 'charge', 'cost', 'fee', 'free', 'price'],
      answer: 'The delivery charge for your address is shown at checkout before you pay. Nothing is added after that.' },
    { id: 'sizes', question: 'How do I choose a size?', keywords: ['size', 'sizes', 'chart', 'measure', 'measurement', 'fit', 'small', 'large'],
      answer: 'Each product page lists its sizes and, where there is one, its size chart. If you are between sizes, send us a message with the product name and your measurements.' },
    { id: 'contact', question: 'How do I reach the team?', keywords: ['contact', 'reach', 'talk', 'human', 'person', 'email', 'call', 'phone', 'help', 'support', 'agent', 'chat'],
      answer: 'Use "Send a message" here. It goes to our support team as a ticket and a person replies by email. This window gives automated answers from our help topics; it is not a live chat.' },
  ];
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
/** Topics that share words with the question, best first (most shared keywords; ties keep the list's order). At most three. */
export function matchHelpTopics(topics: HelpTopic[], question: string): HelpTopic[] {
  const asked = new Set(words(question.slice(0, 300)));
  if (!asked.size) return [];
  return topics.map((t, i) => ({ t, i, n: t.keywords.filter(k => asked.has(k)).length })).filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 3).map(x => x.t);
}

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment', paid: 'Confirmed', processing: 'Being packed', shipped: 'Shipped',
  delivered: 'Delivered', cancelled: 'Cancelled', payment_failed: 'Payment failed', refunded: 'Refunded',
};
export type GuestOrderStatus =
  | { found: false }
  | { found: true; orderNumber: string; status: string; statusLabel: string; placedOn: string;
      shipment: { courier: string | null; trackingNumber: string | null; trackingUrl: string | null; shippedOn: string | null; deliveredOn: string | null } | null };

/** What a contact typed into the lookup is: an email, or a phone number reduced to its last ten digits. Null = neither. */
export function lookupContact(raw: string): { email: string } | { phone: string } | null {
  const v = raw.trim().slice(0, 254);
  if (v.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { email: v.toLowerCase() } : null;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? { phone: digits.slice(-10) } : null;
}

/** Order status for someone who is not signed in. Both the order number and the order's own contact must match; either
    one wrong gives the same `{ found: false }`. Returns status and shipping facts only. */
export async function guestOrderStatus(db: Db, input: { orderNumber: string; contact: string }): Promise<GuestOrderStatus> {
  const number = input.orderNumber.trim().toUpperCase().slice(0, 40), contact = lookupContact(input.contact);
  if (!/^[A-Z0-9][A-Z0-9/-]{3,39}$/.test(number) || !contact) return { found: false };
  const day = (col: string) => sql<string | null>`to_char(${sql.ref(col)} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
  const o = await db.selectFrom('orders as o').leftJoin('customers as c', 'c.id', 'o.customer_id')
    .select(['o.id', 'o.order_number', 'o.status', day('o.created_at').as('placed_on')])
    .where(sql<boolean>`upper(o.order_number) = ${number}`)
    .where('email' in contact
      ? sql<boolean>`(lower(o.contact->>'email') = ${contact.email} or lower(c.email) = ${contact.email})`
      : sql<boolean>`right(regexp_replace(coalesce(o.contact->>'phone', ''), '\\D', '', 'g'), 10) = ${contact.phone}`)
    .executeTakeFirst();
  if (!o) return { found: false };
  const s = await db.selectFrom('shipments as s').leftJoin('couriers as k', 'k.code', 's.carrier_code')
    .select(['k.name as courier', 's.tracking_number', 's.tracking_url', day('s.shipped_at').as('shipped_on'), day('s.delivered_at').as('delivered_on')])
    .where('s.order_id', '=', o.id).orderBy('s.updated_at', 'desc').executeTakeFirst();   // the store's role reads only the shipment columns it was granted
  const shipped = s && (s.shipped_on || s.tracking_number);
  return { found: true, orderNumber: o.order_number, status: o.status, statusLabel: STATUS_LABEL[o.status] ?? 'In progress', placedOn: o.placed_on!,
    shipment: shipped ? { courier: s.courier ?? null, trackingNumber: s.tracking_number, trackingUrl: s.tracking_url && /^https:\/\//.test(s.tracking_url) ? s.tracking_url : null,
      shippedOn: s.shipped_on, deliveredOn: s.delivered_on } : null };
}

/** A message from someone who is not signed in: a support ticket with the name and email they typed, and no account.
    An order number is linked to the ticket only when that order was placed with the same email; otherwise it is kept as
    typed in the message for staff to check (the form never says whether an order number exists). */
export async function openGuestTicket(db: Db, input: { name: string; email: string; categoryCode: string; subject: string; body: string; orderNumber: string | null }, ctx: RequestContext) {
  const email = input.email.trim().toLowerCase(), name = input.name.trim().slice(0, 120), subject = input.subject.trim().slice(0, 160), body = input.body.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new DomainError('invalid', 'Enter a valid email address.');
  if (!name) throw new DomainError('invalid', 'Enter your name.');
  if (!subject) throw new DomainError('invalid', 'Say what this is about.');
  if (body.length < 1 || body.length > 3800) throw new DomainError('invalid', 'Write your message (up to 3,800 characters).');
  const typed = (input.orderNumber ?? '').trim().toUpperCase().slice(0, 40);
  const t = await db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('support_categories').select('code').where('code', '=', input.categoryCode).where('is_active', '=', true).executeTakeFirst())) throw new DomainError('invalid', 'Choose a topic.');
    const order = typed ? await tx.selectFrom('orders as o').leftJoin('customers as c', 'c.id', 'o.customer_id').select('o.id')
      .where(sql<boolean>`upper(o.order_number) = ${typed}`).where(sql<boolean>`(lower(o.contact->>'email') = ${email} or lower(c.email) = ${email})`).executeTakeFirst() : undefined;
    const t = await tx.insertInto('support_tickets').values({ customer_id: null, contact_email: email, contact_name: name, order_id: order?.id ?? null,
      subject, category_code: input.categoryCode, channel: 'store', last_customer_reply_at: sql<Date>`now()` }).returning(['id', 'number']).executeTakeFirstOrThrow();
    const text = typed && !order ? `${body}\n\nOrder number given: ${typed} (not matched to this email; check before discussing the order)` : body;
    await tx.insertInto('support_messages').values({ ticket_id: t.id, author_type: 'customer', customer_id: null, body: text }).execute();
    // A guest has no account, so the audit row is the system's, marked as a guest's message, with the request's address.
    await recordAudit(tx, { actorType: 'system', action: 'support.guest_ticket_open', entityType: 'support_tickets', entityId: t.id,
      metadata: { guest: true, number: t.number, category: input.categoryCode, order_linked: !!order }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return t;
  });
  await raiseAlertSafely(db, { kind: 'support.ticket', title: `New ticket ${t.number}: ${subject}`, entityType: 'support_tickets', entityId: t.id, link: `/support/${t.id}`, dedupeKey: `support.ticket:${t.id}` });
  return { number: t.number };
}
