/* Rate limits for public endpoints (2026-10-09), counted in Redis so every server instance shares one count.
   - Store: a Redis reached over its REST API (Upstash, or any service speaking the same /pipeline protocol). Nothing is
     installed; it is two HTTPS calls' worth of JSON. Each limit is a fixed window: INCR a key named after the limit, the
     caller and the window, with the window's length as its expiry.
   - Callers are identified by an address, an account or an email. Only a SHA-256 of that identity is sent to Redis and
     written to logs; no address, email or account id is stored there.
   - Not configured → no limits (said once in the log). The limiter cannot be reached or answers nonsense → the request is
     ALLOWED by default and the failure is logged (at most once a minute): a broken limiter must not lock customers out of
     logging in or ordering, and the protections in the database (login lockout, orders per hour) do not depend on it.
     onError: 'deny' turns that around for a deployment that prefers to refuse.
   - Every refusal is logged as one line ("[rate-limit] blocked …") for abuse monitoring. */
import { createHash } from 'node:crypto';

export type RateLimitRule = { limit: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; limit: number; count: number | null; retryAfterSeconds: number; state: 'counted' | 'off' | 'error' };
export interface RateLimiter {
  readonly enabled: boolean;
  check(name: string, identity: string | null | undefined, rule: RateLimitRule): Promise<RateLimitResult>;
}
export interface RateLimiterConfig {
  /** REST endpoint of the Redis service, e.g. https://<name>.upstash.io (no trailing path). */
  url?: string | null; token?: string | null;
  prefix?: string; onError?: 'allow' | 'deny'; timeoutMs?: number;
  now?: () => number; log?: (line: string) => void;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function createRateLimiter(cfg: RateLimiterConfig): RateLimiter {
  const log = cfg.log ?? (line => console.error(line));
  const now = cfg.now ?? Date.now;
  const url = (cfg.url ?? '').trim().replace(/\/$/, ''), token = (cfg.token ?? '').trim();
  const off = (rule: RateLimitRule): RateLimitResult => ({ allowed: true, limit: rule.limit, count: null, retryAfterSeconds: 0, state: 'off' });
  if (!url || !token) {
    return { enabled: false, async check(_name, _identity, rule) { return off(rule); } };
  }
  const prefix = cfg.prefix ?? 'kitsyuu:rl';
  let lastErrorLog = 0;
  return {
    enabled: true,
    async check(name, identity, rule) {
      if (!identity) return off(rule);                          // nobody to count (e.g. no address on the request)
      const t = now(), windowMs = rule.windowSeconds * 1000, bucket = Math.floor(t / windowMs);
      const key = `${prefix}:${name}:${hash(identity)}:${bucket}`;
      const retryAfterSeconds = Math.max(1, Math.ceil(((bucket + 1) * windowMs - t) / 1000));
      try {
        const res = await fetch(`${url}/pipeline`, {
          method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs ?? 1500),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(rule.windowSeconds + 5)]]),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json() as { result?: unknown; error?: string }[];
        const count = Number(Array.isArray(body) ? body[0]?.result : NaN);
        if (!Number.isInteger(count) || count < 1) throw new Error('unexpected answer');
        const allowed = count <= rule.limit;
        // Logged on the first refusal and then every 25th, so a flood does not flood the log.
        if (!allowed && (count === rule.limit + 1 || (count - rule.limit) % 25 === 0))
          log(`[rate-limit] blocked name=${name} caller=${hash(identity).slice(0, 12)} count=${count} limit=${rule.limit} window=${rule.windowSeconds}s`);
        return { allowed, limit: rule.limit, count, retryAfterSeconds: allowed ? 0 : retryAfterSeconds, state: 'counted' };
      } catch (e) {
        const deny = cfg.onError === 'deny';
        if (t - lastErrorLog > 60_000) { lastErrorLog = t; log(`[rate-limit] ERROR: the limiter is not answering (${(e as Error).name}: ${String((e as Error).message).slice(0, 80)}). Requests are ${deny ? 'REFUSED' : 'allowed'} meanwhile.`); }
        return { allowed: !deny, limit: rule.limit, count: null, retryAfterSeconds: deny ? 30 : 0, state: 'error' };
      }
    },
  };
}

/** "in 12 minutes" / "in 40 seconds", for the message a refused visitor reads. */
export function retryAfterText(seconds: number): string {
  if (seconds >= 90) { const m = Math.ceil(seconds / 60); return `in ${m} minutes`; }
  return seconds > 1 ? `in ${seconds} seconds` : 'in a moment';
}
