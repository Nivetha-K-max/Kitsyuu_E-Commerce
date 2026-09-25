'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/* Browser Supabase client for sign-up / log-in / log-out. PUBLIC (publishable) key only: it can never grant a role;
   profiles.role is protected by column grants + RLS, and admins are promoted server-side (scripts/promote-admin.mjs).
   The session is stored in cookies so Server Components and proxy.ts can read it. */
let client: SupabaseClient | undefined;
export function browserSupabase(): SupabaseClient {
  return client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
