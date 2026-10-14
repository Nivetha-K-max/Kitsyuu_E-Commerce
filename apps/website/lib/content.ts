import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { publicSupabase } from './supabase/public';
import { RETURNS_POLICY, returnsPolicy } from './store-policy';

export type Announcement = { text: string; href: string | null };

/* Performance (2026-10-14): every read below is the same for every visitor (published content and store settings), and the
   layout makes them on each page rendered per request. Like the catalogue (lib/catalogue.ts), each result is now kept in
   Next's data cache for 30 s (tag 'content'), so a change made in the admin shows within 30 s. A failed read THROWS inside
   the cached function, so a failure is never cached; the outer function then gives the same fallback as before. React
   cache() still dedupes the calls within one request. */
const shared = <A extends unknown[], T>(key: string, load: (...a: A) => Promise<T>) => unstable_cache(load, [`content-v1:${key}`], { revalidate: 30, tags: ['content'] });
const failed = (what: string, e: unknown) => { throw new Error(`${what}: ${(e as { message?: string })?.message ?? 'read failed'}`); };

/* M17: the published announcement (site_content 'store.announcement'), read with the public key like the catalogue.
   Not essential: before migration 2700, or on any error, the store simply shows no announcement. */
const loadAnnouncement = shared('announcement', async (): Promise<Announcement | null> => {
  const r = await publicSupabase().from('site_content').select('content')
    .eq('key', 'store.announcement').eq('locale', 'en-IN').eq('status', 'published').maybeSingle();
  if (r.error) failed('announcement', r.error);
  const c = (r.data?.content ?? null) as Record<string, unknown> | null;
  if (!c || typeof c.text !== 'string' || !c.text) return null;
  const href = typeof c.href === 'string' && /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(c.href) ? c.href : null;
  return { text: c.text.slice(0, 140), href };
});
export const getAnnouncement = cache(async (): Promise<Announcement | null> => loadAnnouncement().catch(() => null));

/* ERP module 3: the returns wording for the footer and emails. "All sales are final" unless the business has switched
   returns on in the admin. Not essential: on any error (e.g. no database at build time) the default wording is used. */
const loadReturnsPolicy = shared('returns-policy', async (): Promise<string> => {
  const { returnSettings } = await import('@kitsyuu/core');
  const { db } = await import('./server');
  return returnsPolicy(await returnSettings(db()));
});
export const getReturnsPolicy = cache(async (): Promise<string> => loadReturnsPolicy().catch(() => RETURNS_POLICY));

export type Banner = { id: string; heading: string; body: string | null; ctaLabel: string | null; link: string | null };
/* ERP module 4: live promotional banners for a page, read with the public key (the RLS policy only returns banners that
   are published and inside their dates). Not essential: on any error the page shows no banner. Cached per placement. */
const loadBanners = shared('banners', async (placement: 'home' | 'shop'): Promise<Banner[]> => {
  const r = await publicSupabase().from('banners').select('id, heading, body, cta_label, link').eq('placement', placement)
    .order('sort_order').order('created_at', { ascending: false }).limit(3);
  if (r.error || !r.data) failed('banners', r.error);
  return r.data!.map(b => ({ id: String(b.id), heading: String(b.heading).slice(0, 80), body: b.body ? String(b.body).slice(0, 240) : null,
    ctaLabel: b.cta_label ? String(b.cta_label).slice(0, 30) : null, link: typeof b.link === 'string' && /^\/[^/]/.test(b.link) ? b.link : null }));
});
export const getBanners = cache(async (placement: 'home' | 'shop'): Promise<Banner[]> => loadBanners(placement).catch(() => []));

/* Client change request ("Japan → India: No"): the brand wording staff can edit under Store content. Until they publish new
   wording (and on any error) every field is exactly today's text, so the store looks the same. Only the published row is
   cached; the merge with today's text happens on each request. */
const loadBrandCopy = shared('brand-copy', async (): Promise<unknown> => {
  const r = await publicSupabase().from('site_content').select('content')
    .eq('key', 'store.brand_copy').eq('locale', 'en-IN').eq('status', 'published').maybeSingle();
  if (r.error) failed('brand copy', r.error);
  return r.data?.content ?? null;
});
export const getBrandCopy = cache(async () => {
  const { mergeBrandCopy } = await import('@kitsyuu/core');
  return mergeBrandCopy(await loadBrandCopy().catch(() => null));
});

/* Client change request: how often a cart with items re-syncs (Settings → Checkout → "Cart refresh interval"; 60 minutes
   unless set; 2026-10-01). Read with the page, so guests make no extra request. On any error: the default. */
const loadCartRefreshMinutes = shared('cart-refresh', async (): Promise<number> => {
  const { cartRefreshMinutes } = await import('@kitsyuu/core');
  const { db } = await import('./server');
  return cartRefreshMinutes(db());
});
export const getCartRefreshMinutes = cache(async (): Promise<number> => loadCartRefreshMinutes().catch(() => 60));   // 60 = CART_REFRESH_DEFAULT_MINUTES (packages/core/src/cart.ts)
