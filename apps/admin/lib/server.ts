import 'server-only';
/* Server-side wiring for the admin app: configuration, database, mailer, session cookie and request context.
   Everything here runs on the server only; the 'server-only' import makes the build fail if a client component
   ever imports it. */
import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createDb, type Db } from '@kitsyuu/db';
import { createMailer, validateStaffSession, type Mailer, type RequestContext, type StaffPrincipal } from '@kitsyuu/auth';
import { localStorage, supabaseStorage, type ObjectStorage } from '@kitsyuu/core';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See apps/admin/.env.example.`);
  return v;
}

// One pool per server instance (reused across requests and hot reloads).
const g = globalThis as unknown as { __kitsyuuAdminDb?: Db; __kitsyuuAdminMailer?: Mailer };
export function db(): Db {
  return (g.__kitsyuuAdminDb ??= createDb({ connectionString: required('ADMIN_DATABASE_URL'), max: 5 }));
}
export function mailer(): Mailer {
  return (g.__kitsyuuAdminMailer ??= createMailer(process.env.MAILER || 'console'));
}

/** Absolute links for emails come from configuration, never from the request's Host header. */
export function appUrl(path: string): string {
  return new URL(path, required('ADMIN_APP_URL')).toString();
}
export const inviteUrl = (token: string) => appUrl(`/accept-invite?token=${encodeURIComponent(token)}`);
export const resetUrl = (token: string) => appUrl(`/reset-password?token=${encodeURIComponent(token)}`);

/** Public URL of a product image. With STORAGE_DRIVER=local (development/tests) images are served by this app's
    /media route; otherwise from the product-images bucket's public base URL (configuration, not a secret). */
export function productImageUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  const encoded = storagePath.split('/').map(encodeURIComponent).join('/');
  if (process.env.STORAGE_DRIVER === 'local') return `/media/${encoded}`;
  const base = process.env.PRODUCT_IMAGE_BASE_URL;
  return base ? `${base.replace(/\/+$/, '')}/${encoded}` : null;
}

/** Where uploaded product images are written. 'supabase' (production) uses the server-only service key; 'local'
    writes to LOCAL_STORAGE_DIR and never touches the live bucket. There is no default: it must be configured. */
const gs = globalThis as unknown as { __kitsyuuStorage?: ObjectStorage };
export function storage(): ObjectStorage {
  if (gs.__kitsyuuStorage) return gs.__kitsyuuStorage;
  const driver = process.env.STORAGE_DRIVER;
  if (driver === 'local') return (gs.__kitsyuuStorage = localStorage(required('LOCAL_STORAGE_DIR')));
  if (driver === 'supabase') return (gs.__kitsyuuStorage = supabaseStorage({ url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_ROLE_KEY'), bucket: 'product-images' }));
  throw new Error('STORAGE_DRIVER is not set to "supabase" or "local". See apps/admin/.env.example.');
}

// ---------- session cookie ----------
// __Host- prefix: Secure, Path=/, no Domain, so it is only ever sent to this exact host over HTTPS (or localhost).
export const SESSION_COOKIE = '__Host-kitsyuu_admin';

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: expiresAt });
}
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** The signed-in staff member for this request (validated against the database once per request), or null. */
export const currentActor = cache(async (): Promise<StaffPrincipal | null> => {
  const token = await sessionToken();          // reading the cookie first also marks the page as per-request (never prerendered)
  return token ? validateStaffSession(db(), token) : null;
});

/** For pages and actions that need a signed-in staff member. */
export async function requireActor(): Promise<StaffPrincipal> {
  const actor = await currentActor();
  if (!actor) redirect(`/login?reason=${(await sessionToken()) ? 'expired' : 'signin'}`);
  return actor;
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

/** Same-site relative path only (no protocol-relative or absolute URLs), for ?next= redirects after sign-in. */
export function safeNext(next: unknown, fallback = '/dashboard'): string {
  return typeof next === 'string' && /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) && !next.startsWith('/login') ? next : fallback;
}
