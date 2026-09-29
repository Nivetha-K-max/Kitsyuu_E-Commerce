'use client';
/* Bell in the top bar: things that need someone (orders to ship, low stock, payment exceptions, reviews waiting,
   locked sign-ins). Counts come from /api/attention, which checks each permission; refreshed on every page change. */
import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './icons';

type Item = { key: string; label: string; count: number; href: string; icon: string };

export default function AttentionBell() {
  const path = usePathname();
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch('/api/attention', { signal: ctl.signal, cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { items: [] })).then(d => setItems(d.items ?? [])).catch(() => {});
    return () => ctl.abort();
  }, [path]);
  const total = items?.reduce((s, i) => s + i.count, 0) ?? 0;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="icon-btn" aria-label={total ? `Needs attention: ${total}` : 'Needs attention'} title="Needs attention" data-attention-bell>
        <Icon name="bell" />{total > 0 && <span className="bell-dot" aria-hidden="true" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="end" sideOffset={6} style={{ width: 300 }}>
          <div className="menu-label">Needs attention</div>
          {items === null ? <div className="attention-empty">Loading…</div>
            : items.length === 0 ? <div className="attention-empty">Nothing needs attention right now.</div>
            : <nav className="attention" aria-label="Needs attention">{items.map(i => (
                <Link key={i.key} href={i.href} onClick={() => setOpen(false)} data-attention={i.key}>
                  <Icon name={i.icon} />{i.label}<span className="attention-n">{i.count.toLocaleString('en-IN')}</span>
                </Link>))}
              </nav>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
