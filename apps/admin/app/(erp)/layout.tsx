import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { Icon } from '@/components/icons';
import NavLinks from '@/components/NavLinks';
import Shell from '@/components/Shell';
import { NAV } from '@/lib/nav';
import { requireActor } from '@/lib/server';
import { logoutAction } from '../(auth)/actions';

/* Every page below requires a valid staff session (checked against the database). Pages check their own permission. */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const items = NAV.filter(i => can(actor, i.permission)).map(({ href, label, group }) => ({ href, label, group }));
  const sidebar = (
    <>
      <Link className="brand" href="/dashboard">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/kitsyuu-icon.svg" alt="" width={20} height={28} />
        <span><b>KITSYUU</b><small>Admin</small></span>
      </Link>
      <NavLinks items={items} />
      <section className="side-foot" aria-label="Account">
        <div className="nav-group" aria-hidden="true">Account</div>
        <Link href="/account" className="side-link" data-account><Icon name="account" /><span>My account</span></Link>
        <form action={logoutAction}><button type="submit" className="side-link" data-logout><Icon name="logout" /><span>Sign out</span></button></form>
      </section>
    </>
  );
  return <Shell items={items} user={{ name: actor.fullName, email: actor.email }} sidebar={sidebar}>{children}</Shell>;
}
