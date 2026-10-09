import { can } from '@kitsyuu/auth';
import Shell from '@/components/Shell';
import type { QuickAction } from '@/components/CommandPalette';
import { navFor, pagesFor } from '@/lib/nav';
import { requireActor } from '@/lib/server';
import { logoutAction } from '../(auth)/actions';

/* Every page below requires a valid staff session (checked against the database). Pages check their own permission. */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const items = navFor(p => can(actor, p));
  const pages = pagesFor(p => can(actor, p));
  // Command-menu shortcuts to pages that create something; each is shown only with the permission its page checks.
  const actions = ([
    can(actor, 'products.write') && { href: '/products/new', label: 'New product', icon: 'plus' },
    can(actor, 'inventory.adjust') && { href: '/inventory', label: 'Adjust stock', icon: 'inventory' },
    can(actor, 'inventory.count') && { href: '/stock-counts', label: 'Start a stock count', icon: 'counts' },
    can(actor, 'procurement.manage') && { href: '/purchase-orders', label: 'New purchase order', icon: 'purchase' },
    can(actor, 'staff.manage') && { href: '/staff/invite', label: 'Invite a staff member', icon: 'staff' },
  ].filter(Boolean)) as QuickAction[];
  return <Shell items={items} pages={pages} user={{ name: actor.fullName, email: actor.email }} logout={logoutAction} actions={actions}>{children}</Shell>;
}
