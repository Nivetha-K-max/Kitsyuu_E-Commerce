import 'server-only';
/* Rate limits on the store's public endpoints (2026-10-09), counted in Redis (packages/core/src/rate-limit.ts).
   Configuration, server-side only:
   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL + KV_REST_API_TOKEN, the names the hosting
     platform's Redis integration creates). Unset = no limits; said once in the log.
   - RATE_LIMIT_ON_ERROR=deny refuses requests while the limiter cannot be reached. The default allows them (and logs).
   - Outside a deployment the limiter must be on this machine: a local server or test never contacts a hosted Redis.
   The numbers below are STARTING values, set without traffic data; they are to be reviewed against real usage.
   What already protects these forms and does not depend on this: login lockout per email and address (database),
   orders per customer per hour (database), and validation of every input. */
import { createRateLimiter, retryAfterText, type RateLimiter, type RateLimitRule } from '@kitsyuu/core';
import { isDeployed } from './db-guard';
import { guestHelpOpen } from './guest-help';
import { requestContext } from './server';

const MIN = 60, HOUR = 3600;
export const RATE_LIMITS = {
  'login':            { limit: 20,  windowSeconds: 10 * MIN },   // per address; each email is also locked by the database after repeated failures
  'signup':           { limit: 5,   windowSeconds: HOUR },       // per address
  'signup-email':     { limit: 3,   windowSeconds: HOUR },       // per email: one address cannot be sent endless confirmation emails
  'verify-resend':    { limit: 5,   windowSeconds: HOUR },       // per address
  'verify-email':     { limit: 3,   windowSeconds: HOUR },       // per email
  'password-forgot':  { limit: 5,   windowSeconds: HOUR },       // per address
  'password-email':   { limit: 3,   windowSeconds: HOUR },       // per email
  'password-reset':   { limit: 10,  windowSeconds: HOUR },       // per address (guessing reset links)
  'newsletter':       { limit: 5,   windowSeconds: HOUR },       // per address
  'ticket-open':      { limit: 5,   windowSeconds: HOUR },       // per customer
  'ticket-reply':     { limit: 30,  windowSeconds: HOUR },       // per customer
  'coupon':           { limit: 10,  windowSeconds: 10 * MIN },   // per customer (guessing codes)
  'cart-check':       { limit: 120, windowSeconds: MIN },        // per address (a background check the cart page repeats)
  // Help window (2026-10-12)
  'help-ask':           { limit: 40, windowSeconds: 10 * MIN },  // per address (matching a question to the help topics)
  'order-lookup':       { limit: 8,  windowSeconds: 10 * MIN },  // per address (guessing order numbers or contacts)
  'order-lookup-order': { limit: 6,  windowSeconds: HOUR },      // per order number (many addresses guessing one order's contact)
  'guest-ticket':       { limit: 3,  windowSeconds: HOUR },      // per address (messages from people who are not signed in)
  'guest-ticket-email': { limit: 3,  windowSeconds: HOUR },      // per email typed into the form
} satisfies Record<string, RateLimitRule>;
export type RateLimitName = keyof typeof RATE_LIMITS;

const g = globalThis as unknown as { __kitsyuuRateLimiter?: RateLimiter };

function build(): RateLimiter {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) {
    console.warn('[rate-limit] not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN): public endpoints have no request limits.');
    return createRateLimiter({});
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { /* reported below */ }
  if (!host) { console.error('[rate-limit] ERROR: UPSTASH_REDIS_REST_URL is not a URL. Limits are OFF.'); return createRateLimiter({}); }
  if (!isDeployed() && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    console.error('[rate-limit] ERROR: the limiter is not on this machine and this is not a production deployment. Refusing to contact it; limits are OFF.');
    return createRateLimiter({});
  }
  return createRateLimiter({ url, token, onError: process.env.RATE_LIMIT_ON_ERROR === 'deny' ? 'deny' : 'allow' });
}
export function rateLimiter(): RateLimiter { return g.__kitsyuuRateLimiter ??= build(); }

/** Whether the help window's guest features (order lookup, a message without an account) may be used on this server:
    never on a production deployment without a configured limiter (lib/guest-help.ts). Checked by the server actions
    themselves, so hiding the forms is not the protection. */
export function guestHelpAllowed(): boolean {
  return guestHelpOpen({ deployed: isDeployed(), limiterConfigured: rateLimiter().enabled, required: process.env.HELP_GUEST_REQUIRES_LIMITER === 'on' });
}

/** Null when the request may go on; otherwise the sentence to show (how long to wait). */
export async function limited(name: RateLimitName, identity: string | null | undefined): Promise<string | null> {
  const r = await rateLimiter().check(name, identity, RATE_LIMITS[name]);
  return r.allowed ? null : `Too many attempts. Please try again ${retryAfterText(r.retryAfterSeconds)}.`;
}
/** For the help window's guest features (2026-10-13): as limited(), and ALSO refused while a configured limiter cannot count
    the request (it cannot be reached, or the request has no address to count by). Everything else keeps the limiter's
    "allow on failure" default; these two forms answer questions about orders to people who are not signed in, so an
    uncounted request is not let through. With no limiter configured at all, guestHelpAllowed() decides. */
export const GUEST_UNCOUNTED = 'This is not available right now. Please try again in a few minutes, or sign in to your account.';
export async function limitedStrict(name: RateLimitName, identity: string | null | undefined): Promise<string | null> {
  const limiter = rateLimiter();
  const r = await limiter.check(name, identity, RATE_LIMITS[name]);
  if (!r.allowed) return `Too many attempts. Please try again ${retryAfterText(r.retryAfterSeconds)}.`;
  return limiter.enabled && r.state !== 'counted' ? GUEST_UNCOUNTED : null;
}
/** The same, counted per requesting address. */
export async function limitedByAddress(name: RateLimitName): Promise<string | null> {
  return limited(name, (await requestContext()).ip);
}
