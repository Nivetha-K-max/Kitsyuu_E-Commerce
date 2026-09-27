import { NextResponse, type NextRequest } from 'next/server';

/* Next 16 Proxy (formerly middleware), limited to the account pages so catalogue pages stay static and fast.
   Optimistic check only: a visitor without a customer session cookie is sent to /login (and brought back afterwards).
   The authoritative check (a valid, unexpired, unrevoked session of an active account) runs in every account page and
   action on the server (lib/server.ts requireCustomer). */
const SESSION_COOKIE = '__Host-kitsyuu_customer';

export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/account/:path*'] };
