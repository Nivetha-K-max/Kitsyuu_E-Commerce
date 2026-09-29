'use client';
/* Signed-in frame: sidebar (collapsible to an icon rail; a drawer on small screens) + top bar (breadcrumbs, command
   menu, attention bell, theme, account) + page content. Navigation items and quick actions arrive already filtered by
   permission on the server; this component only handles layout, shortcuts and where you are. */
import * as Tooltip from '@radix-ui/react-tooltip';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import AttentionBell from './AttentionBell';
import CommandPalette, { type QuickAction } from './CommandPalette';
import { ConfirmProvider } from './confirm';
import { Icon } from './icons';
import NavLinks from './NavLinks';
import { GO_KEYS, typingInField, useSidebarCollapsed } from './shortcuts';
import ThemeToggle, { useThemePref } from './ThemeToggle';
import UserMenu from './UserMenu';

type Item = { href: string; label: string; group: string };

export default function Shell({ items, user, logout, actions, children }: {
  items: Item[]; user: { name: string; email: string }; logout: () => Promise<void>; actions: QuickAction[]; children: ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  const [theme] = useThemePref();
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // Global shortcuts: Ctrl/⌘ K or "/" opens the command menu, "[" collapses the sidebar, "G then key" jumps to a page.
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || typingInField(e) || document.querySelector('[role=dialog]')) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      if (e.key === '[') { toggleSidebar(); return; }
      if (e.key.toLowerCase() === 'g') { g = Date.now(); return; }
      if (Date.now() - g < 1200) {
        const target = items.find(i => GO_KEYS[i.href]?.toLowerCase() === e.key.toLowerCase());
        g = 0;
        if (target) { e.preventDefault(); router.push(target.href); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, router, toggleSidebar]);

  // Every list table: clicking anywhere on a row opens the row's main link (a.row-link), as the product table does.
  // Buttons, links, fields and menus inside the row keep their own behaviour; Ctrl/⌘-click opens a new tab.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('a,button,input,label,select,textarea,summary,details,form,[role=menuitem],[data-no-row-click]')) return;
      const row = t.closest('.main tbody tr');
      if (!row || row.closest('.dt') || window.getSelection()?.toString()) return;
      const link = row.querySelector<HTMLAnchorElement>('a.row-link');
      if (!link) return;
      if (e.metaKey || e.ctrlKey) window.open(link.href, '_blank', 'noopener'); else router.push(link.getAttribute('href')!);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [router]);

  const current = items.find(i => path === i.href || path.startsWith(i.href + '/'));
  const deeper = !!current && path !== current.href;
  const context = current ? (current.group === 'Overview' ? [] : [current.group]) : path.startsWith('/account') ? [] : [];

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
      <ConfirmProvider>
        <div className="shell" data-nav-open={open || undefined}>
          <aside className="side" id="sidebar" aria-label="Sidebar">
            <button type="button" className="icon-btn side-close" onClick={() => setOpen(false)} aria-label="Close menu"><Icon name="close" /></button>
            <div className="side-head">
              <Link className="brand" href="/dashboard" aria-label="KITSYUU Admin — dashboard">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <span className="brand-mark"><img src="/assets/kitsyuu-icon.svg" alt="" width={12} height={17} /></span>
                <span className="brand-text"><b>KITSYUU</b><small>Admin</small></span>
              </Link>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button type="button" className="icon-btn side-collapse" onClick={toggleSidebar} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed}>
                    <Icon name={collapsed ? 'panel-open' : 'panel-close'} />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal><Tooltip.Content className="tooltip" side="right" sideOffset={8}>{collapsed ? 'Expand' : 'Collapse'} sidebar <kbd>[</kbd></Tooltip.Content></Tooltip.Portal>
              </Tooltip.Root>
            </div>
            <NavLinks items={items} />
            <div className="side-foot">
              <UserMenu user={user} logout={logout} variant="side" onShortcuts={() => setPalette(true)} />
            </div>
          </aside>
          <div className="backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="content">
            <header className="topbar">
              <button ref={menuButton} type="button" className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-controls="sidebar" aria-expanded={open}>
                <Icon name="menu" />
              </button>
              <nav className="topbar-context" aria-label="You are here">
                {context.map(c => <span key={c}>{c}</span>)}
                {current && (deeper
                  ? <span><Link href={current.href} className="crumb-link">{current.label}</Link></span>
                  : <span aria-current="location">{current.label}</span>)}
                {!current && path.startsWith('/account') && <span aria-current="location">My account</span>}
              </nav>
              <div className="topbar-tools">
                <button type="button" className="cmd-trigger" onClick={() => setPalette(true)} aria-label="Open the command menu (Ctrl K)" data-command-trigger>
                  <Icon name="search" size={15} /><span>Search or jump to…</span><kbd>Ctrl</kbd><kbd>K</kbd>
                </button>
                <AttentionBell />
                <ThemeToggle />
                <UserMenu user={user} logout={logout} variant="avatar" onShortcuts={() => setPalette(true)} />
              </div>
            </header>
            <main id="main" className="main" tabIndex={-1}>{children}</main>
          </div>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} items={items} actions={actions} onToggleSidebar={toggleSidebar} />
        <Toaster theme={theme} position="bottom-right" closeButton richColors={false} />
      </ConfirmProvider>
    </Tooltip.Provider>
  );
}
