import 'server-only';
/* Server-side wiring for customer accounts (M6): configuration, database, mailer, the session cookie and request context.
   The 'server-only' import makes the build fail if a client component ever imports this file. The catalogue itself is
   still read through the public Supabase API (lib/catalogue.ts); customer data goes through the kitsyuu_website role. */
import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createDb, type Db } from '@kitsyuu/db';
import { createMailer, validateCustomerSession, type CustomerPrincipal, type Mailer, type RequestContext } from '@kitsyuu/auth';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See apps/website/.env.example.`);
  return v;
}

// One pool per server instance (reused across requests and hot reloads).
const g = globalThis as unknown as { __kitsyuuWebDb?: Db; __kitsyuuWebMailer?: Mailer };
export function db(): Db {
  return (g.__kitsyuuWebDb ??= createDb({ connectionString: required('WEBSITE_DATABASE_URL'), max: 5 }));
}
export function mailer(): Mailer {
  return (g.__kitsyuuWebMailer ??= createMailer(process.env.MAILER || 'console'));
}

/** Absolute links for emails come from configuration, never from the request's Host header. */
export function siteUrl(path: string): string {
  return new URL(path, required('SITE_URL')).toString();
}
export const verifyUrl = (token: string) => siteUrl(`/verify-email?token=${encodeURIComponent(token)}`);
export const resetUrl = (token: string) => siteUrl(`/reset-password?token=${encodeURIComponent(token)}`);

// ---------- session cookie ----------
// __Host- prefix: Secure, Path=/, no Domain, so it is only ever sent to this exact host over HTTPS (or localhost).
// SameSite=Lax keeps the customer signed in when arriving from an email link while blocking cross-site form posts.
export const SESSION_COOKIE = '__Host-kitsyuu_customer';

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: expiresAt });
}
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** The signed-in customer for this request (validated against the database once per request), or null. */
export const currentCustomer = cache(async (): Promise<CustomerPrincipal | null> => {
  const token = await sessionToken();          // reading the cookie also marks the page as per-request (never prerendered)
  return token ? validateCustomerSession(db(), token) : null;
});

/** For pages and actions that need a signed-in customer; others are sent to log in and brought back afterwards. */
export async function requireCustomer(next: string): Promise<CustomerPrincipal> {
  const customer = await currentCustomer();
  if (!customer) redirect(`/login?next=${encodeURIComponent(next)}${(await sessionToken()) ? '&reason=session' : ''}`);
  return customer;
}

export const requestContext = cache(async (): Promise<RequestContext> => {
  const h = await headers();
  const ip = (h.get('x-forwarded-for')?.split(',')[0] || h.get('x-real-ip') || '').trim();
  return {
    ip: /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null,          // stored as inet: only accept address-shaped values
    userAgent: h.get('user-agent'),
    requestId: h.get('x-vercel-id') || randomUUID(),
  };
});
