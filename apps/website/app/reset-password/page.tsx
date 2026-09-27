import type { Metadata } from 'next';
import Link from 'next/link';
import { oneTimeToken } from '@kitsyuu/contracts';
import { ResetPasswordForm } from '@/components/AuthForms';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Choose a new password', robots: { index: false }, referrer: 'no-referrer' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ResetPasswordPage({ searchParams }: { searchParams: SP }) {
  const t = (await searchParams).token;
  const token = Array.isArray(t) ? t[0] : t;
  const valid = oneTimeToken.safeParse(token).success;
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Log in', href: '/login' }, { label: 'New password' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Choose a new password</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>After this, you will be signed out on every device and can log in with the new password.</p></div>
      </header>
      {valid ? <ResetPasswordForm token={token!} /> : (
        <div className="st-auth-form"><div className="st-form-alert" role="alert">This reset link is not valid. <Link href="/forgot-password">Request a new one</Link>.</div></div>
      )}
    </div>
  );
}
