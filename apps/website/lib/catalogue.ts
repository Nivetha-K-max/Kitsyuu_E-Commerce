import 'server-only';
import { cache } from 'react';
import { publicSupabase } from './supabase/public';
import type { Attribute, Catalogue, Category, Collection, MediaImage, NavEntry, Product, SizeChartView } from './types';

/* Phase 4.3: the catalogue is read from Supabase (public key, RLS: active products only) and mapped onto the same
   Catalogue shape the storefront already renders, so no component changes. data/products.json stays in the repo only as
   the seed/reference source; it is NOT used as a fallback. A Supabase or network failure throws and shows the
   "catalogue unavailable" error page (app/error.tsx). */

const BUCKET = 'product-images';
const PLACEHOLDER = 'store/images/placeholder.svg';

type Row = {
  id: string; sku: string; slug: string; name: string; description: string; category_id: string; subcategory_id: string | null;
  price_paise: number; colour_label: string | null; colour_swatch: string | null; features: string[]; is_featured: boolean;
  catalogue_ref: string | null; material: string | null; care: string | null; origin: string | null;
  product_variants: { size: string; sort_order: number; stock_qty: number; is_active: boolean }[];
  product_images: { storage_path: string; width: number | null; height: number | null; alt: string; quality: string; zoom: boolean; is_primary: boolean; sort_order: number }[];
  product_relations: { related_id: string; kind: string; position: number }[];
};

const fail = (what: string, e: { message: string; code?: string } | null) => {
  if (e) throw new Error(`Catalogue unavailable: could not read ${what} from Supabase (${e.code ? e.code + ': ' : ''}${e.message})`);
};

/* One request's worth of catalogue reads; React cache() dedupes the calls from the layout and the page. */
export const getCatalogue = cache(async (): Promise<Catalogue> => {
  const sb = publicSupabase();
  const [cats, prods, cols] = await Promise.all([
    sb.from('categories').select('id, label, parent_id, sort_order').order('sort_order'),
    sb.from('products')
      .select(`id, sku, slug, name, description, category_id, subcategory_id, price_paise, colour_label, colour_swatch, features, is_featured,
        catalogue_ref, material, care, origin,
        product_variants (size, sort_order, stock_qty, is_active),
        product_images (storage_path, width, height, alt, quality, zoom, is_primary, sort_order),
        product_relations!product_relations_product_id_fkey (related_id, kind, position)`)
      .eq('status', 'active')
      .order('created_at').order('id'),
    sb.from('collections').select('*, collection_products (product_id, position)')
  ]);
  fail('categories', cats.error); fail('products', prods.error); fail('collections', cols.error);
  const [attr, seo, ratings, pricing, charts] = await Promise.all([readAttributes(sb), readSeo(sb), readRatings(sb), readPricing(sb), readSizeCharts(sb)]);

  const publicUrl = (path: string) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const toImage = (i: Row['product_images'][number], name: string): MediaImage =>
    ({ src: publicUrl(i.storage_path), width: i.width ?? 600, height: i.height ?? 800, alt: i.alt || name, quality: i.quality, zoom: i.zoom });

  const products: Product[] = (prods.data as unknown as Row[]).map(r => {
    const imgs = [...r.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order);
    const primary = imgs[0] ? toImage(imgs[0], r.name) : null;
    return {
      id: r.id, sku: r.sku, slug: r.slug, name: r.name, description: r.description,
      category: r.category_id, subcategory: r.subcategory_id ?? r.category_id,
      // Client change request: while a sale runs the price shown is the sale price, with the price as the "was" price.
      price: (pricing.get(r.id)?.effective ?? r.price_paise) / 100,
      colour: { label: r.colour_label ?? '', swatches: r.colour_swatch ? [r.colour_swatch] : [] },
      features: r.features ?? [],
      /* A size can be added to the cart when it is active and in stock. */
      variants: [...r.product_variants].sort((a, b) => a.sort_order - b.sort_order).map(v => ({ size: v.size, available: v.is_active && v.stock_qty > 0 })),
      featured: r.is_featured,
      styledWith: r.product_relations.filter(x => x.kind === 'styled_with').sort((a, b) => a.position - b.position).map(x => x.related_id),
      media: { status: primary ? (primary.quality === 'official' ? 'official' : 'prototype') : 'held', primary, placeholder: PLACEHOLDER, gallery: imgs.slice(1).map(i => toImage(i, r.name)) },
      catalogueRef: r.catalogue_ref, material: r.material, care: r.care, origin: r.origin,
      attrs: attr.byProduct.get(r.id) ?? {},
      seo: seo.get(r.id) ?? { title: null, description: null },
      rating: ratings.get(r.id) ?? null,
      compareAt: (() => { const x = pricing.get(r.id); const was = x?.was ?? null; return was && was > (x?.effective ?? r.price_paise) ? was / 100 : null; })(),
      sizeChart: charts.forProduct(r.id, r.category_id, r.subcategory_id)
    };
  });

  const categories: Category[] = (cats.data ?? []).map(c => ({ id: c.id, label: c.label, parent: c.parent_id }));
  // Menu order set in the admin (M11); rows from before migration 2200 have no sort_order and keep their order.
  const colRows = [...(cols.data ?? [])].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const collections: Collection[] = colRows.map(c => ({
    id: c.id, label: c.label, dataStatus: c.data_status, seoTitle: c.seo_title ?? null, seoDescription: c.seo_description ?? null,
    productIds: [...(c.collection_products as { product_id: string; position: number }[])].sort((a, b) => a.position - b.position).map(x => x.product_id)
  }));
  /* Menu order is unchanged from the static store: collections, top-level categories, then All Products. */
  const navigation: NavEntry[] = [
    ...collections.map(c => ({ label: c.label, collection: c.id })),
    ...categories.filter(c => !c.parent).map(c => ({ label: c.label, category: c.id })),
    { label: 'All Products', all: true }
  ];
  if (!products.length) throw new Error('Catalogue unavailable: Supabase returned no active products.');
  /* Prices are prototype INR estimates; tax inclusion is unconfirmed (null keeps the existing "unconfirmed" wording). */
  return { meta: { currency: 'INR', priceIncludesTax: null, images: { placeholder: PLACEHOLDER } }, categories, collections, navigation, products, attributes: attr.attributes };
});

/* Display prices set under Pricing: the sale price while a sale runs (client change request; the base price becomes the
   "was" price), else the compare-at price as the "was" price. Optional: before those migrations the columns do not exist,
   and on any error the base price is shown with no "was" price. Checkout always re-prices on the server. */
async function readPricing(sb: ReturnType<typeof publicSupabase>): Promise<Map<string, { effective: number; was: number | null }>> {
  const out = new Map<string, { effective: number; was: number | null }>();
  try {
    const r = await sb.from('products').select('id, price_paise, compare_at_paise, sale_price_paise, sale_starts_at, sale_ends_at').eq('status', 'active');
    if (r.error) {
      const c = await sb.from('products').select('id, price_paise, compare_at_paise').eq('status', 'active');
      for (const x of c.data ?? []) out.set(String(x.id), { effective: Number(x.price_paise), was: x.compare_at_paise === null ? null : Number(x.compare_at_paise) });
      return out;
    }
    const now = Date.now();
    for (const x of r.data ?? []) {
      const base = Number(x.price_paise);
      const running = x.sale_price_paise !== null && (!x.sale_starts_at || Date.parse(x.sale_starts_at) <= now) && (!x.sale_ends_at || Date.parse(x.sale_ends_at) > now);
      const effective = running ? Math.min(Number(x.sale_price_paise), base) : base;
      out.set(String(x.id), { effective, was: effective < base ? base : x.compare_at_paise === null ? null : Number(x.compare_at_paise) });
    }
  } catch { /* base price, no "was" price */ }
  return out;
}

/* Size charts (client change request): a product's own chart, else its subcategory's, else its category's. Only active
   charts are public. Optional: on any error no size chart is shown. */
async function readSizeCharts(sb: ReturnType<typeof publicSupabase>) {
  const none = { forProduct: (_p: string, _c: string, _s: string | null): SizeChartView | null => null };
  try {
    const [charts, prods, cats] = await Promise.all([
      sb.from('size_charts').select('id, name, unit, headers, rows, notes'),
      sb.from('products').select('id, size_chart_id').eq('status', 'active').not('size_chart_id', 'is', null),
      sb.from('categories').select('id, size_chart_id').not('size_chart_id', 'is', null),
    ]);
    if (charts.error || prods.error || cats.error) return none;
    const byId = new Map((charts.data ?? []).map(c => [String(c.id), { name: String(c.name), unit: String(c.unit), headers: (c.headers ?? []) as string[],
      rows: ((c.rows ?? []) as { size: string; values: string[] }[]), notes: c.notes ? String(c.notes) : null }]));
    const prodChart = new Map((prods.data ?? []).map(p => [String(p.id), String(p.size_chart_id)]));
    const catChart = new Map((cats.data ?? []).map(c => [String(c.id), String(c.size_chart_id)]));
    return { forProduct: (p: string, c: string, s: string | null): SizeChartView | null => {
      const id = prodChart.get(p) ?? (s ? catChart.get(s) : undefined) ?? catChart.get(c);
      return (id && byId.get(id)) || null;
    } };
  } catch { return none; }
}

/* Rating totals of approved reviews (M12), from the public view v_product_ratings (aggregates only). Optional: before
   migration 2300 the view does not exist and products simply have no rating. Any other error fails as usual. */
async function readRatings(sb: ReturnType<typeof publicSupabase>): Promise<Map<string, { average: number; count: number }>> {
  const r = await sb.from('v_product_ratings').select('product_id, average, count');
  if (r.error && ['42P01', 'PGRST205'].includes(r.error.code ?? '')) return new Map();
  fail('product ratings', r.error);
  return new Map((r.data ?? []).map(x => [x.product_id, { average: Number(x.average), count: Number(x.count) }]));
}

/* SEO text per product (M11). Optional: before migration 2200 the columns do not exist and every product uses its
   name and description. Any other error fails as usual. */
async function readSeo(sb: ReturnType<typeof publicSupabase>): Promise<Map<string, { title: string | null; description: string | null }>> {
  const r = await sb.from('products').select('id, seo_title, seo_description').eq('status', 'active');
  if (r.error && ['42703', 'PGRST204'].includes(r.error.code ?? '')) return new Map();
  fail('product SEO text', r.error);
  return new Map((r.data ?? []).map(p => [p.id, { title: p.seo_title, description: p.seo_description }]));
}

/* Store-filter attributes (admin-managed; RLS returns only active ones). Optional: if the attribute tables are not in the
   database yet (migration 1800 not applied), the store simply has no attribute filters; any other error fails as usual. */
async function readAttributes(sb: ReturnType<typeof publicSupabase>): Promise<{ attributes: Attribute[]; byProduct: Map<string, Record<string, string[]>> }> {
  const none = { attributes: [], byProduct: new Map() };
  const [attrs, tags] = await Promise.all([
    sb.from('attributes').select('id, label, sort_order, attribute_values (*)').order('sort_order').order('id'),
    sb.from('product_attribute_values').select('product_id, attribute_id, value_slug')
  ]);
  const missing = (e: { code?: string } | null) => !!e && ['42P01', 'PGRST205', 'PGRST200'].includes(e.code ?? '');
  if (missing(attrs.error) || missing(tags.error)) return none;
  fail('attributes', attrs.error); fail('product attributes', tags.error);
  type A = { id: string; label: string; attribute_values: { slug: string; label: string; sort_order: number; is_active?: boolean; swatch?: string | null }[] };
  // Deactivated values stay on their products but are not offered as filters (client change request: tags).
  const attributes = (attrs.data as unknown as A[]).map(a => ({
    id: a.id, label: a.label,
    values: a.attribute_values.filter(v => v.is_active !== false).sort((x, y) => x.sort_order - y.sort_order || x.slug.localeCompare(y.slug))
      .map(v => ({ slug: v.slug, label: v.label, swatch: v.swatch ?? null }))
  }));
  const byProduct = new Map<string, Record<string, string[]>>();
  for (const t of tags.data ?? []) {
    const m = byProduct.get(t.product_id) ?? {};
    (m[t.attribute_id] ??= []).push(t.value_slug);
    byProduct.set(t.product_id, m);
  }
  return { attributes, byProduct };
}

/* Only the fields the storefront renders are sent to the browser. */
export function toClientCatalogue(c: Catalogue): Catalogue {
  return c;
}
