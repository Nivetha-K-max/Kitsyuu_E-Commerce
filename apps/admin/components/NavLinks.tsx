'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { GO_KEYS, useSidebarCollapsed } from './shortcuts';

export const NAV_ICON: Record<string, string> = {
  '/dashboard': 'dashboard', '/reports': 'reports', '/products': 'products', '/categories': 'categories', '/collections': 'collections', '/attributes': 'attributes', '/inventory': 'inventory', '/stock-counts': 'counts', '/stock-value': 'value', '/locations': 'locations', '/transfers': 'transfers', '/drafts': 'drafts',
  '/orders': 'orders', '/customers': 'customers', '/payments': 'payments', '/reviews': 'reviews', '/content': 'content', '/vendors': 'vendors', '/materials': 'materials', '/purchase-orders': 'purchase', '/production': 'production', '/staff': 'staff', '/roles': 'roles', '/audit': 'audit',
  '/settings': 'settings', '/system': 'system',
  '/notifications': 'notifications', '/pricing': 'pricing', '/shipping': 'shipping', '/returns': 'returns', '/carts': 'carts', '/marketing': 'marketing',
  '/support': 'support', '/finance': 'finance', '/size-charts': 'sizecharts', '/loyalty': 'loyalty',
};

/** Receives only the items the server already filtered by permission. In the collapsed rail each link shows its
    label (and shortcut) as a tooltip. */
export default function NavLinks({ items }: { items: { href: string; label: string; group: string }[] }) {
  const path = usePathname();
  const [collapsed] = useSidebarCollapsed();
  const groups = items.reduce<{ name: string; items: typeof items }[]>((acc, item) => {
    const last = acc[acc.length - 1];
    if (last?.name === item.group) last.items.push(item); else acc.push({ name: item.group, items: [item] });
    return acc;
  }, []);
  return (
    <nav className="nav" aria-label="Admin">
      {groups.map(g => (
        <div className="nav-section" key={g.name}>
          {g.name !== 'Overview' && <div className="nav-group" aria-hidden="true">{g.name}</div>}
          {g.items.map(item => {
            const current = path === item.href || path.startsWith(item.href + '/');
            const key = GO_KEYS[item.href];
            return (
              <Tooltip.Root key={item.href} open={collapsed ? undefined : false}>
                <Tooltip.Trigger asChild>
                  <Link href={item.href} aria-current={current ? 'page' : undefined}>
                    <Icon name={NAV_ICON[item.href] ?? 'dashboard'} />
                    <span className="nav-label">{item.label}</span>
                    {/* drawn by CSS from data-key, so the hint is not part of the link text */}
                    {key && <span className="nav-keys" data-key={key} aria-hidden="true" />}
                  </Link>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip" side="right" sideOffset={10}>
                    {item.label}{key && <span><kbd>G</kbd> <kbd>{key}</kbd></span>}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
