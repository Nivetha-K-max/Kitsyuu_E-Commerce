import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/* Session-aware Supabase client for Server Components / Route Handlers. Uses the PUBLIC key plus the signed-in user's
   session cookie, so every query runs under that user's Row Level Security. No service-role key here. */
export async function serverSupabase() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: list => {
        /* Server Components cannot set cookies; proxy.ts refreshes the session instead. Route Handlers can. */
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      }
    }
  });
}
