/* Pure catalogue helpers shared by server and client components (ported from dist/store/store.js). */
import type { Catalogue, Category, Product } from './types';

export const MAX_QTY = 10;
export const pad = (n: number) => String(n).padStart(2, '0');
export const plural = (n: number, word: string) => `${pad(n)} ${word}${n === 1 ? '' : 's'}`;
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const formatMoney = (n: number) => money.format(n);
/* Site-relative paths (logo, placeholder) get a leading slash; absolute URLs (Supabase Storage images) pass through. */
export const asset = (path: string) => /^https?:\/\//.test(path) ? path : '/' + path.replace(/^\/+/, '');

export type Index = ReturnType<typeof indexCatalogue>;
export function indexCatalogue(c: Catalogue) {
  const byId = new Map(c.products.map(p => [p.id, p]));
  const cats = new Map(c.categories.map(x => [x.id, x]));
  const catLabel = (id: string) => cats.get(id)?.label || '';
  return {
    c, byId, cats, catLabel,
    bySlug: (key: string) => c.products.find(p => p.slug === key || p.id === key || p.sku.toLowerCase() === key.toLowerCase()),
    top: c.categories.filter(x => !x.parent),
    children: (id: string): Category[] => c.categories.filter(x => x.parent === id),
    inCategory: (id: string) => c.products.filter(p => p.category === id || p.subcategory === id),
    collection: (id: string) => {
      const col = c.collections.find(x => x.id === id);
      return col && { ...col, products: col.productIds.map(i => byId.get(i)).filter((p): p is Product => !!p) };
    },
    featured: () => c.products.filter(p => p.featured),
    categoryPath: (p: Product) => [catLabel(p.category), catLabel(p.subcategory)].filter(Boolean).join(' / ')
  };
}

export type ImageInfo = { src: string; width: number; height: number; alt: string; held: boolean; zoom: boolean; quality: string };
/* Held products (and any product without a primary image) have no photo; they render the coming-soon panel. */
export function imageOf(p: Product): ImageInfo {
  const m = p.media;
  if (m.status !== 'held' && m.primary?.src) {
    return { src: asset(m.primary.src), width: m.primary.width, height: m.primary.height, alt: m.primary.alt || p.name, held: false, zoom: m.primary.zoom === true, quality: m.primary.quality || m.status };
  }
  return { src: asset(m.placeholder || 'store/images/placeholder.svg'), width: 600, height: 800, alt: `${p.name}: product image unavailable`, held: true, zoom: false, quality: 'held' };
}
/* Primary image first, then any future official photos listed in media.gallery. */
export function imagesOf(p: Product): ImageInfo[] {
  const first = imageOf(p);
  if (first.held) return [first];
  const extra = (p.media.gallery || []).filter(g => g && g.src).map(g => ({ src: asset(g.src), width: g.width, height: g.height, alt: g.alt || p.name, held: false, zoom: g.zoom === true, quality: g.quality || 'official' }));
  return [first, ...extra];
}

/* Sorting only uses fields the catalogue already has. Ties keep catalogue order. */
export const SORTS = (base: string) => [
  { id: 'default', label: base }, { id: 'new', label: 'New arrivals first' }, { id: 'featured', label: 'Featured first' },
  { id: 'price-asc', label: 'Price: low to high' }, { id: 'price-desc', label: 'Price: high to low' }
];
export function sortList(idx: Index, list: Product[], sort: string): Product[] {
  const na = idx.collection('new-arrivals')?.productIds || [];
  const rank = (p: Product) => { const i = na.indexOf(p.id); return i < 0 ? Infinity : i; };
  const by: Record<string, (a: Product, b: Product) => number> = {
    new: (a, b) => rank(a) - rank(b), featured: (a, b) => Number(b.featured) - Number(a.featured),
    'price-asc': (a, b) => a.price - b.price, 'price-desc': (a, b) => b.price - a.price
  };
  const f = by[sort];
  return f ? list.map((p, i) => [p, i] as const).sort((x, y) => f(x[0], y[0]) || x[1] - y[1]).map(x => x[0]) : list;
}

/* Search: every term must match the start of a word in the name, SKU, category or subcategory. */
const norm = (s: string) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function searchProducts(idx: Index, q: string): Product[] {
  const terms = norm(q).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return idx.c.products.filter(p => {
    const hay = ' ' + norm([p.name, p.sku, p.sku.replace(/-/g, ''), idx.catLabel(p.category), idx.catLabel(p.subcategory)].join(' ')) + ' ';
    return terms.every(t => hay.includes(' ' + t));
  });
}

export const url = {
  home: '/store',
  shop: (q?: Record<string, string>) => '/shop' + (q && Object.keys(q).length ? '?' + new URLSearchParams(q) : ''),
  product: (p: Product) => '/product/' + encodeURIComponent(p.slug),
  cart: '/cart', wishlist: '/wishlist', checkout: '/checkout', confirmation: '/confirmation',
  search: (q?: string) => '/search' + (q ? '?' + new URLSearchParams({ q }) : '')
};
