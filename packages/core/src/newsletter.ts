/* Client change request: newsletter subscribers (replaces the placeholder sign-up).
   - One row per email (lower-case, unique): signing up again never creates a duplicate; it re-subscribes an address that
     had unsubscribed and records the new consent.
   - Consent is stored: the exact wording the person agreed to, when, and where (source).
   - Unsubscribing uses a random token (only its SHA-256 is stored). The raw token exists only in the unsubscribe link of a
     message; each marketing send creates a fresh token (rotateUnsubscribeToken). Staff can also unsubscribe an address.
   - Nothing is emailed from here: no marketing emails are sent until a provider and campaign sending exist. */
import { createHash, randomBytes } from 'node:crypto';
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export const NEWSLETTER_CONSENT = 'I agree to receive emails from KITSYUU about new products and offers. I can unsubscribe at any time.';
export const SUBSCRIBER_PAGE_SIZE = 50;
const hash = (t: string) => createHash('sha256').update(t).digest();
const newToken = () => randomBytes(32).toString('base64url');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Store sign-up. Returns what happened, never whether an address was already on the list to someone else (the message is
    the same either way). */
export async function subscribeNewsletter(db: Db, input: { email: string; consent: boolean; source: string; customerId?: string | null }) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new DomainError('invalid', 'Enter a valid email address.');
  if (!input.consent) throw new DomainError('invalid', 'Tick the box to agree to receive our emails.');
  const source = /^[a-z][a-z_]{1,31}$/.test(input.source) ? input.source : 'store';
  return db.transaction().execute(async tx => {
    const cur = await tx.selectFrom('newsletter_subscribers').select(['id', 'status']).where('email', '=', email).forUpdate().executeTakeFirst();
    if (cur?.status === 'subscribed') return { result: 'already' as const };
    if (cur) {
      await tx.updateTable('newsletter_subscribers').set({ status: 'subscribed', consent_text: NEWSLETTER_CONSENT, consented_at: sql<Date>`now()` as unknown as Date,
        source, unsubscribed_at: null, customer_id: input.customerId ?? null }).where('id', '=', cur.id).execute();
      return { result: 'resubscribed' as const };
    }
    await tx.insertInto('newsletter_subscribers').values({ email, consent_text: NEWSLETTER_CONSENT, source, customer_id: input.customerId ?? null,
      unsubscribe_token_hash: hash(newToken()) }).onConflict(oc => oc.column('email').doNothing()).execute();
    return { result: 'subscribed' as const };
  });
}

/** A fresh unsubscribe token for one subscriber (to put in the link of the next message sent to them). */
export async function rotateUnsubscribeToken(db: Db, subscriberId: string): Promise<string> {
  const token = newToken();
  const r = await db.updateTable('newsletter_subscribers').set({ unsubscribe_token_hash: hash(token) }).where('id', '=', subscriberId).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw new NotFoundError('Subscriber not found.');
  return token;
}

/** The unsubscribe link: always answers the same way, so it cannot be used to test which addresses are on the list. */
export async function unsubscribeByToken(db: Db, token: string): Promise<{ ok: boolean }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false };
  const r = await db.updateTable('newsletter_subscribers').set({ status: 'unsubscribed', unsubscribed_at: sql<Date>`coalesce(unsubscribed_at, now())` as unknown as Date })
    .where('unsubscribe_token_hash', '=', hash(token)).executeTakeFirst();
  return { ok: Number(r.numUpdatedRows) > 0 };
}

// ---------------------------------------------------------------- admin
export async function listSubscribers(db: Db, actor: StaffPrincipal, query: { q?: string; status: 'all' | 'subscribed' | 'unsubscribed'; page: number }) {
  requirePermission(actor, 'marketing.read');
  let q = db.selectFrom('newsletter_subscribers').select(['id', 'email', 'status', 'source', 'consented_at', 'unsubscribed_at', 'created_at', 'customer_id']);
  if (query.status !== 'all') q = q.where('status', '=', query.status);
  if (query.q) q = q.where('email', 'ilike', `%${query.q.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`);
  const rows = await q.orderBy('created_at', 'desc').limit(SUBSCRIBER_PAGE_SIZE + 1).offset((query.page - 1) * SUBSCRIBER_PAGE_SIZE).execute();
  const counts = await db.selectFrom('newsletter_subscribers').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
  return { rows: rows.slice(0, SUBSCRIBER_PAGE_SIZE), hasNext: rows.length > SUBSCRIBER_PAGE_SIZE,
    counts: { subscribed: counts.find(c => c.status === 'subscribed')?.n ?? 0, unsubscribed: counts.find(c => c.status === 'unsubscribed')?.n ?? 0 } };
}

/** Staff unsubscribe an address (e.g. the person asked by email). Re-subscribing needs the person's own consent. */
export async function unsubscribeSubscriber(db: Db, actor: StaffPrincipal, input: { subscriberId: string }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  await db.transaction().execute(async tx => {
    const s = await tx.selectFrom('newsletter_subscribers').select(['status']).where('id', '=', input.subscriberId).forUpdate().executeTakeFirst();
    if (!s) throw new NotFoundError('Subscriber not found.');
    if (s.status === 'unsubscribed') return;
    await tx.updateTable('newsletter_subscribers').set({ status: 'unsubscribed', unsubscribed_at: new Date() }).where('id', '=', input.subscriberId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'newsletter.unsubscribe', entityType: 'newsletter_subscribers', entityId: input.subscriberId,
      before: { status: 'subscribed' }, after: { status: 'unsubscribed' }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
  });
}

/** Subscribed addresses as CSV rows (needs marketing.read and customers.read: it is a list of personal data). Audited. */
export async function exportSubscribers(db: Db, actor: StaffPrincipal, ctx: MutationContext) {
  requirePermission(actor, 'marketing.read');
  requirePermission(actor, 'customers.read');
  const rows = await db.selectFrom('newsletter_subscribers').select(['email', 'source', 'consented_at', 'consent_text']).where('status', '=', 'subscribed').orderBy('consented_at').execute();
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'newsletter.export', entityType: 'newsletter_subscribers', entityId: null,
    metadata: { rows: rows.length }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null }));
  return rows;
}
