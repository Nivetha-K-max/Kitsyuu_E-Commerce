import type { Metadata } from 'next';
import Link from 'next/link';
import { checkCustomerVerificationLink } from '@kitsyuu/auth';
import { oneTimeToken } from '@kitsyuu/contracts';
import { VerifyEmailForm } from '@/components/AuthForms';
import { Crumbs } from '@/components/ui';
import { db } from '@/lib/server';

/* Target of the confirmation email (2026-10-14, sign-up takeover fix; was a route that confirmed on GET). Opening the link
   only shows this page: nothing is confirmed, used up or changed, so a mail scanner that opens every link does no harm.
   The owner of the inbox confirms by setting the account's password in the form (verifyEmailAction), which also ends every
   other session. Never indexed, never cached, sends no referrer. */
export const metadata: Metadata = { title: 'Confirm your account', robots: { index: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function VerifyEmailPage({ searchParams }: { searchParams: SP }) {
  const t = (await searchParams).token;
  const token = Array.isArray(t) ? t[0] : t;
  let valid = oneTimeToken.safeParse(token).success;
  if (valid) { try { valid = await checkCustomerVerificationLink(db(), { token: token! }); } catch (e) { console.error('[verify-email]', e); valid = false; } }
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Home', href: '/' }, { label: 'Log in', href: '/login' }, { label: 'Confirm account' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Confirm your account</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>Set your password to finish. You are then logged in here and signed out everywhere else.</p></div>
      </header>
      {valid ? <VerifyEmailForm token={token!} /> : (
        <div className="st-auth-form" data-verify-invalid><div className="st-form-alert" role="alert">This confirmation link is invalid, already used, or expired. <Link href="/forgot-password">Send yourself a new one</Link>.</div></div>
      )}
    </div>
  );
}
