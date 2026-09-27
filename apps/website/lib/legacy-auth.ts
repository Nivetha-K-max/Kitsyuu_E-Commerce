import 'server-only';
/* Verify-on-login migration (M6): customers whose account still lives in Supabase Auth (mirrored into public.customers
   with the same UUID, but no platform password yet) sign in with their existing password. This checks that password once
   against Supabase Auth, server-side with the public key; on success @kitsyuu/auth stores it as an Argon2id hash and
   Supabase is never asked for this account again. No password hash is copied. The Supabase session created by the check
   is not kept: it is revoked straight away. Set LEGACY_SUPABASE_AUTH=off to disable the check (tests, or after all
   accounts have moved). */
import { createClient } from '@supabase/supabase-js';
import type { LegacyPasswordCheck } from '@kitsyuu/auth';

export const supabasePasswordCheck: LegacyPasswordCheck = async (email, password) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || process.env.LEGACY_SUPABASE_AUTH === 'off') return false;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.session || data.user?.email?.toLowerCase() !== email) return false;
    await sb.auth.signOut({ scope: 'local' }).catch(() => undefined);   // end the session this check created
    return true;
  } catch {
    return false;                                                        // Supabase unreachable: treated as a wrong password
  }
};
