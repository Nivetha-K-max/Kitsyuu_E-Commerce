/* Staff sessions. The browser holds a random 256-bit token in an HttpOnly cookie; the database stores only its
   SHA-256, so a copy of staff_sessions gives no working sessions. A session ends at the first of: logout, revocation,
   idle timeout, absolute timeout, or the staff account no longer being active. Times are the database's clock. */
import { sql, type Queryable } from '@kitsyuu/db';
import { hashToken, newToken } from './crypto.ts';
import { loadPermissions, type StaffPrincipal } from './rbac.ts';
import { authSettings, type AuthSettings } from './settings.ts';

export interface RequestContext { ip?: string | null; userAgent?: string | null; requestId?: string | null }

export async function createStaffSession(q: Queryable, staffId: string, ctx: RequestContext, s?: AuthSettings) {
  const settings = s ?? await authSettings(q);
  const { token, hash } = newToken();
  const row = await q.insertInto('staff_sessions').values({
    staff_user_id: staffId,
    token_hash: hash,
    expires_at: sql<Date>`now() + make_interval(hours => ${settings.staffAbsoluteHours})`,
    idle_expires_at: sql<Date>`least(now() + make_interval(mins => ${settings.staffIdleMinutes}), now() + make_interval(hours => ${settings.staffAbsoluteHours}))`,
    ip: ctx.ip ?? null,
    user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 400) : null,
  }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
  return { token, sessionId: row.id, expiresAt: row.expires_at as Date };
}

/** Returns the signed-in staff member with fresh permissions, or null. Extends the idle timeout (at most once a minute). */
export async function validateStaffSession(q: Queryable, token: string | undefined | null): Promise<StaffPrincipal | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await q.selectFrom('staff_sessions as s')
    .innerJoin('staff_users as u', 'u.id', 's.staff_user_id')
    .select(['s.id as session_id', 's.last_seen_at', 'u.id as staff_id', 'u.email', 'u.full_name'])
    .where('s.token_hash', '=', hashToken(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('s.idle_expires_at', '>', sql<Date>`now()`)
    .where('u.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at as Date).getTime() > 60_000) {
    const s = await authSettings(q);
    await q.updateTable('staff_sessions')
      .set({ last_seen_at: sql<Date>`now()`, idle_expires_at: sql<Date>`least(now() + make_interval(mins => ${s.staffIdleMinutes}), expires_at)` })
      .where('id', '=', row.session_id).execute();
  }
  return {
    staffId: row.staff_id, email: row.email, fullName: row.full_name, sessionId: row.session_id,
    permissions: await loadPermissions(q, row.staff_id),
  };
}

/** Revokes the session for this token; returns its staff id (or null if there was no live session). */
export async function revokeStaffSession(q: Queryable, token: string): Promise<{ staffId: string; sessionId: string } | null> {
  const row = await q.updateTable('staff_sessions').set({ revoked_at: sql<Date>`now()` })
    .where('token_hash', '=', hashToken(token)).where('revoked_at', 'is', null)
    .returning(['staff_user_id', 'id']).executeTakeFirst();
  return row ? { staffId: row.staff_user_id, sessionId: row.id } : null;
}

/** Ends every live session of a staff member (optionally keeping one, e.g. the one that changed the password). */
export async function revokeAllStaffSessions(q: Queryable, staffId: string, exceptSessionId?: string): Promise<number> {
  let query = q.updateTable('staff_sessions').set({ revoked_at: sql<Date>`now()` })
    .where('staff_user_id', '=', staffId).where('revoked_at', 'is', null);
  if (exceptSessionId) query = query.where('id', '!=', exceptSessionId);
  const res = await query.executeTakeFirst();
  return Number(res.numUpdatedRows);
}
