import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/dal';
import { LogoutButton } from '@/components/AuthForms';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Account', robots: { index: false } };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AccountPage({ searchParams }: { searchParams: SP }) {
  const profile = await requireUser('/account');
  const confirmed = (await searchParams).confirmed === '1';
  const since = new Date(profile.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const role = profile.role === 'admin' ? 'Admin' : 'Customer';
  return (
    <div className="st-wrap st-auth st-account">
      <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Account' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Account</h1>
        <div className="st-plp-aside"><p className="st-result-count" data-role={profile.role}>{role}</p><p>Signed in as {profile.email}.</p></div>
      </header>
      {confirmed && <div className="st-form-ok" role="status">Your email is confirmed. Welcome to KITSYUU.</div>}
      <section className="st-form-group" aria-labelledby="st-acc-details">
        <h2 id="st-acc-details">Details</h2>
        <dl className="st-account-dl">
          <dt>Name</dt><dd>{profile.fullName || 'Not set'}</dd>
          <dt>Email</dt><dd data-account-email="">{profile.email}</dd>
          <dt>Role</dt><dd data-account-role="">{role}</dd>
          <dt>Member since</dt><dd>{since}</dd>
        </dl>
      </section>
      {profile.role === 'admin' && (
        <section className="st-form-group" aria-labelledby="st-acc-admin">
          <h2 id="st-acc-admin">Admin</h2>
          <p>You have admin access to the KITSYUU store tools.</p>
          <Link className="text-link" href="/admin">Open admin <span aria-hidden="true">↗</span></Link>
        </section>
      )}
      <section className="st-form-group" aria-labelledby="st-acc-orders">
        <h2 id="st-acc-orders">Orders</h2>
        <p>Your orders will appear here once checkout is connected.</p>
      </section>
      <div className="st-account-actions"><LogoutButton /><Link className="text-link" href="/shop">Continue shopping <span aria-hidden="true">↗</span></Link></div>
    </div>
  );
}
