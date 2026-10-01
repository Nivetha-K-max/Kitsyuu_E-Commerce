'use client';
/* Client state for the storefront: catalogue index, cart, wishlist and the toast.
   - Guests: the cart and wishlist live in this browser (localStorage), with the same keys, line format and rules as the
     static store (dist/store/store.js): same product + size merges, a different size is a new line, max 10 per line,
     every read re-checked against the catalogue. Nothing a guest stores here is trusted: checkout re-prices everything.
   - Signed-in customers (M7): the cart and wishlist are kept in the database. Changes go through server actions, which
     resolve prices and stock on the server; this state only shows what the server returned. On login the guest cart and
     wishlist are merged into the saved ones once, then cleared from this browser.
   - Client change request: while the cart has items it is re-synced every N minutes (Settings → Checkout → 'Cart refresh
     interval', 30 by default): a signed-in cart is re-loaded from the server (current prices, sale prices, stock); a guest
     cart is re-checked against a freshly loaded catalogue. Nothing is removed from the cart or reserved by a refresh. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Catalogue, CartLine, CustomerStore, Product, StoreCart, StoreResult } from '@/lib/types';
import { indexCatalogue, MAX_QTY, type Index } from '@/lib/catalogue-utils';
import { addToCartAction, mergeGuestStoreAction, removeCartLineAction, setCartQtyAction, setWishlistedAction } from '@/app/store-actions';
import { useAuth } from './AuthProvider';

export const KEYS = { cart: 'kitsyuu-cart-v1', wish: 'kitsyuu-wishlist-v1' };
const clampQty = (n: unknown) => Math.min(MAX_QTY, Math.max(1, Math.round(Number(n)) || 1));

function readList(key: string): unknown[] {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export type AddResult = { ok: boolean; merged: boolean; capped: boolean; qty: number; message?: string };
/** A cart line as shown; for a signed-in customer it carries the server's verdict on stock. */
export type ShownLine = CartLine & { available?: number; problem?: string | null };
type StoreState = {
  idx: Index;
  ready: boolean;
  /** 'customer' once the saved cart has loaded; 'guest' uses this browser's storage. */
  mode: 'guest' | 'customer';
  lines: ShownLine[];
  cartCount: number;
  subtotal: number;
  /** Totals as priced by the server (signed-in customers only). */
  serverCart: StoreCart | null;
  wishIds: string[];
  addToCart: (p: Product, size: string, qty: number, colour?: string | null) => Promise<AddResult>;
  setQty: (id: string, size: string, qty: number, colour?: string | null) => Promise<ShownLine | undefined>;
  removeLine: (id: string, size: string, colour?: string | null) => Promise<void>;
  toggleWish: (id: string) => Promise<boolean>;
  toast: (msg: string) => void;
};
const Ctx = createContext<StoreState | null>(null);
/* True once the calling component has mounted. Storage-backed values (counts, hearts) render their server value until then,
   so a component hydrating late (e.g. inside a Suspense boundary) never sees localStorage data during hydration. */
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}
export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore must be used inside <StoreProvider>');
  return v;
}

export default function StoreProvider({ catalogue, children, refreshMinutes: initialRefresh = 30 }: { catalogue: Catalogue; children: React.ReactNode; refreshMinutes?: number }) {
  const idx = useMemo(() => indexCatalogue(catalogue), [catalogue]);
  const auth = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [refreshMinutes, setRefreshMinutes] = useState(initialRefresh);
  const [syncTick, setSyncTick] = useState(0);
  /** 2026-10-01: the guest cart checked against the stock now (/api/cart/check): key id|colour|size → what can be bought. */
  const [guestStock, setGuestStock] = useState<Map<string, { available: number; message: string | null }> | null>(null);
  const lastSync = useRef(Date.now());
  const [rawCart, setRawCart] = useState<unknown[]>([]);
  const [rawWish, setRawWish] = useState<unknown[]>([]);
  const [saved, setSaved] = useState<CustomerStore | null>(null);
  /** Loading the saved cart: 'failed' falls back to this browser's cart (and says so) instead of loading forever. */
  const [savedStatus, setSavedStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const savedStatusRef = useRef<string>('idle');
  const [localReady, setLocalReady] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toast = useCallback((msg: string) => {
    setToastMsg('');
    requestAnimationFrame(() => setToastMsg(msg));
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 4200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  /** The last saved cart received, as text: an identical reload (each navigation) changes nothing and re-renders nothing. */
  const savedJson = useRef('');

  useEffect(() => {
    const load = () => { setRawCart(readList(KEYS.cart)); setRawWish(readList(KEYS.wish)); };
    load(); setLocalReady(true);
    const onStorage = (e: StorageEvent) => { if (e.key === KEYS.cart || e.key === KEYS.wish || e.key === null) load(); };
    addEventListener('storage', onStorage);
    try { if (localStorage.getItem('kietsu-reduce-motion') === 'true') document.documentElement.classList.add('st-reduce'); } catch {}
    return () => removeEventListener('storage', onStorage);
  }, []);

  const write = useCallback((key: string, list: unknown[]) => {
    try { localStorage.setItem(key, JSON.stringify(list)); return true; }
    catch { toast('This browser blocked saving, so the change may not survive a refresh.'); return false; }
  }, [toast]);

  /* Signed in → load the saved cart and wishlist, merging this browser's guest lists into them once. Reloaded on each
     navigation, so changes made on the server (an order paid, another tab) show up. */
  useEffect(() => {
    if (auth.status !== 'user') { setSaved(null); setSavedStatus('idle'); savedStatusRef.current = 'idle'; return; }
    let live = true;
    setSavedStatus(s => (s === 'ready' ? s : 'loading'));
    (async () => {
      const guestCart = readList(KEYS.cart), guestWish = readList(KEYS.wish);
      let store: CustomerStore | null = null;
      if (guestCart.length || guestWish.length) {
        const r = await mergeGuestStoreAction({ cart: guestCart, wishlist: guestWish }).catch(() => null);
        if (r?.ok && r.store) { write(KEYS.cart, []); write(KEYS.wish, []); setRawCart([]); setRawWish([]); store = r.store; }
      }
      if (!store) {
        const res = await fetch('/api/store', { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
        const body = res?.ok ? await res.json() as { status: string; refreshMinutes?: number } & Partial<CustomerStore> : null;
        if (body?.status === 'customer' && body.cart) store = { cart: body.cart, wishlist: body.wishlist ?? [] };
        if (typeof body?.refreshMinutes === 'number' && live) setRefreshMinutes(body.refreshMinutes);
      }
      if (!live) return;
      if (!store && savedStatusRef.current === 'ready') return;          // a reload failed: keep showing the last saved state
      const json = JSON.stringify(store);
      if (json !== savedJson.current) { savedJson.current = json; setSaved(store); }
      setSavedStatus(store ? 'ready' : 'failed');
      if (!store && savedStatusRef.current !== 'failed') toast('Your saved cart could not be loaded right now. Items you add are kept in this browser for now.');
      savedStatusRef.current = store ? 'ready' : 'failed';
      lastSync.current = Date.now();
    })();
    return () => { live = false; };
  }, [auth.status, path, write, toast, syncTick]);

  useEffect(() => setRefreshMinutes(initialRefresh), [initialRefresh]);   // the interval comes with the page (no extra request)

  const mode: 'guest' | 'customer' = saved ? 'customer' : 'guest';
  const hasItems = (saved ? saved.cart.lines.length : rawCart.length) > 0;
  /* Client change request: re-sync a cart with items every refreshMinutes (checked each minute, and when the tab is shown
     again, because browsers slow timers in background tabs). */
  useEffect(() => {
    if (!hasItems) return;
    lastSync.current = Date.now();          // the interval runs from when the cart has items
    const due = () => {
      if (Date.now() - lastSync.current < refreshMinutes * 60_000) return;
      lastSync.current = Date.now();
      if (auth.status === 'user') setSyncTick(t => t + 1); else { router.refresh(); setSyncTick(t => t + 1); }
    };
    const timer = setInterval(due, 60_000);
    const onShow = () => { if (document.visibilityState === 'visible') due(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onShow); };
  }, [hasItems, refreshMinutes, auth.status, router]);
  const ready = localReady && (auth.status === 'guest' || savedStatus === 'ready' || savedStatus === 'failed');
  const apply = useCallback((r: StoreResult) => { if (r.store) setSaved(r.store); if (!r.ok && r.message) toast(r.message); return r; }, [toast]);

  const lineFor = useCallback((p: Product, size: string, qty: unknown, colour?: string | null): CartLine =>
    ({ id: p.id, sku: p.sku, name: p.name, image: p.media?.primary?.src || null, price: p.price, size, qty: clampQty(qty),
      colour: colour ?? null, colourLabel: colour ? p.colours?.find(c => c.slug === colour)?.label ?? colour : null }), []);
  /** Same line: product, colour (third pass) and size. */
  const same = (l: { id: string; size: string; colour?: string | null }, id: string, size: string, colour?: string | null) => l.id === id && l.size === size && (l.colour ?? null) === (colour ?? null);

  /* Guest lines: unknown products or sizes are dropped; name, SKU, image and price always come from the catalogue. A size
     that sold out stays in the cart with a message (2026-10-01; it used to disappear silently), and the stock check below
     says when fewer are left than the cart holds. */
  const guestRaw = useMemo(() => rawCart
    .filter((l): l is { id: string; size: string; qty: unknown; colour?: string | null } => !!l && typeof (l as CartLine).id === 'string')
    .filter(l => idx.byId.get(l.id)?.variants.some(v => v.size === l.size && (v.colour ?? null) === (l.colour ?? null))), [rawCart, idx]);
  const guestLines = useMemo<ShownLine[]>(() => guestRaw.map(l => {
    const line: ShownLine = lineFor(idx.byId.get(l.id)!, l.size, l.qty, l.colour);
    const live = guestStock?.get(`${l.id}|${l.colour ?? ''}|${l.size}`);
    const listed = idx.byId.get(l.id)!.variants.some(v => v.size === l.size && (v.colour ?? null) === (l.colour ?? null) && v.available);
    if (live) { line.available = live.available; line.problem = live.message; }
    else if (!listed) { line.available = 0; line.problem = `${line.name}, ${line.colourLabel ? `${line.colourLabel}, ` : ''}size ${line.size}, is sold out.`; }
    return line;
  }), [guestRaw, idx, lineFor, guestStock]);
  /* Guest stock check: on the pages that show the cart lines (cart, checkout), after the cart changes, every refresh interval
     (syncTick) and when the tab is shown again. Nothing is reserved; checkout checks again on the server. A failed check keeps
     the catalogue's view. Not run on product pages, so it never re-renders the buy form while someone is choosing. */
  const showsCart = path === '/cart' || path.startsWith('/checkout');
  const guestKey = guestRaw.map(l => `${l.id}|${l.colour ?? ''}|${l.size}|${String(l.qty)}`).join(',');
  useEffect(() => {
    if (saved || !localReady || !guestRaw.length || !showsCart) { setGuestStock(null); return; }
    // Performance (2026-10-01): quantity taps in quick succession send one check (after 350 ms), and a check overtaken
    // by a newer one is aborted.
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/cart/check', { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: ctl.signal,
        body: JSON.stringify({ lines: guestRaw.map(l => ({ productId: l.id, size: l.size, colour: l.colour ?? null, qty: clampQty(l.qty) })) }) })
        .then(r => (r.ok ? r.json() : null)).then((j: { lines?: { productId: string; size: string; colour: string | null; available: number; message: string | null }[] | null } | null) => {
          if (ctl.signal.aborted || !j?.lines) return;
          setGuestStock(new Map(j.lines.map(x => [`${x.productId}|${x.colour ?? ''}|${x.size}`, { available: x.available, message: x.message }])));
        }).catch(() => {});
    }, 350);
    return () => { clearTimeout(timer); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, localReady, guestKey, syncTick, showsCart]);
  const savedLines = useMemo<ShownLine[]>(() => (saved?.cart.lines ?? []).map(l => ({
    id: l.id, sku: l.sku, name: l.name, size: l.size, colour: l.colour ?? null, colourLabel: l.colourLabel ?? null, qty: l.qty, price: l.price, available: l.available, problem: l.problem,
    image: idx.byId.get(l.id)?.media?.primary?.src || null,
  })), [saved, idx]);
  const lines: ShownLine[] = saved ? savedLines : guestLines;
  const wishIds = useMemo(() => saved ? saved.wishlist.filter(id => idx.byId.has(id))
    : [...new Set(rawWish.filter((x): x is string => typeof x === 'string'))].filter(id => idx.byId.has(id)), [saved, rawWish, idx]);

  const saveGuestCart = useCallback((next: CartLine[]) => { const ok = write(KEYS.cart, next); setRawCart(next); return ok; }, [write]);

  const addToCart = useCallback(async (p: Product, size: string, qty: number, colour?: string | null): Promise<AddResult> => {
    if (saved) {
      const before = saved.cart.lines.find(l => same(l, p.id, size, colour));
      const r = apply(await addToCartAction({ productId: p.id, size, qty: clampQty(qty), colour: colour ?? undefined }));
      return { ok: r.ok, merged: !!before, capped: !!r.capped, qty: r.qty ?? 0, message: r.message };
    }
    const next = guestLines.map(l => ({ ...l }));
    const hit = next.find(l => same(l, p.id, size, colour)), want = (hit ? hit.qty : 0) + clampQty(qty);
    if (hit) hit.qty = Math.min(MAX_QTY, want); else next.push(lineFor(p, size, qty, colour));
    return { ok: saveGuestCart(next), merged: !!hit, capped: want > MAX_QTY, qty: Math.min(MAX_QTY, want) };
  }, [saved, apply, guestLines, lineFor, saveGuestCart]);

  const setQty = useCallback(async (id: string, size: string, qty: number, colour?: string | null): Promise<ShownLine | undefined> => {
    if (saved) {
      const r = apply(await setCartQtyAction({ productId: id, size, qty: clampQty(qty), colour: colour ?? undefined }));
      const l = r.store?.cart.lines.find(x => same(x, id, size, colour));
      return l && r.ok ? { ...l, image: null } : undefined;
    }
    const next = guestLines.map(l => ({ ...l })), l = next.find(x => same(x, id, size, colour));
    if (l) { l.qty = clampQty(qty); saveGuestCart(next); }
    return l;
  }, [saved, apply, guestLines, saveGuestCart]);

  const removeLine = useCallback(async (id: string, size: string, colour?: string | null) => {
    if (saved) { apply(await removeCartLineAction({ productId: id, size, colour: colour ?? undefined })); return; }
    saveGuestCart(guestLines.filter(l => !same(l, id, size, colour)));
  }, [saved, apply, guestLines, saveGuestCart]);

  const toggleWish = useCallback(async (id: string) => {
    const on = !wishIds.includes(id);
    if (saved) {
      setSaved(s => s && { ...s, wishlist: on ? [...s.wishlist, id] : s.wishlist.filter(x => x !== id) });   // shown at once
      const r = apply(await setWishlistedAction({ productId: id }, on));
      return r.ok ? on : !on;
    }
    const next = on ? [...wishIds, id] : wishIds.filter(x => x !== id);
    write(KEYS.wish, next); setRawWish(next); return on;
  }, [saved, wishIds, apply, write]);

  /* Performance (2026-10-01): one value object per real change. A toast, a timer tick or an unchanged reload re-renders
     the provider only, not every component that reads the store (header, each wishlist heart, grids, cart). */
  const value = useMemo<StoreState>(() => ({
    idx, ready, mode, lines, wishIds, toast, addToCart, setQty, removeLine, toggleWish,
    serverCart: saved?.cart ?? null,
    cartCount: lines.reduce((n, l) => n + l.qty, 0),
    subtotal: saved ? saved.cart.totals.subtotal : lines.reduce((s, l) => s + l.price * l.qty, 0),
  }), [idx, ready, mode, lines, wishIds, toast, addToCart, setQty, removeLine, toggleWish, saved]);
  return <Ctx.Provider value={value}>{children}<p className="st-toast" role="status" aria-live="polite">{toastMsg}</p></Ctx.Provider>;
}
