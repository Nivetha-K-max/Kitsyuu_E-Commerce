/* SEO built from the catalogue (2026-10-01): canonical URLs, Open Graph and schema.org JSON-LD for every product,
   collection and category, generated from the data the store already has. Nothing is invented: a field is left out
   when the catalogue has no value for it (no rating without approved reviews, no image for a product without a photo). */
import type { Index } from './catalogue-utils';
import { imageOf, url } from './catalogue-utils';
import type { Product } from './types';

export const BRAND = 'KITSYUU';

/** The public origin: SITE_URL, else the Vercel production host, else the local server. */
export function siteUrl(): string {
  const raw = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') || 'http://localhost:3001';
  try { return new URL(raw).origin; } catch { return 'http://localhost:3001'; }
}
export const absolute = (path: string) => /^https?:\/\//.test(path) ? path : siteUrl() + (path.startsWith('/') ? path : '/' + path);

/** A meta description from real text: whitespace collapsed, cut at a word boundary (max 160 characters). */
export function describe(text: string | null | undefined, max = 160): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,.;:—-]+$/, '') + '…';
}

/** The canonical address of a listing: a collection has its own page; a category is the shop filtered by it. */
export const listingPath = (o: { collection?: string; category?: string }) =>
  o.collection ? url.collection(o.collection) : o.category ? url.shop({ category: o.category }) : url.shop();

type Crumb = { label: string; href?: string };
export function breadcrumbLd(trail: Crumb[], currentPath: string) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.label, item: absolute(c.href ?? currentPath) })),
  };
}

export function productLd(idx: Index, p: Product) {
  const img = imageOf(p), path = url.product(p);
  const inStock = p.variants.some(v => v.available);
  const colours = p.colours?.length ? p.colours.map(c => c.label) : p.colour?.label ? [p.colour.label] : [];
  return {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(img.held ? {} : { image: [img.src, ...(p.media.gallery ?? []).filter(g => g?.src).map(g => g.src)].map(absolute) }),
    sku: p.sku,
    brand: { '@type': 'Brand', name: BRAND },
    category: idx.categoryPath(p),
    ...(colours.length ? { color: colours.join(', ') } : {}),
    ...(p.material ? { material: p.material } : {}),
    url: absolute(path),
    offers: {
      '@type': 'Offer', url: absolute(path), priceCurrency: 'INR', price: p.price.toFixed(2),
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: BRAND },
    },
    // Only from approved customer reviews in the database.
    ...(p.rating && p.rating.count > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.average.toFixed(1), reviewCount: p.rating.count, bestRating: 5, worstRating: 1 } } : {}),
  };
}

export function collectionLd(name: string, description: string, path: string, products: Product[]) {
  return {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name, url: absolute(path),
    ...(description ? { description } : {}),
    isPartOf: { '@type': 'WebSite', name: `${BRAND} Store`, url: absolute('/') },
    mainEntity: { '@type': 'ItemList', numberOfItems: products.length,
      itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: absolute(url.product(p)), name: p.name })) },
  };
}

export function organizationLd() {
  return { '@context': 'https://schema.org', '@type': 'Organization', name: BRAND, url: absolute('/'), logo: absolute('/assets/kitsyuu-icon.svg') };
}
export function websiteLd() {
  return {
    '@context': 'https://schema.org', '@type': 'WebSite', name: `${BRAND} Store`, url: absolute('/'),
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: absolute('/search?q={search_term_string}') }, 'query-input': 'required name=search_term_string' },
  };
}

/** Open Graph image of a product (its own photo), or none. */
export const productOgImages = (p: Product) => { const img = imageOf(p); return img.held ? [] : [{ url: absolute(img.src), width: img.width, height: img.height, alt: img.alt }]; };
