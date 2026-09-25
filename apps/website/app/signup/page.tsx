import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/dal';
import { SignupForm } from '@/components/AuthForms';
import { safeNext } from '@/lib/auth/next';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Create account', robots: { index: false } };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';

export default async function SignupPage({ searchParams }: { searchParams: SP }) {
  const next = one((await searchParams).next);
  if (await getCurrentUser()) redirect(safeNext(next));
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Create account' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Create account</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>We will email you a link to confirm your address before your first log-in.</p></div>
      </header>
      <SignupForm next={next || undefined} />
    </div>
  );
}
