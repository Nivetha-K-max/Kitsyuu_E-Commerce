import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { catalogueSource } from '../catalogue-source';
import { localCatalogueClient } from './local-source';

/* Public (anon / publishable key) Supabase client for catalogue reads on the server.
   Row Level Security limits it to active catalogue data. The service-role key is never used here.
   Network: one retry on connection-level failures (a transient connect timeout was seen in Phase 4.2), an 8 s timeout per
   attempt, and no retry when the host does not resolve, so an outage fails fast instead of hanging the page.
   HTTP errors are not retried and surface as real errors. */
const RETRIES = 1, TIMEOUT_MS = 8000;

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (attempt >= RETRIES || code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

let client: SupabaseClient | undefined;
export function publicSupabase(): SupabaseClient {
  if (client) return client;
  /* Local development and tests (CATALOGUE_SOURCE=database): the same reads are answered from this machine's database and the
     hosted project is never contacted (lib/supabase/local-source.ts). Unset, as in production, nothing below changes. */
  if (catalogueSource() === 'database') return (client = localCatalogueClient() as unknown as SupabaseClient);
  /* SUPABASE_URL / SUPABASE_ANON_KEY (server-only, read at runtime) override the NEXT_PUBLIC_ values baked in at build. */
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Catalogue unavailable: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set (apps/website/.env.local).');
  /* db.retry=false: postgrest-js would otherwise add its own 1 s/2 s/4 s back-off on top of fetchWithRetry (≈7 s per query in an outage). */
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, db: { retry: false }, global: { fetch: fetchWithRetry } });
  return client;
}
