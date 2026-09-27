import { NextResponse, type NextRequest } from 'next/server';

/* Supabase confirmation links sent before M6 pointed here. Accounts now confirm through /verify-email; an old link sends
   the customer to log in, where an unconfirmed account automatically receives a new confirmation link. */
export function GET(request: NextRequest) {
  const dest = request.nextUrl.clone();
  dest.pathname = '/login'; dest.search = '?reason=link';
  return NextResponse.redirect(dest, 303);
}
