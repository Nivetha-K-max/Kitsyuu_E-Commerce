/* Customer sessions: same design as staff sessions. The browser holds a random 256-bit token in an HttpOnly cookie; the
   database stores only its SHA-256, so a copy of customer_sessions gives no working sessions. A session ends at the first
   of: logout, revocation (by the customer, a password change or reset), idle timeout (renewed while in use), absolute
   timeout, or the account being disabled. Times are the database's clock. */
import { sql, type Queryable } from '@kitsyuu/db';
import { hashToken, newToken } from './crypto.ts';
import type { RequestContext } from './sessions.ts';
import { authSettings, type AuthSettings } from './settings.ts';

export interface CustomerPrincipal {
  customerId: string;
  email: string;
  fullName: string | null;
  emailVerified: boolean;
  sessionId: string;
}

export async function createCustomerSession(q: Queryable, customerId: string, ctx: RequestContext, s?: AuthSettings) {
  const settings = s ?? await authSettings(q);
  const { token, hash } = newToken();
  const row = await q.insertInto('customer_sessions').values({
    customer_id: customerId,
    token_hash: hash,
    expires_at: sql<Date>`now() + make_interval(days => ${settings.customerAbsoluteDays})`,
    idle_expires_at: sql<Date>`least(now() + make_interval(days => ${settings.customerIdleDays}), now() + make_interval(days => ${settings.customerAbsoluteDays}))`,
    ip: ctx.ip ?? null,
    user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 400) : null,
  }).returning(['id', 'expires_at', 'idle_expires_at']).executeTakeFirstOrThrow();
  return { token, sessionId: row.id, expiresAt: row.expires_at as Date, idleExpiresAt: row.idle_expires_at as Date };
}

/** The signed-in customer, or null. Extends the idle timeout (at most once a minute); the cookie's own lifetime is the
    absolute limit, so it never has to be rewritten. */
export async function validateCustomerSession(q: Queryable, token: string | undefined | null): Promise<CustomerPrincipal | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await q.selectFrom('customer_sessions as s')
    .innerJoin('customers as c', 'c.id', 's.customer_id')
    .select(['s.id as session_id', 's.last_seen_at', 'c.id as customer_id', 'c.email', 'c.full_name', 'c.email_verified_at'])
    .where('s.token_hash', '=', hashToken(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('s.idle_expires_at', '>', sql<Date>`now()`)
    .where('c.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at as Date).getTime() > 60_000) {
    const s = await authSettings(q);
    await q.updateTable('customer_sessions')
      .set({ last_seen_at: sql<Date>`now()`, idle_expires_at: sql<Date>`least(now() + make_interval(days => ${s.customerIdleDays}), expires_at)` })
      .where('id', '=', row.session_id).execute();
  }
  return { customerId: row.customer_id, email: row.email, fullName: row.full_name, emailVerified: row.email_verified_at !== null, sessionId: row.session_id };
}

/** Revokes the session for this token; returns its customer and session id (or null if there was no live session). */
export async function revokeCustomerSession(q: Queryable, token: string): Promise<{ customerId: string; sessionId: string } | null> {
  const row = await q.updateTable('customer_sessions').set({ revoked_at: sql<Date>`now()` })
    .where('token_hash', '=', hashToken(token)).where('revoked_at', 'is', null)
    .returning(['customer_id', 'id']).executeTakeFirst();
  return row ? { customerId: row.customer_id, sessionId: row.id } : null;
}

/** Ends every live session of a customer (optionally keeping one, e.g. the one that changed the password). */
export async function revokeAllCustomerSessions(q: Queryable, customerId: string, exceptSessionId?: string): Promise<number> {
  let query = q.updateTable('customer_sessions').set({ revoked_at: sql<Date>`now()` })
    .where('customer_id', '=', customerId).where('revoked_at', 'is', null);
  if (exceptSessionId) query = query.where('id', '!=', exceptSessionId);
  const res = await query.executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export interface CustomerSessionInfo { id: string; createdAt: Date; lastSeenAt: Date; ip: string | null; userAgent: string | null; current: boolean }

/** The customer's live sessions (for the Security page). Only ever returns sessions of `principal.customerId`. */
export async function listCustomerSessions(q: Queryable, principal: CustomerPrincipal): Promise<CustomerSessionInfo[]> {
  const rows = await q.selectFrom('customer_sessions')
    .select(['id', 'created_at', 'last_seen_at', 'ip', 'user_agent'])
    .where('customer_id', '=', principal.customerId).where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`).where('idle_expires_at', '>', sql<Date>`now()`)
    .orderBy('last_seen_at', 'desc').limit(50).execute();
  return rows.map(r => ({ id: r.id, createdAt: r.created_at as Date, lastSeenAt: r.last_seen_at as Date, ip: r.ip, userAgent: r.user_agent, current: r.id === principal.sessionId }));
}

