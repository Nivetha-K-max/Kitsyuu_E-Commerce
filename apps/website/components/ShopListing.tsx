/* A product listing: all products, a category (/shop?category=…) or a collection (/collections/<id>; the older
   /shop?collection=<id> shows the same page). Shared by app/shop and app/collections/[id]. Metadata, canonical URL and
   JSON-LD (CollectionPage + BreadcrumbList) come from the catalogue (lib/seo.ts); sort and filter parameters are never
   part of the canonical URL. */
import type { Metadata } from 'next';
import { getCatalogue } from '@/lib/catalogue';
import { indexCatalogue, plural, url, type Index } from '@/lib/catalogue-utils';
import { breadcrumbLd, collectionLd, describe, listingPath } from '@/lib/seo';
import type { Product } from '@/lib/types';
import { Crumbs, NotFoundBlock } from '@/components/ui';
import ShopResults, { type Tab } from '@/components/ShopResults';
import PromoBanners from '@/components/PromoBanners';
import JsonLd from '@/components/JsonLd';

export type ListingQuery = { category?: string; collection?: string; sort?: string };

type View =
  | { notFound: true; title: string; text: string }
  | { notFound?: false; seoTitle?: string | null; seoDescription?: string | null; title: string; list: Product[]; trail: { label: string; href?: string }[]; sub: string | null; aside: string; tabs: { label: string; items: Tab[]; current: string } | null; isNew: boolean; base: string };

function resolve(idx: Index, catId: string, colId: string): View {
  const trail: { label: string; href?: string }[] = [{ label: 'Home', href: url.home }, { label: 'Shop', href: url.shop() }];
  if (colId) {
    const col = idx.collection(colId);
    if (!col) return { notFound: true, title: 'Collection not found', text: 'This collection is not part of the KITSYUU catalogue.' };
    return { title: col.label, list: col.products, trail: [...trail, { label: col.label }], sub: null, isNew: colId === 'new-arrivals', tabs: null, base: 'Collection order',
      aside: '', seoTitle: col.seoTitle ?? null, seoDescription: col.seoDescription ?? null };
  }
  if (catId) {
    const cat = idx.cats.get(catId);
    if (!cat) return { notFound: true, title: 'Category not found', text: 'This category is not part of the KITSYUU catalogue.' };
    const top = cat.parent ? idx.cats.get(cat.parent)! : cat;
    const t = cat.parent ? [...trail, { label: top.label, href: url.shop({ category: top.id }) }, { label: cat.label }] : [...trail, { label: top.label }];
    return { title: cat.label, list: idx.inCategory(cat.id), trail: t, sub: cat.parent ? top.label : null, aside: '', isNew: false, base: 'Catalogue order',
      tabs: { label: `${top.label} categories`, current: cat.id, items: [{ label: `All ${top.label.toLowerCase()}`, id: top.id, n: idx.inCategory(top.id).length }, ...idx.children(top.id).map(c => ({ label: c.label, id: c.id, n: idx.inCategory(c.id).length }))] } };
  }
  return { title: 'All products', list: idx.c.products, trail: [trail[0], { label: 'Shop' }], sub: null, aside: '', isNew: false, base: 'Catalogue order',
    tabs: { label: 'Categories', current: '', items: [{ label: 'All products', id: '', n: idx.c.products.length }, ...idx.top.map(c => ({ label: c.label, id: c.id, n: idx.inCategory(c.id).length }))] } };
}

/** The listing's own description: staff's SEO text when entered (Collections → SEO), else one built from its products. */
const descriptionOf = (v: Exclude<View, { notFound: true }>) => v.seoDescription
  || describe(`${v.title} at KITSYUU: ${plural(v.list.length, 'piece').replace(/^0/, '')}${v.list.length ? ` including ${v.list.slice(0, 3).map(p => p.name).join(', ')}` : ''}.`);

export async function listingMetadata(q: ListingQuery): Promise<Metadata> {
  const v = resolve(indexCatalogue(await getCatalogue()), q.category ?? '', q.collection ?? '');
  if (v.notFound) return { title: v.title, robots: { index: false } };
  const title = v.seoTitle || v.title, description = descriptionOf(v), path = listingPath(q);
  return { title, description, alternates: { canonical: path }, openGraph: { type: 'website', title, description, url: path, siteName: 'KITSYUU Store' } };
}

export default async function ShopListing({ query: q }: { query: ListingQuery }) {
  const idx = indexCatalogue(await getCatalogue());
  const v = resolve(idx, q.category ?? '', q.collection ?? '');
  if (v.notFound) return <NotFoundBlock title={v.title} text={v.text} />;
  const path = listingPath(q);
  return (
    <div className="st-wrap">
      <JsonLd data={[collectionLd(v.seoTitle || v.title, descriptionOf(v), path, v.list), breadcrumbLd(v.trail, path)]} />
      <Crumbs list={v.trail} />
      <header className="st-plp-head">
        <h1>{v.sub && <small>{v.sub.toUpperCase()} /</small>}{v.title}</h1>
        <div className="st-plp-aside"><p className="st-result-count">{plural(v.list.length, 'product')}</p>{v.aside && <p>{v.aside}</p>}</div>
      </header>
      <PromoBanners placement="shop" wrap={false} />
      <ShopResults productIds={v.list.map(p => p.id)} tabs={v.tabs} isNew={v.isNew} base={v.base} initialSort={q.sort ?? ''} />
      <p className="st-footnote">Prices in INR.</p>
    </div>
  );
}
