import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/AuthForms';
import { safeNext } from '@/lib/auth/next';
import { isSignedIn } from '@/lib/auth/signed-in';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Create account', robots: { index: false } };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';

export default async function SignupPage({ searchParams }: { searchParams: SP }) {
  const next = one((await searchParams).next);
  if (await isSignedIn()) redirect(safeNext(next));
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Home', href: '/' }, { label: 'Create account' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Create account</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>We will email you a link to confirm your address before your first log-in.</p></div>
      </header>
      {/* Referrals (2026-10-12): a code carried in the link (?ref=) is sent with the form; the server decides whether it counts. */}
      <SignupForm next={next ? safeNext(next) : undefined} referral={/^[A-Za-z0-9]{6,12}$/.test(one((await searchParams).ref)) ? one((await searchParams).ref).toUpperCase() : undefined} />
    </div>
  );
}
