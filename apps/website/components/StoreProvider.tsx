'use client';
/* Client state for the storefront: catalogue index, cart, wishlist and the toast.
   Same localStorage keys, line format and rules as the static store (dist/store/store.js):
   same product + size merges, a different size is a new line, max 10 per line, every read re-checked against the catalogue.
   Phase 4.5 swaps the storage for Supabase-backed cart/wishlist APIs for signed-in customers. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalogue, CartLine, Product } from '@/lib/types';
import { indexCatalogue, MAX_QTY, type Index } from '@/lib/catalogue-utils';

export const KEYS = { cart: 'kitsyuu-cart-v1', wish: 'kitsyuu-wishlist-v1', order: 'kitsyuu-prototype-order' };
const clampQty = (n: unknown) => Math.min(MAX_QTY, Math.max(1, Math.round(Number(n)) || 1));

function readList(key: string): unknown[] {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

type AddResult = { ok: boolean; merged: boolean; capped: boolean; qty: number };
type StoreState = {
  idx: Index;
  ready: boolean;
  lines: CartLine[];
  cartCount: number;
  subtotal: number;
  wishIds: string[];
  addToCart: (p: Product, size: string, qty: number) => AddResult;
  setQty: (id: string, size: string, qty: number) => CartLine | undefined;
  removeLine: (id: string, size: string) => void;
  clearCart: () => boolean;
  toggleWish: (id: string) => boolean;
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

export default function StoreProvider({ catalogue, children }: { catalogue: Catalogue; children: React.ReactNode }) {
  const idx = useMemo(() => indexCatalogue(catalogue), [catalogue]);
  const [rawCart, setRawCart] = useState<unknown[]>([]);
  const [rawWish, setRawWish] = useState<unknown[]>([]);
  const [ready, setReady] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toast = useCallback((msg: string) => {
    setToastMsg('');
    requestAnimationFrame(() => setToastMsg(msg));
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 4200);
  }, []);

  useEffect(() => {
    const load = () => { setRawCart(readList(KEYS.cart)); setRawWish(readList(KEYS.wish)); };
    load(); setReady(true);
    const onStorage = (e: StorageEvent) => { if (e.key === KEYS.cart || e.key === KEYS.wish || e.key === null) load(); };
    addEventListener('storage', onStorage);
    try { if (localStorage.getItem('kietsu-reduce-motion') === 'true') document.documentElement.classList.add('st-reduce'); } catch {}
    return () => removeEventListener('storage', onStorage);
  }, []);

  const lineFor = useCallback((p: Product, size: string, qty: unknown): CartLine =>
    ({ id: p.id, sku: p.sku, name: p.name, image: p.media?.primary?.src || null, price: p.price, size, qty: clampQty(qty) }), []);

  /* Unknown products or sizes are dropped; name, SKU, image and price always come from the catalogue. */
  const lines = useMemo(() => rawCart
    .filter((l): l is { id: string; size: string; qty: unknown } => !!l && typeof (l as CartLine).id === 'string')
    .filter(l => idx.byId.get(l.id)?.variants.some(v => v.size === l.size && v.available))
    .map(l => lineFor(idx.byId.get(l.id)!, l.size, l.qty)), [rawCart, idx, lineFor]);
  const wishIds = useMemo(() => [...new Set(rawWish.filter((x): x is string => typeof x === 'string'))].filter(id => idx.byId.has(id)), [rawWish, idx]);

  const write = useCallback((key: string, list: unknown[]) => {
    try { localStorage.setItem(key, JSON.stringify(list)); return true; }
    catch { toast('This browser blocked saving, so the change may not survive a refresh.'); return false; }
  }, [toast]);
  const saveCart = useCallback((next: CartLine[]) => { const ok = write(KEYS.cart, next); setRawCart(next); return ok; }, [write]);

  const addToCart = useCallback((p: Product, size: string, qty: number): AddResult => {
    const next = lines.map(l => ({ ...l }));
    const hit = next.find(l => l.id === p.id && l.size === size), want = (hit ? hit.qty : 0) + clampQty(qty);
    if (hit) hit.qty = Math.min(MAX_QTY, want); else next.push(lineFor(p, size, qty));
    return { ok: saveCart(next), merged: !!hit, capped: want > MAX_QTY, qty: Math.min(MAX_QTY, want) };
  }, [lines, lineFor, saveCart]);
  const setQty = useCallback((id: string, size: string, qty: number) => {
    const next = lines.map(l => ({ ...l })), l = next.find(x => x.id === id && x.size === size);
    if (l) { l.qty = clampQty(qty); saveCart(next); }
    return l;
  }, [lines, saveCart]);
  const removeLine = useCallback((id: string, size: string) => { saveCart(lines.filter(l => !(l.id === id && l.size === size))); }, [lines, saveCart]);
  const clearCart = useCallback(() => saveCart([]), [saveCart]);
  const toggleWish = useCallback((id: string) => {
    const on = !wishIds.includes(id), next = on ? [...wishIds, id] : wishIds.filter(x => x !== id);
    write(KEYS.wish, next); setRawWish(next); return on;
  }, [wishIds, write]);

  const value: StoreState = {
    idx, ready, lines, wishIds, toast, addToCart, setQty, removeLine, clearCart, toggleWish,
    cartCount: lines.reduce((n, l) => n + l.qty, 0), subtotal: lines.reduce((s, l) => s + l.price * l.qty, 0)
  };
  return <Ctx.Provider value={value}>{children}<p className="st-toast" role="status" aria-live="polite">{toastMsg}</p></Ctx.Provider>;
}
