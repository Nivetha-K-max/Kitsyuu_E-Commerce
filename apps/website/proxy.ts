import { NextResponse, type NextRequest } from 'next/server';
import { storefrontCsp } from './lib/csp';

/* Next 16 Proxy (formerly middleware), limited to the account and checkout pages so catalogue pages stay static and fast.
   Checkout: only sets the Content-Security-Policy with the configured payment origins (M9).
   Account: optimistic check only: a visitor without a customer session cookie is sent to /login (and brought back afterwards).
   The authoritative check (a valid, unexpired, unrevoked session of an active account) runs in every account page and
   action on the server (lib/server.ts requireCustomer). */
const SESSION_COOKIE = '__Host-kitsyuu_customer';

export function proxy(request: NextRequest) {
  // Checkout: the Content-Security-Policy names the configured payment origins (lib/csp.ts). Access is checked by the pages.
  if (request.nextUrl.pathname === '/checkout' || request.nextUrl.pathname.startsWith('/checkout/')) {
    const res = NextResponse.next();
    res.headers.set('Content-Security-Policy', storefrontCsp({ dev: process.env.NODE_ENV !== 'production',
      payments: { checkoutScriptUrl: process.env.RAZORPAY_CHECKOUT_URL, apiBase: process.env.RAZORPAY_API_BASE } }));
    return res;
  }
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/account/:path*', '/checkout', '/checkout/:path*'] };
