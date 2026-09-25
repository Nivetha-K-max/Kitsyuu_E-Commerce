'use client';
/* Signed-in state for the header and auth forms. This is a UI hint only: access to /account and /admin is decided on the
   server (proxy.ts + lib/auth/dal.ts). The role is read from the user's own profiles row under RLS (public key). */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase/browser';

type AuthState = { status: 'loading' | 'guest' | 'user'; user: User | null; role: 'customer' | 'admin' | null; refresh: () => Promise<void> };
const Ctx = createContext<AuthState>({ status: 'loading', user: null, role: null, refresh: async () => {} });
export const useAuth = () => useContext(Ctx);

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, 'refresh'>>({ status: 'loading', user: null, role: null });
  const path = usePathname();

  const refresh = useCallback(async () => {
    const sb = browserSupabase();
    const { data } = await sb.auth.getSession();
    const user = data.session?.user ?? null;
    if (!user) { setState({ status: 'guest', user: null, role: null }); return; }
    const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    setState({ status: 'user', user, role: prof?.role === 'admin' ? 'admin' : 'customer' });
  }, []);

  useEffect(() => {
    void refresh();
    const { data } = browserSupabase().auth.onAuthStateChange(() => { void refresh(); });
    return () => data.subscription.unsubscribe();
  }, [refresh]);
  useEffect(() => { void refresh(); }, [path, refresh]); // picks up sessions changed by server redirects

  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}
