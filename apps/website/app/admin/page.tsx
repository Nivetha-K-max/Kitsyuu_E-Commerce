import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/dal';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Admin', robots: { index: false } };

/* Authoritative server-side check on every request: guests are redirected to log in (also by proxy.ts),
   signed-in customers see "admin access only". Admin tools arrive in Phase 4.7. */
export default async function AdminPage() {
  const gate = await requireAdmin('/admin');
  if (gate.status === 'forbidden') {
    return (
      <div className="st-wrap">
        <section className="st-empty" data-admin-gate="forbidden">
          <p className="eyebrow"><span></span>ADMIN ACCESS ONLY</p>
          <h1>Not authorised.</h1>
          <p>This area is for KITSYUU store admins. You are signed in as {gate.profile.email}, which is a customer account.</p>
          <Link className="button" href="/account">Back to your account</Link>
        </section>
      </div>
    );
  }
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Store', href: '/store' }, { label: 'Admin' }]} />
      <header className="st-plp-head" data-admin-gate="admin">
        <h1 id="st-page-title">Admin</h1>
        <div className="st-plp-aside"><p className="st-result-count">Admin</p><p>Signed in as {gate.profile.email}.</p></div>
      </header>
      <section className="st-form-group"><h2>Store tools</h2><p>Admin tools for products, price and stock, and orders arrive in the next phase.</p></section>
    </div>
  );
}
