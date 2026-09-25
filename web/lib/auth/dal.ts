import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverSupabase } from '@/lib/supabase/server';

/* Data Access Layer: the authoritative auth checks. Every protected page calls these on the server.
   getUser() re-validates the session with Supabase (it does not just trust the cookie), and the role is read from
   public.profiles under the user's own RLS. Hiding UI or editing the URL cannot bypass it. */

export type Role = 'customer' | 'admin';
export type Profile = { id: string; email: string; fullName: string | null; phone: string | null; role: Role; createdAt: string };

const hasAuthCookie = async () => (await cookies()).getAll().some(c => /^sb-.+-auth-token/.test(c.name));

export const getCurrentUser = cache(async () => {
  const sb = await serverSupabase();
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const sb = await serverSupabase();
  const { data, error } = await sb.from('profiles').select('id, email, full_name, phone, role, created_at').eq('id', user.id).maybeSingle();
  if (error) throw new Error(`Could not load your profile (${error.message})`);
  /* The signup trigger creates the profile; if it is somehow missing, treat the user as a customer (never as admin). */
  if (!data) return { id: user.id, email: user.email ?? '', fullName: null, phone: null, role: 'customer', createdAt: user.created_at };
  return { id: data.id, email: data.email ?? user.email ?? '', fullName: data.full_name, phone: data.phone, role: data.role as Role, createdAt: data.created_at };
});

/* Signed-in user or redirect to /login (with reason=session when a stale/expired session cookie was present). */
export async function requireUser(next: string): Promise<Profile> {
  const profile = await getProfile();
  if (profile) return profile;
  redirect(`/login?next=${encodeURIComponent(next)}${(await hasAuthCookie()) ? '&reason=session' : ''}`);
}

/* 'admin' | 'forbidden'. Guests are redirected to log in; signed-in non-admins get 'forbidden'. */
export async function requireAdmin(next: string): Promise<{ status: 'admin'; profile: Profile } | { status: 'forbidden'; profile: Profile }> {
  const profile = await requireUser(next);
  return profile.role === 'admin' ? { status: 'admin', profile } : { status: 'forbidden', profile };
}
