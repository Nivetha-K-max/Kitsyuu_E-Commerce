import 'server-only';
import { cache } from 'react';
import { publicSupabase } from './supabase/public';
import { RETURNS_POLICY, returnsPolicy } from './store-policy';

export type Announcement = { text: string; href: string | null };

/* M17: the published announcement (site_content 'store.announcement'), read with the public key like the catalogue.
   Not essential: before migration 2700, or on any error, the store simply shows no announcement. */
export const getAnnouncement = cache(async (): Promise<Announcement | null> => {
  try {
    const r = await publicSupabase().from('site_content').select('content')
      .eq('key', 'store.announcement').eq('locale', 'en-IN').eq('status', 'published').maybeSingle();
    const c = (r.data?.content ?? null) as Record<string, unknown> | null;
    if (r.error || !c || typeof c.text !== 'string' || !c.text) return null;
    const href = typeof c.href === 'string' && /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(c.href) ? c.href : null;
    return { text: c.text.slice(0, 140), href };
  } catch {
    return null;
  }
});

/* ERP module 3: the returns wording for the footer and emails. "All sales are final" unless the business has switched
   returns on in the admin. Not essential: on any error (e.g. no database at build time) the default wording is used. */
export const getReturnsPolicy = cache(async (): Promise<string> => {
  try {
    const { returnSettings } = await import('@kitsyuu/core');
    const { db } = await import('./server');
    return returnsPolicy(await returnSettings(db()));
  } catch {
    return RETURNS_POLICY;
  }
});

export type Banner = { id: string; heading: string; body: string | null; ctaLabel: string | null; link: string | null };
/* ERP module 4: live promotional banners for a page, read with the public key (the RLS policy only returns banners that
   are published and inside their dates). Not essential: on any error the page shows no banner. */
export const getBanners = cache(async (placement: 'home' | 'shop'): Promise<Banner[]> => {
  try {
    const r = await publicSupabase().from('banners').select('id, heading, body, cta_label, link').eq('placement', placement)
      .order('sort_order').order('created_at', { ascending: false }).limit(3);
    if (r.error || !r.data) return [];
    return r.data.map(b => ({ id: String(b.id), heading: String(b.heading).slice(0, 80), body: b.body ? String(b.body).slice(0, 240) : null,
      ctaLabel: b.cta_label ? String(b.cta_label).slice(0, 30) : null, link: typeof b.link === 'string' && /^\/[^/]/.test(b.link) ? b.link : null }));
  } catch {
    return [];
  }
});
