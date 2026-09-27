'use client';
/* Signed-in state for the header. This is a UI hint only: access to /account is decided on the server (proxy.ts and
   lib/server.ts requireCustomer). It comes from /api/me so catalogue pages can stay statically generated. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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
      setState({ status: me.status === 'user' ? 'user' : 'guest', firstName: me.firstName ?? null });
    } catch {
      setState({ status: 'guest', firstName: null });
    }
  }, []);

  useEffect(() => { void refresh(); }, [path, refresh]);   // picks up sign-in / sign-out done by server actions

  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}
