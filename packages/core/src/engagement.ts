/* M17: customer notifications, the store announcement, and customer-service tools.
   Emails: which ones are sent is a business decision, so each is a setting that starts off
   (notifications.order_shipped / notifications.order_cancelled = 'on' to send). Messages state facts only (no delivery
   dates, no refund promises). Every attempt is logged (sent / failed); a failed email never undoes the order change.
   Announcement: one short text (optional link) staff can draft, publish and take down (site_content 'store.announcement').
   Customer notes: internal, append-only. Cart and wishlist: read-only view for customer service. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type Mailer, type MailMessage, type StaffPrincipal } from '@kitsyuu/auth';
import { getShipment } from './fulfilment.ts';
import type { MutationContext } from './staff.ts';
import { emailEnabled, sendTransactionalEmail } from './transactional-email.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ---------------------------------------------------------------- order emails
export type OrderEmailEvent = 'order.shipped' | 'order.cancelled';

export const orderEmailEnabled = (q: Queryable, event: OrderEmailEvent): Promise<boolean> => emailEnabled(q, event);

/** The email for an order that was just shipped or cancelled, or null (no contact email, or the order is not in that state). */
export async function orderStatusEmail(q: Queryable, orderId: string, event: OrderEmailEvent, opts: { storeUrl?: string | null } = {}): Promise<MailMessage | null> {
  const o = await q.selectFrom('orders').select(['id', 'order_number', 'status', 'contact']).where('id', '=', orderId).executeTakeFirst();
  if (!o) return null;
  if ((event === 'order.shipped' && o.status !== 'shipped') || (event === 'order.cancelled' && o.status !== 'cancelled')) return null;
  const contact = (o.contact ?? {}) as Record<string, unknown>;
  const to = text(contact.email);
  if (!to) return null;
  const hello = `Hello${text(contact.name) ? ' ' + text(contact.name) : ''},`;
  const link = opts.storeUrl ? [`Your orders: ${new URL('/account/orders', opts.storeUrl).toString()}`] : [];
  if (event === 'order.shipped') {
    const s = await getShipment(q, o.id);
    const tracking = s?.trackingNumber ? [`Courier: ${s.carrierLabel}`, `Tracking number: ${s.trackingNumber}`, ...(s.trackingUrl ? [`Track it: ${s.trackingUrl}`] : [])] : [];
    return { to, subject: `Your KITSYUU order ${o.order_number} has shipped`, text: [hello, '', `Your order ${o.order_number} has been shipped.`, ...(tracking.length ? ['', ...tracking] : []), '', ...link].join('\n') };
  }
  return { to, subject: `Your KITSYUU order ${o.order_number} was cancelled`, text: [hello, '', `Your order ${o.order_number} has been cancelled.`,
    'If you have questions about this, reply to this email.', '', ...link].join('\n') };
}

/** Sends the email for an order status change when that email is switched on; once per order; logs the attempt. Never
    throws. (2026-10-08: through the transactional email service.) */
export function notifyOrderStatus(db: Db, mailer: Mailer, orderId: string, event: OrderEmailEvent, opts: { storeUrl?: string | null } = {}) {
  return sendTransactionalEmail(db, mailer, event, async q => { const m = await orderStatusEmail(q, orderId, event, opts); return m && { ...m, orderId }; });
}

export async function listNotificationLog(db: Db, actor: StaffPrincipal, limit = 50) {
  requirePermission(actor, 'system.read');
  return db.selectFrom('notification_log as n').leftJoin('orders as o', 'o.id', 'n.order_id')
    .select(['n.id', 'n.event', 'n.recipient', 'n.subject', 'n.status', 'n.error', 'n.created_at', 'o.order_number'])
    .orderBy('n.id', 'desc').limit(limit).execute();
}

// ---------------------------------------------------------------- store announcement
export const ANNOUNCEMENT_KEY = 'store.announcement';
export type Announcement = { text: string; href: string | null };
const asAnnouncement = (c: unknown): Announcement | null => {
  const o = (c ?? {}) as Record<string, unknown>;
  return typeof o.text === 'string' && o.text ? { text: o.text, href: typeof o.href === 'string' && o.href ? o.href : null } : null;
};

export async function getAnnouncementAdmin(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'content.manage');
  const rows = await db.selectFrom('site_content').select(['status', 'content', 'updated_at', 'published_at']).where('key', '=', ANNOUNCEMENT_KEY).where('locale', '=', 'en-IN').execute();
  const d = rows.find(r => r.status === 'draft'), p = rows.find(r => r.status === 'published');
  return { draft: d ? asAnnouncement(d.content) : null, published: p ? asAnnouncement(p.content) : null, publishedAt: (p?.published_at as Date | undefined) ?? null };
}

/** Saves the draft text (and optionally publishes it). The link must be a path in the store or an https address. */
export async function saveAnnouncement(db: Db, actor: StaffPrincipal, input: { text: string; href: string | null; publish: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'content.manage');
  const t = input.text.trim();
  if (!t || t.length > 140) throw new DomainError('invalid', 'Write the announcement in 1 to 140 characters.');
  if (input.href && !/^(\/[^\s]*|https:\/\/[^\s]+)$/.test(input.href)) throw new DomainError('invalid', 'The link must start with / (a store page) or https://.');
  const content = JSON.stringify({ text: t, href: input.href });
  await db.transaction().execute(async tx => {
    for (const status of input.publish ? ['draft', 'published'] as const : ['draft'] as const) {
      await tx.insertInto('site_content').values({ key: ANNOUNCEMENT_KEY, locale: 'en-IN', status, content, updated_by: actor.staffId, published_at: status === 'published' ? sql<Date>`now()` : null })
        .onConflict(oc => oc.columns(['key', 'locale', 'status']).doUpdateSet({ content, updated_by: actor.staffId, ...(status === 'published' && { published_at: sql<Date>`now()` }) })).execute();
    }
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: input.publish ? 'content.publish' : 'content.save', entityType: 'site_content', entityId: ANNOUNCEMENT_KEY,
      after: { text: t, href: input.href }, ...auditCtx(ctx) });
  });
}

export async function unpublishAnnouncement(db: Db, actor: StaffPrincipal, ctx: MutationContext) {
  requirePermission(actor, 'content.manage');
  await db.transaction().execute(async tx => {
    const r = await tx.deleteFrom('site_content').where('key', '=', ANNOUNCEMENT_KEY).where('locale', '=', 'en-IN').where('status', '=', 'published').executeTakeFirst();
    if (Number(r.numDeletedRows)) await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'content.unpublish', entityType: 'site_content', entityId: ANNOUNCEMENT_KEY, ...auditCtx(ctx) });
  });
}

// ---------------------------------------------------------------- customer service
export async function listCustomerNotes(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'customers.read');
  return db.selectFrom('customer_notes as n').leftJoin('staff_users as s', 's.id', 'n.created_by')
    .select(['n.id', 'n.body', 'n.created_at', 's.email as author']).where('n.customer_id', '=', customerId).orderBy('n.created_at', 'desc').limit(100).execute();
}

export async function addCustomerNote(db: Db, actor: StaffPrincipal, input: { customerId: string; body: string }, ctx: MutationContext) {
  requirePermission(actor, 'customers.note');
  const body = input.body.trim();
  if (!body || body.length > 1000) throw new DomainError('invalid', 'Write the note in 1 to 1000 characters.');
  await db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('customers').select('id').where('id', '=', input.customerId).executeTakeFirst())) throw new NotFoundError('Customer not found.');
    const n = await tx.insertInto('customer_notes').values({ customer_id: input.customerId, body, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    // The note text is not copied into the audit log (it may hold personal details); the log records that one was added.
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'customer.note_add', entityType: 'customers', entityId: input.customerId, metadata: { note_id: n.id }, ...auditCtx(ctx) });
  });
}

/** What the customer has in their cart and wishlist right now (names, sizes, quantities; no prices or stock). */
export async function customerBasket(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'customers.read');
  const cart = await db.selectFrom('carts as c').innerJoin('cart_items as i', 'i.cart_id', 'c.id').innerJoin('product_variants as v', 'v.id', 'i.variant_id')
    .innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['i.id', 'p.name', 'p.sku', 'v.size', 'i.qty', 'i.updated_at']).where('c.customer_id', '=', customerId).where('c.status', '=', 'active')
    .orderBy('i.updated_at', 'desc').execute();
  const wishlist = await db.selectFrom('wishlists as w').innerJoin('wishlist_items as i', 'i.wishlist_id', 'w.id').innerJoin('products as p', 'p.id', 'i.product_id')
    .select(['i.id', 'p.name', 'p.sku', 'i.created_at']).where('w.customer_id', '=', customerId).orderBy('i.created_at', 'desc').execute();
  return { cart, wishlist };
}
