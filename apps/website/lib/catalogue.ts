import 'server-only';
import { cache } from 'react';
import { publicSupabase } from './supabase/public';
import type { Catalogue, Category, Collection, MediaImage, NavEntry, Product } from './types';

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
    sb.from('collections').select('id, label, data_status, collection_products (product_id, position)')
  ]);
  fail('categories', cats.error); fail('products', prods.error); fail('collections', cols.error);

  const publicUrl = (path: string) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const toImage = (i: Row['product_images'][number], name: string): MediaImage =>
    ({ src: publicUrl(i.storage_path), width: i.width ?? 600, height: i.height ?? 800, alt: i.alt || name, quality: i.quality, zoom: i.zoom });

  const products: Product[] = (prods.data as unknown as Row[]).map(r => {
    const imgs = [...r.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order);
    const primary = imgs[0] ? toImage(imgs[0], r.name) : null;
    return {
      id: r.id, sku: r.sku, slug: r.slug, name: r.name, description: r.description,
      category: r.category_id, subcategory: r.subcategory_id ?? r.category_id,
      price: r.price_paise / 100,
      colour: { label: r.colour_label ?? '', swatches: r.colour_swatch ? [r.colour_swatch] : [] },
      features: r.features ?? [],
      /* A size can be added to the cart when it is active and in stock. */
      variants: [...r.product_variants].sort((a, b) => a.sort_order - b.sort_order).map(v => ({ size: v.size, available: v.is_active && v.stock_qty > 0 })),
      featured: r.is_featured,
      styledWith: r.product_relations.filter(x => x.kind === 'styled_with').sort((a, b) => a.position - b.position).map(x => x.related_id),
      media: { status: primary ? (primary.quality === 'official' ? 'official' : 'prototype') : 'held', primary, placeholder: PLACEHOLDER, gallery: imgs.slice(1).map(i => toImage(i, r.name)) },
      catalogueRef: r.catalogue_ref, material: r.material, care: r.care, origin: r.origin
    };
  });

  const categories: Category[] = (cats.data ?? []).map(c => ({ id: c.id, label: c.label, parent: c.parent_id }));
  const collections: Collection[] = (cols.data ?? []).map(c => ({
    id: c.id, label: c.label, dataStatus: c.data_status,
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
  return { meta: { currency: 'INR', priceIncludesTax: null, images: { placeholder: PLACEHOLDER } }, categories, collections, navigation, products };
});

/* Only the fields the storefront renders are sent to the browser. */
export function toClientCatalogue(c: Catalogue): Catalogue {
  return c;
}
