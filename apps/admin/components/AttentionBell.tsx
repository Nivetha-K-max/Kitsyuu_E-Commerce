'use client';
/* Bell in the top bar: things that need someone (orders to ship, low stock, payment exceptions, reviews waiting,
   locked sign-ins) and the latest unread notifications. Counts come from /api/attention, which checks each permission;
   refreshed on every page change. */
import * as Popover from '@radix-ui/react-popover';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './icons';

type Item = { key: string; label: string; count: number; href: string; icon: string };
type Note = { id: string; title: string; severity: 'info' | 'warning' | 'critical'; link: string | null; created_at: string };
type Unread = { count: number; latest: Note[] };

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

export default function AttentionBell() {
  const path = usePathname();
  const [items, setItems] = useState<Item[] | null>(null);
  const [unread, setUnread] = useState<Unread>({ count: 0, latest: [] });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch('/api/attention', { signal: ctl.signal, cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { items: [] })).then(d => { setItems(d.items ?? []); setUnread(d.unread ?? { count: 0, latest: [] }); }).catch(() => {});
    return () => ctl.abort();
  }, [path]);
  const total = (items?.reduce((s, i) => s + i.count, 0) ?? 0) + unread.count;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="icon-btn" aria-label={total ? `Needs attention: ${total}` : 'Needs attention'} title="Needs attention" data-attention-bell>
        <Icon name="bell" />{total > 0 && <span className="bell-dot" aria-hidden="true" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover" align="end" sideOffset={6} style={{ width: 320 }}>
          <div className="menu-label">Needs attention</div>
          {items === null ? <div className="attention-empty">Loading…</div>
            : items.length === 0 ? <div className="attention-empty">Nothing needs attention right now.</div>
            : <nav className="attention" aria-label="Needs attention">{items.map(i => (
                <Link key={i.key} href={i.href} onClick={() => setOpen(false)} data-attention={i.key}>
                  <Icon name={i.icon} />{i.label}<span className="attention-n">{i.count.toLocaleString('en-IN')}</span>
                </Link>))}
              </nav>}
          <div className="menu-label">Notifications{unread.count > 0 && ` · ${unread.count.toLocaleString('en-IN')} unread`}</div>
          {unread.latest.length === 0 ? <div className="attention-empty">No unread notifications.</div>
            : <nav className="attention" aria-label="Unread notifications" data-bell-notifications>{unread.latest.map(n => (
                <Link key={n.id} href={n.link ?? '/notifications'} onClick={() => setOpen(false)} data-notification={n.id} data-severity={n.severity}>
                  <Icon name={n.severity === 'critical' ? 'alert' : 'bell'} /><span className="attention-title">{n.title}</span><span className="attention-n">{ago(n.created_at)}</span>
                </Link>))}
              </nav>}
          <Link className="btn ghost sm attention-all" href="/notifications" onClick={() => setOpen(false)} data-bell-all>All notifications</Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
