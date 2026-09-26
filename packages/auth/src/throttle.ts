/* Login throttling, backed by auth_attempts. Failures are counted per email and per IP inside the configured window,
   ignoring failures from before the account's last successful login. Every attempt is recorded, including for
   unknown emails, so the responses and timing are the same whether or not an account exists. */
import { sql, type Queryable, type AuthRealm } from '@kitsyuu/db';
import type { AuthSettings } from './settings.ts';

export async function loginThrottle(q: Queryable, realm: AuthRealm, email: string, ip: string | null, s: AuthSettings) {
  const inWindow = sql<boolean>`attempted_at > now() - make_interval(mins => ${s.loginWindowMinutes})`;
  const afterLastSuccess = sql<boolean>`attempted_at > coalesce((select max(a2.attempted_at) from public.auth_attempts a2
    where a2.realm = ${realm} and a2.email = ${email} and a2.succeeded), '-infinity'::timestamptz)`;
  const byEmail = await q.selectFrom('auth_attempts').select(sql<number>`count(*)::int`.as('n'))
    .where('realm', '=', realm).where('email', '=', email).where('succeeded', '=', false)
    .where(inWindow).where(afterLastSuccess)
    .executeTakeFirstOrThrow();
  const byIp = ip ? await q.selectFrom('auth_attempts').select(sql<number>`count(*)::int`.as('n'))
    .where('realm', '=', realm).where('ip', '=', ip).where('succeeded', '=', false).where(inWindow)
    .executeTakeFirstOrThrow() : { n: 0 };
  const allowed = byEmail.n < s.loginMaxFailures && byIp.n < s.loginMaxFailures;
  return { allowed, retryAfterMinutes: s.loginWindowMinutes };
}

export async function recordLoginAttempt(q: Queryable, a: { realm: AuthRealm; email: string; ip: string | null; succeeded: boolean; reason?: string }) {
  await q.insertInto('auth_attempts').values({
    realm: a.realm, email: a.email.slice(0, 254), ip: a.ip, succeeded: a.succeeded, failure_reason: a.succeeded ? null : (a.reason ?? 'failed'),
  }).execute();
}
