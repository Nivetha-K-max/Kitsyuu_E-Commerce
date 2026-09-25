import type { Metadata } from 'next';
import { getCatalogue } from '@/lib/catalogue';
import { indexCatalogue, plural, url, type Index } from '@/lib/catalogue-utils';
import type { Product } from '@/lib/types';
import { Crumbs, NotFoundBlock } from '@/components/ui';
import ShopResults, { type Tab } from '@/components/ShopResults';

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';

type View =
  | { notFound: true; title: string; text: string }
  | { notFound?: false; title: string; list: Product[]; trail: { label: string; href?: string }[]; sub: string | null; aside: string; tabs: { label: string; items: Tab[]; current: string } | null; isNew: boolean; base: string };

function resolve(idx: Index, catId: string, colId: string): View {
  const trail: { label: string; href?: string }[] = [{ label: 'Store', href: url.home }, { label: 'Shop', href: url.shop() }];
  if (colId) {
    const col = idx.collection(colId);
    if (!col) return { notFound: true, title: 'Collection not found', text: 'This collection is not part of the prototype catalogue.' };
    return { title: col.label, list: col.products, trail: [...trail, { label: col.label }], sub: null, isNew: colId === 'new-arrivals', tabs: null, base: 'Collection order',
      aside: col.dataStatus === 'prototype' ? 'A prototype selection for store development. These are not confirmed new arrivals.' : '' };
  }
  if (catId) {
    const cat = idx.cats.get(catId);
    if (!cat) return { notFound: true, title: 'Category not found', text: 'This category is not part of the prototype catalogue.' };
    const top = cat.parent ? idx.cats.get(cat.parent)! : cat;
    const t = cat.parent ? [...trail, { label: top.label, href: url.shop({ category: top.id }) }, { label: cat.label }] : [...trail, { label: top.label }];
    return { title: cat.label, list: idx.inCategory(cat.id), trail: t, sub: cat.parent ? top.label : null, aside: '', isNew: false, base: 'Catalogue order',
      tabs: { label: `${top.label} categories`, current: cat.id, items: [{ label: `All ${top.label.toLowerCase()}`, id: top.id, n: idx.inCategory(top.id).length }, ...idx.children(top.id).map(c => ({ label: c.label, id: c.id, n: idx.inCategory(c.id).length }))] } };
  }
  return { title: 'All products', list: idx.c.products, trail: [trail[0], { label: 'Shop' }], sub: null, aside: '', isNew: false, base: 'Catalogue order',
    tabs: { label: 'Categories', current: '', items: [{ label: 'All products', id: '', n: idx.c.products.length }, ...idx.top.map(c => ({ label: c.label, id: c.id, n: idx.inCategory(c.id).length }))] } };
}

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const q = await searchParams, v = resolve(indexCatalogue(await getCatalogue()), one(q.category), one(q.collection));
  return { title: v.title, description: 'Browse the prototype KITSYUU catalogue: tops, bottoms and outerwear.' };
}

export default async function Shop({ searchParams }: { searchParams: SP }) {
  const q = await searchParams, idx = indexCatalogue(await getCatalogue());
  const v = resolve(idx, one(q.category), one(q.collection));
  if (v.notFound) return <NotFoundBlock title={v.title} text={v.text} />;
  return (
    <div className="st-wrap">
      <Crumbs list={v.trail} />
      <header className="st-plp-head">
        <h1>{v.sub && <small>{v.sub.toUpperCase()} /</small>}{v.title}</h1>
        <div className="st-plp-aside"><p className="st-result-count">{plural(v.list.length, 'product')}</p>{v.aside && <p>{v.aside}</p>}</div>
      </header>
      <ShopResults productIds={v.list.map(p => p.id)} tabs={v.tabs} isNew={v.isNew} base={v.base} initialSort={one(q.sort)} />
      <p className="st-footnote">Prototype catalogue: names, sizes, prices and descriptions are estimates and not confirmed company data. Prices in INR; tax inclusion not yet confirmed. Images are prototype catalogue cutouts without zoom.</p>
    </div>
  );
}
