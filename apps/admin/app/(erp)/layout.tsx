import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import NavLinks from '@/components/NavLinks';
import { NAV } from '@/lib/nav';
import { requireActor } from '@/lib/server';
import { logoutAction } from '../(auth)/actions';

/* Every page below requires a valid staff session (checked against the database). Pages check their own permission. */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const items = NAV.filter(i => can(actor, i.permission)).map(({ href, label, group }) => ({ href, label, group }));
  return (
    <div className="shell">
      <aside className="side">
        <Link className="brand" href="/dashboard">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/kitsyuu-icon.svg" alt="" width={22} height={30} />
          <div><b>KITSYUU</b><small>Studio / ERP</small></div>
        </Link>
        <NavLinks items={items} />
        <section className="side-foot" aria-label="Account">
          <div className="nav-group" aria-hidden="true">Account</div>
          <p className="who" title={actor.email}>{actor.fullName || actor.email}</p>
          <Link href="/account" data-account>My account</Link>
          <form action={logoutAction}><button type="submit" className="btn link" data-logout>Sign out</button></form>
        </section>
      </aside>
      <main id="main" className="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
