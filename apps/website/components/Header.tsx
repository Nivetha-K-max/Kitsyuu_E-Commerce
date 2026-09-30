'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { asset, formatMoney, imageOf, url, type Index } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { useHydrated, useStore } from './StoreProvider';
import { useAuth } from './AuthProvider';
import { Icons } from './icons';

type Active = { key?: string; exact?: boolean; sub?: string | null; tool?: string };

export function navItems(idx: Index) {
  const items = idx.c.navigation.map(n => n.all ? { key: 'all', label: 'Shop', href: url.shop(), children: [] as { id: string; label: string }[] }
    : n.collection ? { key: 'col:' + n.collection, label: n.label, href: url.shop({ collection: n.collection }), children: [] }
    : { key: 'cat:' + n.category, label: n.label, href: url.shop({ category: n.category! }), children: idx.children(n.category!) });
  const home = { key: 'home', label: 'Home', href: url.home, children: [] as { id: string; label: string }[] };
  return [home, ...items.filter(i => i.key === 'all'), ...items.filter(i => i.key !== 'all')];
}

function useActive(idx: Index): Active {
  const path = usePathname(), q = useSearchParams();
  if (path === '/') return { key: 'home', exact: true };
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
  const tool = ({ '/cart': 'cart', '/wishlist': 'wishlist', '/search': 'search', '/account': 'account', '/login': 'account', '/signup': 'account' } as Record<string, string>)[path];
  return tool ? { tool } : {};
}

/* Desktop mega-menus (hover or keyboard focus), one per header item: link columns on the left, one row of photo
   tiles on the right. Compact by design. SHOP: new arrivals + every category, tiles = subcategories. NEW ARRIVALS: the new
   pieces. TOPS / BOTTOMS / OUTERWEAR: that category's subcategories, tiles = its pieces. Phones keep the full-screen menu. */
type MegaCol = { heading: string; links: { href: string; label: string }[] };
type MegaTile = { key: string; href: string; img: ReturnType<typeof imageOf>; label: string; note?: string };

function megaFor(idx: Index, key: string): { cols: MegaCol[]; tiles: MegaTile[] } | null {
  const shown = (list: Product[]) => list.filter(p => !imageOf(p).held);
  const productTile = (p: Product): MegaTile => ({ key: p.id, href: url.product(p), img: imageOf(p), label: p.name, note: formatMoney(p.price) });
  if (key === 'all') {
    const na = (idx.collection('new-arrivals')?.products ?? []).slice(0, 5);
    const cols: MegaCol[] = [
      ...(na.length ? [{ heading: 'New arrivals', links: na.map(p => ({ href: url.product(p), label: p.name })) }] : []),
      ...idx.top.map(c => ({ heading: c.label, links: [{ href: url.shop({ category: c.id }), label: 'Shop all' }, ...idx.children(c.id).map(sub => ({ href: url.shop({ category: sub.id }), label: sub.label }))] })),
    ];
    const tiles = idx.top.flatMap(c => idx.children(c.id)).map(sub => {
      const lead = shown(idx.inCategory(sub.id))[0];
      return lead ? { key: sub.id, href: url.shop({ category: sub.id }), img: imageOf(lead), label: sub.label } : null;
    }).filter((t): t is MegaTile => !!t).slice(0, 5);
    return { cols, tiles };
  }
  if (key.startsWith('col:')) {
    const col = idx.collection(key.slice(4));
    if (!col) return null;
    return {
      cols: [{ heading: col.label, links: [...col.products.slice(0, 6).map(p => ({ href: url.product(p), label: p.name })), { href: url.shop({ collection: col.id }), label: 'View all' }] }],
      tiles: shown(col.products).slice(0, 5).map(productTile),
    };
  }
  if (key.startsWith('cat:')) {
    const id = key.slice(4), cat = idx.cats.get(id);
    if (!cat) return null;
    return {
      cols: [{ heading: cat.label, links: [{ href: url.shop({ category: id }), label: `Shop all ${cat.label.toLowerCase()}` }, ...idx.children(id).map(sub => ({ href: url.shop({ category: sub.id }), label: sub.label }))] }],
      tiles: shown(idx.inCategory(id)).slice(0, 5).map(productTile),
    };
  }
  return null;
}

function MegaMenu({ label, data, onPick }: { label: string; data: { cols: MegaCol[]; tiles: MegaTile[] }; onPick: () => void }) {
  return (
    <div className="st-mega" aria-label={`${label} menu`} onClick={e => { if ((e.target as HTMLElement).closest('a')) onPick(); }}>
      <div className="st-mega-cols">
        {data.cols.map(c => (
          <div className="st-mega-col" key={c.heading}>
            <p className="st-mega-h">{c.heading}</p>
            <ul>{c.links.map(l => <li key={l.href + l.label}><Link href={l.href}>{l.label}</Link></li>)}</ul>
          </div>
        ))}
      </div>
      {data.tiles.length > 0 && (
        <ul className="st-mega-tiles">
          {data.tiles.map(t => (
            <li key={t.key}>
              <Link className="st-mega-tile" href={t.href}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <span className="st-mega-img"><img src={t.img.src} alt="" width={t.img.width} height={t.img.height} loading="lazy" decoding="async" /></span>
                <b>{t.label}</b>{t.note && <small>{t.note}</small>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* The one site header, on every page (the homepage included). */
export default function Header() {
  const store = useStore(), hydrated = useHydrated(), idx = store.idx;
  const cartCount = hydrated ? store.cartCount : 0, wishCount = hydrated ? store.wishIds.length : 0;
  /* Auth state is a UI hint only (the server decides access). Until it is known, the link says "Account". */
  const auth = useAuth(), signedIn = hydrated && auth.status === 'user';
  const accountHref = hydrated && auth.status === 'guest' ? '/login' : '/account', accountLabel = hydrated && auth.status === 'guest' ? 'Log in' : 'Account';
  const active = useActive(idx), path = usePathname();
  const [open, setOpen] = useState(false);
  const [megaOff, setMegaOff] = useState<string | null>(null);   // after a pick, that panel stays shut until the pointer leaves its item
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

  return (
    <header className="st-header" ref={header}>
      {/* A full page load (<a>), so leaving /our-story always unloads the landing's own script. */}
      <a className="st-brand" href={url.home} aria-label="KITSYUU home">
        <span className="logo-crop"><img src={asset('assets/kitsyuu-icon.svg')} alt="" width={1024} height={1024} /></span>
      </a>
      <nav className={`st-nav${open ? ' is-open' : ''}`} id="st-nav" aria-label="Store" ref={nav} onClick={e => { if ((e.target as HTMLElement).closest('a')) setOpen(false); }}>
        <ul className="st-nav-main">
          {navItems(idx).map(i => {
            const on = active.key === i.key, mega = megaFor(idx, i.key);
            return (
              <li key={i.key} className={mega ? `has-mega${megaOff === i.key ? ' is-off' : ''}` : undefined}
                onMouseLeave={mega ? () => setMegaOff(null) : undefined}>
                <Link href={i.href} {...(on ? (active.exact ? { 'aria-current': 'page' as const } : { className: 'is-active' }) : {})}>{i.label}</Link>
                {mega && <MegaMenu label={i.label} data={mega} onPick={() => setMegaOff(i.key)} />}
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
          <li><a href="/our-story">Our story</a></li>
        </ul>
      </nav>
      <div className="st-tools">
        <Link className="st-tool" href={url.search()} {...cur('search')}>{Icons.search}<span className="st-tool-label">Search</span></Link>
        <Link className="st-tool st-tool-wish" href={url.wishlist} {...cur('wishlist')}>{Icons.heart}<span className="st-tool-label">Wishlist</span> <span className="st-count-badge">(<span data-badge="wish">{wishCount}</span>)<span className="sr-only"> saved</span></span></Link>
        <Link className="st-tool" href={url.cart} {...cur('cart')}>{Icons.bag}<span className="st-tool-label">Cart</span> <span className="st-count-badge">(<span data-badge="cart">{cartCount}</span>)<span className="sr-only"> items</span></span></Link>
        <Link className="st-tool st-tool-account" href={accountHref} data-auth={signedIn ? 'customer' : hydrated && auth.status === 'guest' ? 'guest' : 'unknown'} {...cur('account')}>{Icons.user}<span className="st-tool-label">{accountLabel}</span></Link>
        <button className="st-tool st-menu-toggle" type="button" aria-expanded={open} aria-controls="st-nav" ref={toggle} onClick={() => setOpen(o => !o)}>{Icons.menu}<span className="st-menu-label">{open ? 'Close' : 'Menu'}</span></button>
      </div>
    </header>
  );
}
