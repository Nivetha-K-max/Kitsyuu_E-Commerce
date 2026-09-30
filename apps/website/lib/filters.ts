/* Shop filters. Every facet reads a field the catalogue already has, so a filter can never show values that are not
   in the product data. Facets are generic ({id, label, values(p)}): attributes managed in the admin can be added as more
   facets later without changing the panel. State lives in the URL (?size=S,M&colour=black&min=2000&max=3000&stock=1). */
import type { Index } from './catalogue-utils';
import type { Product } from './types';

export type Facet = { id: string; label: string; values: (p: Product) => string[]; labelOf?: (v: string) => string; order?: (a: string, b: string) => number };
export type FilterState = { sel: Record<string, string[]>; min: number | null; max: number | null; stock: boolean };

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const sizeRank = (s: string) => { const i = SIZE_ORDER.indexOf(s.toUpperCase()); return i >= 0 ? i : 100 + (parseFloat(s) || 0); };
const titleCase = (s: string) => s.replace(/\b[a-z]/g, c => c.toUpperCase());

/** "Washed Blue / Grey" → ["blue", "grey"]: each named colour, without shade words (light, dark, faded, washed). */
export const colourKeys = (p: Product) =>
  [...new Set(p.colour.label.split('/').map(c => c.trim().toLowerCase().replace(/^(light|dark|faded|washed)\s+/, '')).filter(Boolean))];

export const inStock = (p: Product) => p.variants.some(v => v.available);

export function facetsFor(idx: Index): Facet[] {
  // Colour: once the business sets up the Colour attribute (id "colour") in the admin, it is the one source for the colour
  // filter; until then the filter reads each product's colour name, as before.
  const colourAttribute = idx.c.attributes.some(a => a.id === 'colour');
  return [
    { id: 'type', label: 'Type', values: p => [p.subcategory || p.category], labelOf: v => idx.catLabel(v) || v },
    { id: 'size', label: 'Size', values: p => p.variants.map(v => v.size), order: (a, b) => sizeRank(a) - sizeRank(b) },
    ...(colourAttribute ? [] : [{ id: 'colour', label: 'Colour', values: colourKeys, labelOf: titleCase }]),
    // Customer rating (M12): a product rated 4.3 matches "4★ & up", "3★ & up"… so choosing one keeps that rating or better.
    { id: 'rating', label: 'Customer rating', values: p => p.rating ? [4, 3, 2, 1].filter(n => p.rating!.average >= n).map(String) : [],
      labelOf: v => `${v}★ & up`, order: (a, b) => Number(b) - Number(a) },
    // Admin-managed attributes (Fabric, Sleeve length, Occasion, …), in the order set in the admin.
    ...idx.c.attributes.map((a): Facet => {
      const pos = new Map(a.values.map((v, i) => [v.slug, i])), label = new Map(a.values.map(v => [v.slug, v.label]));
      // Only values still offered (a deactivated value stays on the product but is not a filter option).
      return { id: a.id, label: a.label, values: p => (p.attrs[a.id] ?? []).filter(v => pos.has(v)), labelOf: v => label.get(v) ?? v, order: (x, y) => (pos.get(x) ?? 999) - (pos.get(y) ?? 999) };
    })
  ];
}

export const EMPTY: FilterState = { sel: {}, min: null, max: null, stock: false };

export function parseFilters(q: URLSearchParams, facets: Facet[]): FilterState {
  const sel: Record<string, string[]> = {};
  for (const f of facets) { const v = q.get(f.id); if (v) sel[f.id] = v.split(',').filter(Boolean); }
  const num = (k: string) => { const n = parseInt(q.get(k) || '', 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  return { sel, min: num('min'), max: num('max'), stock: q.get('stock') === '1' };
}

/** Writes the filter state into a copy of the query string (other params such as sort/category are kept). */
export function writeFilters(q: URLSearchParams, s: FilterState, facets: Facet[]): URLSearchParams {
  const out = new URLSearchParams(q);
  for (const f of facets) { const v = s.sel[f.id]; if (v?.length) out.set(f.id, v.join(',')); else out.delete(f.id); }
  for (const [k, v] of [['min', s.min], ['max', s.max]] as const) { if (v != null) out.set(k, String(v)); else out.delete(k); }
  if (s.stock) out.set('stock', '1'); else out.delete('stock');
  return out;
}

export const activeCount = (s: FilterState) => Object.values(s.sel).reduce((n, v) => n + v.length, 0) + (s.min != null || s.max != null ? 1 : 0) + (s.stock ? 1 : 0);

/** Products matching every filter; `skip` leaves one facet out (used for that facet's own counts). */
export function applyFilters(list: Product[], s: FilterState, facets: Facet[], skip?: string): Product[] {
  return list.filter(p => {
    for (const f of facets) {
      const want = s.sel[f.id];
      if (f.id === skip || !want?.length) continue;
      const have = f.values(p);
      if (!want.some(w => have.includes(w))) return false;
    }
    if (s.min != null && p.price < s.min) return false;
    if (s.max != null && p.price > s.max) return false;
    if (s.stock && !inStock(p)) return false;
    return true;
  });
}

/** The options a facet offers for this list, each with how many products it would show given the other filters. */
export function facetOptions(list: Product[], s: FilterState, facets: Facet[], f: Facet) {
  const all = new Set(list.flatMap(f.values));
  const counts = new Map<string, number>();
  for (const p of applyFilters(list, s, facets, f.id)) for (const v of new Set(f.values(p))) counts.set(v, (counts.get(v) || 0) + 1);
  const order = f.order ?? ((a: string, b: string) => (f.labelOf?.(a) ?? a).localeCompare(f.labelOf?.(b) ?? b));
  return [...all].sort(order).map(v => ({ value: v, label: f.labelOf?.(v) ?? v, count: counts.get(v) || 0 }));
}

/** Lowest and highest price in the list (for the price inputs' hints). */
export const priceRange = (list: Product[]) => list.length ? [Math.min(...list.map(p => p.price)), Math.max(...list.map(p => p.price))] as const : null;
