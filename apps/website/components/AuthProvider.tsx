'use client';
/* Signed-in state for the header. This is a UI hint only: access to /account is decided on the server (proxy.ts and
   lib/server.ts requireCustomer). It comes from /api/me so catalogue pages can stay statically generated. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';

type AuthState = { status: 'loading' | 'guest' | 'user'; firstName: string | null; refresh: () => Promise<void> };
const Ctx = createContext<AuthState>({ status: 'loading', firstName: null, refresh: async () => {} });
export const useAuth = () => useContext(Ctx);

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, 'refresh'>>({ status: 'loading', firstName: null });
  const path = usePathname();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
      const me = await r.json() as { status: 'guest' | 'user'; firstName?: string | null };
      const next = { status: me.status === 'user' ? 'user' as const : 'guest' as const, firstName: me.firstName ?? null };
      // Performance (2026-10-01): checked on every navigation, but the tree re-renders only when something changed.
      setState(s => (s.status === next.status && s.firstName === next.firstName ? s : next));
    } catch {
      setState(s => (s.status === 'guest' && s.firstName === null ? s : { status: 'guest', firstName: null }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [path, refresh]);   // picks up sign-in / sign-out done by server actions

  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
