/* M9: operations and hardening. Health checks (no secrets, no row data), the admin System page, sign-in history for the
   audit view, and the checkout rate limit. The rate limit sits in front of checkout (called by the website action); the
   checkout itself (checkout.ts, M7) is unchanged. */
import { sql, type Db } from '@kitsyuu/db';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';

/** Round trip to the database. Never throws: a failure is reported as { ok: false }. */
export async function pingDatabase(db: Db): Promise<{ ok: boolean; latencyMs: number | null; dbTime: string | null }> {
  const t = performance.now();
  try {
    const r = await sql<{ now: Date }>`select now() as now`.execute(db);
    return { ok: true, latencyMs: Math.round(performance.now() - t), dbTime: (r.rows[0].now as Date).toISOString() };
  } catch {
    return { ok: false, latencyMs: null, dbTime: null };
  }
}

export const CHECKOUT_RATE_KEY = 'security.checkout_orders_per_hour';
/** Used only if the setting row is missing (migration 002000 adds it). */
const CHECKOUT_RATE_FALLBACK = 10;

/** How many orders one customer may create per hour (a newer checkout replacing an unpaid one also counts). */
export async function checkoutRateLimit(db: Db, customerId: string): Promise<{ allowed: boolean; limit: number }> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', CHECKOUT_RATE_KEY).executeTakeFirst();
  const v = Number(row?.value);
  const limit = Number.isInteger(v) && v > 0 ? v : CHECKOUT_RATE_FALLBACK;
  const { n } = await db.selectFrom('orders').select(sql<number>`count(*)::int`.as('n'))
    .where('customer_id', '=', customerId).where(sql<boolean>`created_at > now() - interval '1 hour'`).executeTakeFirstOrThrow();
  return { allowed: n < limit, limit };
}

export type RuntimeInfo = { app: string; version: string; node: string; environment: string; config: Record<string, string> };

/** Everything the System page shows. Configuration is reported as modes/flags only, never as values of secrets. */
export async function getSystemStatus(db: Db, actor: StaffPrincipal, runtime: RuntimeInfo) {
  requirePermission(actor, 'system.read');
  const database = await pingDatabase(db);
  const since = sql<boolean>`attempted_at > now() - interval '24 hours'`;
  const [signins, lastSystem, lastExpiry] = await Promise.all([
    db.selectFrom('auth_attempts').select(['realm', sql<number>`count(*) filter (where succeeded)::int`.as('ok'), sql<number>`count(*) filter (where not succeeded)::int`.as('failed')])
      .where(since).groupBy('realm').execute(),
    db.selectFrom('audit_logs').select(['action', 'occurred_at']).where('actor_type', '=', 'system').orderBy('occurred_at', 'desc').limit(1).executeTakeFirst(),
    db.selectFrom('audit_logs').select(['occurred_at']).where('action', 'like', 'order.expire%').orderBy('occurred_at', 'desc').limit(1).executeTakeFirst(),
  ]);
  const clockSkewMs = database.dbTime ? Math.abs(Date.now() - Date.parse(database.dbTime)) : null;
  return {
    database, clockSkewMs, runtime,
    signins24h: Object.fromEntries(signins.map(s => [s.realm, { ok: s.ok, failed: s.failed }])) as Record<string, { ok: number; failed: number }>,
    lastSystemEvent: lastSystem ? { action: lastSystem.action, at: lastSystem.occurred_at as Date } : null,
    lastOrderExpiry: lastExpiry ? (lastExpiry.occurred_at as Date) : null,
  };
}

export const SIGNIN_PAGE_SIZE = 50;
/** Sign-in attempts (staff and customers) for the audit view. Emails and IPs are personal data: audit.read only. */
export async function listSignIns(db: Db, actor: StaffPrincipal, q: { page: number; realm?: 'staff' | 'customer'; failedOnly?: boolean; email?: string }) {
  requirePermission(actor, 'audit.read');
  let s = db.selectFrom('auth_attempts').select(['id', 'realm', 'email', 'ip', 'succeeded', 'failure_reason', 'attempted_at']);
  if (q.realm) s = s.where('realm', '=', q.realm);
  if (q.failedOnly) s = s.where('succeeded', '=', false);
  if (q.email) s = s.where('email', '=', q.email.trim().toLowerCase());
  const rows = await s.orderBy('attempted_at', 'desc').orderBy('id', 'desc').limit(SIGNIN_PAGE_SIZE + 1).offset((q.page - 1) * SIGNIN_PAGE_SIZE).execute();
  return {
    rows: rows.slice(0, SIGNIN_PAGE_SIZE).map(r => ({ id: r.id, realm: r.realm, email: r.email, ip: r.ip, succeeded: r.succeeded, reason: r.failure_reason, at: r.attempted_at as Date })),
    hasNext: rows.length > SIGNIN_PAGE_SIZE,
  };
}
