import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { productListQuery, type ProductListQuery } from '@kitsyuu/contracts';
import { listCategories, listCollections, listProducts } from '@kitsyuu/core';
import { Icon } from '@/components/icons';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { bulkStatusAction, setProductStatusAction } from './actions';
import ProductsTable, { type ProductRowView } from './ProductsTable';

export const metadata: Metadata = { title: 'Products' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const rupeeBound = (v: string | undefined) => (v && /^\d{1,7}$/.test(v) ? v : '');

export default async function ProductsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'products.read')) return <><PageHead title="Products" section="Catalogue" /><Forbidden permission="products.read" /></>;
  const sp = await searchParams;
  const parsed = productListQuery.safeParse({ q: one(sp.q), category: one(sp.category), status: one(sp.status), collection: one(sp.collection), stock: one(sp.stock) });
  const query: ProductListQuery = parsed.success ? parsed.data : { status: 'all', q: undefined, category: undefined, collection: undefined, stock: 'all' };
  const [products, categories, collections] = await Promise.all([listProducts(db(), actor, query), listCategories(db(), actor),
    can(actor, 'categories.read') ? listCollections(db(), actor) : Promise.resolve([])]);
  const write = can(actor, 'products.write');
  const store = process.env.STORE_URL?.replace(/\/+$/, '') || null;
  const rows: ProductRowView[] = products.map(p => ({
    id: p.id, sku: p.sku, name: p.name, status: p.status, categoryLabel: p.categoryLabel, subcategoryLabel: p.subcategoryLabel,
    pricePaise: p.pricePaise, isFeatured: p.isFeatured, imageUrl: productImageUrl(p.primaryImage), variants: p.variants,
    sellableVariants: p.sellableVariants, stockUnits: p.stockUnits, attentionVariants: p.attentionVariants,
    storeUrl: store ? `${store}/product/${encodeURIComponent(p.slug)}` : null,
  }));
  const filtered = !!(query.q || query.category || query.status !== 'all' || query.collection || query.stock !== 'all');
  const units = products.reduce((s, p) => s + p.stockUnits, 0);
  return (
    <>
      <PageHead title="Products"
        eyebrow={`${formatNumber(products.length)} ${products.length === 1 ? 'product' : 'products'}${filtered ? ' matching the filters' : ` · ${formatNumber(units)} units in stock`}`}>
        {write && <Link className="btn ghost" href="/products/bulk" data-bulk-edit>Bulk edit</Link>}
        {write && <Link className="btn" href="/products/new" data-new-product><Icon name="plus" size={15} />New product</Link>}
      </PageHead>
      <ProductsTable rows={rows} categories={categories.map(c => ({ id: c.id, label: c.label, parent_id: c.parent_id }))}
        collections={collections.map(c => ({ id: c.id, label: c.label }))}
        filters={{ q: query.q ?? '', category: query.category ?? '', status: query.status, pmin: rupeeBound(one(sp.pmin)), pmax: rupeeBound(one(sp.pmax)),
          collection: query.collection ?? '', stock: query.stock }}
        canWrite={write} bulkAction={bulkStatusAction} statusAction={setProductStatusAction} />
    </>
  );
}
