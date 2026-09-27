import { NextResponse } from 'next/server';
import { currentCustomer } from '@/lib/server';

/* Signed-in state for the store header (a UI hint only: account pages and actions check the session themselves).
   Catalogue pages stay statically generated because the header asks here from the browser instead of the layout reading
   the cookie. Returns no personal data beyond the first name, and is never cached. */
export const dynamic = 'force-dynamic';

export async function GET() {
  let body: { status: 'guest' } | { status: 'user'; firstName: string | null; emailVerified: boolean } = { status: 'guest' };
  try {
    const c = await currentCustomer();
    if (c) body = { status: 'user', firstName: c.fullName?.split(/\s+/)[0] || null, emailVerified: c.emailVerified };
  } catch (e) {
    console.error('[api/me]', e);                     // database unreachable: the header shows "Log in"; pages handle errors
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
