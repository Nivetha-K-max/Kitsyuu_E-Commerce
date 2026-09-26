import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/dal';
import { LoginForm } from '@/components/AuthForms';
import { safeNext } from '@/lib/auth/next';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Log in', robots: { index: false } };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const q = await searchParams, next = one(q.next);
  if (await getCurrentUser()) redirect(safeNext(next));
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Store', href: '/store' }, { label: 'Log in' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Log in</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>Log in to check out and see your account. You can browse and fill your cart without an account.</p></div>
      </header>
      <LoginForm next={next || undefined} reason={one(q.reason) || undefined} />
    </div>
  );
}
