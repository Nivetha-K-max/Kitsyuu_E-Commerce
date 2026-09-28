import 'server-only';
import { cache } from 'react';
import { publicSupabase } from './supabase/public';

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
