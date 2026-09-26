import { NextResponse, type NextRequest } from 'next/server';

/* Fast redirect for visitors without a session cookie. This is NOT the security boundary: every page and server
   action validates the session and permissions against the database (lib/server.ts). */
const PUBLIC = ['/login', '/forgot-password', '/reset-password', '/accept-invite'];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next();
  if (request.cookies.has('__Host-kitsyuu_admin')) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/|assets/|media/|fonts\\.css|admin\\.css|favicon\\.ico|robots\\.txt).*)'],
};
