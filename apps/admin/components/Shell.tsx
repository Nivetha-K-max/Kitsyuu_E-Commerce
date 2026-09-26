'use client';
/* Signed-in frame: sidebar (a drawer on small screens) + compact top bar + page content. Navigation items arrive already
   filtered by permission on the server; this component only handles the drawer and shows where you are. */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import ThemeToggle from './ThemeToggle';

type Item = { href: string; label: string; group: string };

export default function Shell({ items, user, sidebar, children }: {
  items: Item[]; user: { name: string; email: string }; sidebar: ReactNode; children: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const current = items.find(i => path === i.href || path.startsWith(i.href + '/'));
  const context = current ? (current.group === 'Overview' ? [current.label] : [current.group, current.label]) : path.startsWith('/account') ? ['Account'] : [];
  const initials = (user.name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('');

  return (
    <div className="shell" data-nav-open={open || undefined}>
      <aside className="side" id="sidebar" aria-label="Sidebar">
        <button type="button" className="icon-btn side-close" onClick={() => setOpen(false)} aria-label="Close menu"><Icon name="close" /></button>
        {sidebar}
      </aside>
      <div className="backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="topbar">
          <button ref={menuButton} type="button" className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-controls="sidebar" aria-expanded={open}>
            <Icon name="menu" />
          </button>
          <nav className="topbar-context" aria-label="You are here">
            {context.map((c, i) => <span key={c} aria-current={i === context.length - 1 ? 'location' : undefined}>{c}</span>)}
          </nav>
          <div className="topbar-tools">
            <ThemeToggle compact />
            <Link href="/account" className="user-chip" title={user.email}>
              <span className="avatar" aria-hidden="true">{initials}</span>
              <span className="user-name">{user.name || user.email}</span>
            </Link>
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
