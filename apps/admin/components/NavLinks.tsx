'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { inModule, type NavItem } from '@/lib/nav';
import { GO_KEYS, useSidebarCollapsed } from './shortcuts';

/** Receives only the items the server already filtered by permission. In the collapsed rail each link shows its
    label (and shortcut) as a tooltip. */
export default function NavLinks({ items }: { items: NavItem[] }) {
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
            // a module is current on any of its views and record pages (lib/nav.ts)
            const current = inModule(path, item.match);
            const key = GO_KEYS[item.href];
            return (
              <Tooltip.Root key={item.id} open={collapsed ? undefined : false}>
                <Tooltip.Trigger asChild>
                  <Link href={item.href} aria-current={current ? 'page' : undefined} data-module={item.id}>
                    <Icon name={item.icon} />
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
