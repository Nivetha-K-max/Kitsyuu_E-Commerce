'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { asset, url, type Index } from '@/lib/catalogue-utils';
import { useHydrated, useStore } from './StoreProvider';
import { useAuth } from './AuthProvider';
import { Icons } from './icons';

type Active = { key?: string; exact?: boolean; sub?: string | null; tool?: string };

export function navItems(idx: Index) {
  const items = idx.c.navigation.map(n => n.all ? { key: 'all', label: 'Shop', href: url.shop(), children: [] as { id: string; label: string }[] }
    : n.collection ? { key: 'col:' + n.collection, label: n.label, href: url.shop({ collection: n.collection }), children: [] }
    : { key: 'cat:' + n.category, label: n.label, href: url.shop({ category: n.category! }), children: idx.children(n.category!) });
  return [...items.filter(i => i.key === 'all'), ...items.filter(i => i.key !== 'all')];
}

function useActive(idx: Index): Active {
  const path = usePathname(), q = useSearchParams();
  if (path === '/shop') {
    const col = q.get('collection'), cat = q.get('category') && idx.cats.get(q.get('category')!);
    if (col) return { key: 'col:' + col, exact: true };
    if (cat) return { key: 'cat:' + (cat.parent || cat.id), exact: !cat.parent, sub: cat.parent ? cat.id : null };
    return { key: 'all', exact: true };
  }
  if (path.startsWith('/product/')) {
    const p = idx.bySlug(decodeURIComponent(path.split('/')[2] || ''));
    return p ? { key: 'cat:' + p.category, exact: false, sub: p.subcategory } : {};
  }
  const tool = ({ '/cart': 'cart', '/wishlist': 'wishlist', '/search': 'search', '/account': 'account', '/login': 'account', '/signup': 'account', '/admin': 'admin' } as Record<string, string>)[path];
  return tool ? { tool } : {};
}

/* On the homepage the layout's header is not shown at the top: the page renders it (inline) where the store section
   begins, below the brand landing page, so the two headers never overlap. */
export default function Header({ inline = false }: { inline?: boolean } = {}) {
  const store = useStore(), hydrated = useHydrated(), idx = store.idx;
  const cartCount = hydrated ? store.cartCount : 0, wishCount = hydrated ? store.wishIds.length : 0;
  /* Auth state is a UI hint only (the server decides access). Until it is known, the link says "Account". */
  const auth = useAuth(), signedIn = hydrated && auth.status === 'user', isAdmin = signedIn && auth.role === 'admin';
  const accountHref = hydrated && auth.status === 'guest' ? '/login' : '/account', accountLabel = hydrated && auth.status === 'guest' ? 'Log in' : 'Account';
  const active = useActive(idx), path = usePathname();
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null), nav = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const cur = (tool: string) => active.tool === tool ? { 'aria-current': 'page' as const } : {};

  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const behind = [document.querySelector('main'), document.querySelector('.st-footer')].filter(Boolean) as HTMLElement[];
    behind.forEach(el => { el.inert = open; });
    document.documentElement.classList.toggle('st-menu-open', open);
    if (open) {
      document.documentElement.style.setProperty('--st-menu-top', header.current!.getBoundingClientRect().bottom + 'px');
      nav.current?.querySelector('a')?.focus();
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  useEffect(() => {
    const mq = matchMedia('(max-width: 900px)'), close = () => setOpen(false);
    mq.addEventListener('change', close); return () => mq.removeEventListener('change', close);
  }, []);

  if (!inline && path === '/') return null;
  return (
    <header className="st-header" ref={header}>
      {/* The homepage starts with the landing page's own script, so links to it are full page loads (<a>, not <Link>). */}
      <a className="st-brand" href={url.home} aria-label="KITSYUU home">
        <span className="logo-crop"><img src={asset('assets/kitsyuu-icon.svg')} alt="" width={1024} height={1024} /></span>
        <span className="st-wordmark" aria-hidden="true">KITSYUU</span>
      </a>
      <nav className={`st-nav${open ? ' is-open' : ''}`} id="st-nav" aria-label="Store" ref={nav} onClick={e => { if ((e.target as HTMLElement).closest('a')) setOpen(false); }}>
        <ul className="st-nav-main">
          {navItems(idx).map(i => {
            const on = active.key === i.key;
            return (
              <li key={i.key}>
                <Link href={i.href} {...(on ? (active.exact ? { 'aria-current': 'page' as const } : { className: 'is-active' }) : {})}>{i.label}</Link>
                {i.children.length > 0 && (
                  <ul className="st-nav-sub">
                    {i.children.map(c => <li key={c.id}><Link href={url.shop({ category: c.id })} {...(active.sub === c.id ? { 'aria-current': 'page' as const } : {})}>{c.label}</Link></li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <ul className="st-nav-extra">
          <li><Link href={url.wishlist} {...cur('wishlist')}>Wishlist (<span data-badge="wish">{wishCount}</span>)</Link></li>
          <li><Link href={accountHref} {...cur('account')}>{accountLabel}</Link></li>
          {isAdmin && <li><Link href="/admin" {...cur('admin')}>Admin</Link></li>}
          <li><a href="/#story">The KITSYUU story</a></li>
        </ul>
      </nav>
      <div className="st-tools">
        <Link className="st-tool" href={url.search()} {...cur('search')}>{Icons.search}<span className="st-tool-label">Search</span></Link>
        <Link className="st-tool st-tool-wish" href={url.wishlist} {...cur('wishlist')}>{Icons.heart}<span className="st-tool-label">Wishlist</span> <span className="st-count-badge">(<span data-badge="wish">{wishCount}</span>)<span className="sr-only"> saved</span></span></Link>
        <Link className="st-tool" href={url.cart} {...cur('cart')}>{Icons.bag}<span className="st-tool-label">Cart</span> <span className="st-count-badge">(<span data-badge="cart">{cartCount}</span>)<span className="sr-only"> items</span></span></Link>
        <Link className="st-tool st-tool-account" href={accountHref} data-auth={signedIn ? (isAdmin ? 'admin' : 'customer') : hydrated && auth.status === 'guest' ? 'guest' : 'unknown'} {...cur('account')}>{Icons.user}<span className="st-tool-label">{accountLabel}</span></Link>
        {isAdmin && <Link className="st-tool st-tool-admin" href="/admin" {...cur('admin')}><span className="st-tool-label-admin">Admin</span></Link>}
        <button className="st-tool st-menu-toggle" type="button" aria-expanded={open} aria-controls="st-nav" ref={toggle} onClick={() => setOpen(o => !o)}>{Icons.menu}<span className="st-menu-label">{open ? 'Close' : 'Menu'}</span></button>
      </div>
    </header>
  );
}
