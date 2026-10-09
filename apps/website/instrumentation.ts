/* Runs once when the server starts (2026-10-08). The catalogue source is checked here, before any page is served, so a
   misconfigured store stops at start instead of answering from a cache left on disk by an earlier run:
   · CATALOGUE_SOURCE=database together with a hosted public API URL, or in a deployment, is refused (lib/catalogue-source.ts);
   · with no source at all (CATALOGUE_SOURCE unset AND no public API URL and key) there is nothing to read the catalogue from,
     and the store would otherwise keep showing whatever catalogue was cached last. That is refused too (2026-10-09).
   A correctly configured production deployment (public API URL and key set) passes both checks unchanged. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { catalogueSource } = await import('./lib/catalogue-source');
  if (catalogueSource() === 'api') {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('No catalogue source is configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (production), '
      + 'or CATALOGUE_SOURCE=database for local development and tests. Refusing to serve a cached catalogue.');
  }
}
