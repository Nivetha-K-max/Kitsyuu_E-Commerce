import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { serverSupabase } from '@/lib/supabase/server';
import { safeNext } from '@/lib/auth/next';

/* Target of the confirmation email link. Handles both Supabase link styles (PKCE ?code= and ?token_hash=&type=),
   stores the session cookie, then sends the customer to their account. Invalid or expired links go to /login?reason=link. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams, sb = await serverSupabase();
  const next = safeNext(q.get('next'));
  const code = q.get('code'), tokenHash = q.get('token_hash'), type = q.get('type') as EmailOtpType | null;
  const { error } = code ? await sb.auth.exchangeCodeForSession(code)
    : tokenHash && type ? await sb.auth.verifyOtp({ token_hash: tokenHash, type })
    : { error: new Error('missing token') };
  const dest = request.nextUrl.clone();
  if (error) { dest.pathname = '/login'; dest.search = '?reason=link'; }
  else { dest.pathname = next; dest.search = next === '/account' ? '?confirmed=1' : ''; }
  return NextResponse.redirect(dest);
}
