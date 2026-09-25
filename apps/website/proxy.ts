import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/* Next 16 Proxy (formerly middleware), limited to the account/admin routes so catalogue pages stay static and fast.
   1. Refreshes the Supabase session cookies (the @supabase/ssr pattern).
   2. Optimistic check only: signed-out visitors are redirected to /login before rendering.
   The authoritative checks (user + role) run in the pages via lib/auth/dal.ts. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: list => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    const hadSession = request.cookies.getAll().some(c => /^sb-.+-auth-token/.test(c.name));
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}${hadSession ? '&reason=session' : ''}`;
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach(c => redirect.cookies.set(c)); // keep any cookie clean-up from the refresh
    return redirect;
  }
  return response;
}

export const config = { matcher: ['/account/:path*', '/admin/:path*'] };
