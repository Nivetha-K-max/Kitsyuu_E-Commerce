import { NextResponse, type NextRequest } from 'next/server';
import { oneTimeToken } from '@kitsyuu/contracts';
import { verifyCustomerEmail } from '@kitsyuu/auth';
import { db, requestContext, SESSION_COOKIE } from '@/lib/server';

/* Target of the confirmation email: confirms the address, signs the customer in and opens their account.
   Invalid, used or expired links go to /login?reason=link. The response is never cached and sends no referrer. */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const dest = request.nextUrl.clone();
  let session: { token: string; expiresAt: Date } | null = null;
  if (oneTimeToken.safeParse(token).success) {
    try {
      const r = await verifyCustomerEmail(db(), { token: token! }, await requestContext());
      if (r.ok) session = r;
    } catch (e) { console.error('[verify-email]', e); }
  }
  if (session) { dest.pathname = '/account'; dest.search = '?welcome=1'; }
  else { dest.pathname = '/login'; dest.search = '?reason=link'; }
  const res = NextResponse.redirect(dest, 303);
  if (session) res.cookies.set(SESSION_COOKIE, session.token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: session.expiresAt });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
