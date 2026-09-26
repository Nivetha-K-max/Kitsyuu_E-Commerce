import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { paiseToRupees, productListQuery, type ProductListQuery } from '@kitsyuu/contracts';
import { listCategories, listProducts } from '@kitsyuu/core';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Products' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ProductsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'products.read')) return <><PageHead title="Products" section="Catalogue" /><Forbidden permission="products.read" /></>;
  const sp = await searchParams;
  const parsed = productListQuery.safeParse({ q: one(sp.q), category: one(sp.category), status: one(sp.status) });
  const query: ProductListQuery = parsed.success ? parsed.data : { status: 'all', q: undefined, category: undefined };
  const [products, categories] = await Promise.all([listProducts(db(), actor, query), listCategories(db(), actor)]);
  const parents = categories.filter(c => !c.parent_id);
  const filtered = !!(query.q || query.category || query.status !== 'all');
  return (
    <>
      <PageHead title="Products" section="Catalogue / Management" eyebrow={`${formatNumber(products.length)} ${products.length === 1 ? 'product' : 'products'}${filtered ? ' matching the filters' : ''}`}>
        {can(actor, 'products.write') && <Link className="btn" href="/products/new" data-new-product>New product</Link>}
      </PageHead>
      <form className="actions filters" method="get" role="search" aria-label="Filter products" data-product-filters>
        <label className="sr-only" htmlFor="p-q">Search</label>
        <input id="p-q" name="q" className="input" placeholder="Search name, SKU or ID" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="p-cat">Category</label>
        <select id="p-cat" name="category" className="input" defaultValue={query.category ?? ''}>
          <option value="">All categories</option>
          {parents.map(p => [
            <option key={p.id} value={p.id}>{p.label}</option>,
            ...categories.filter(c => c.parent_id === p.id).map(c => <option key={c.id} value={c.id}>{`— ${p.label} / ${c.label}`}</option>),
          ])}
        </select>
        <label className="sr-only" htmlFor="p-status">Status</label>
        <select id="p-status" name="status" className="input" defaultValue={query.status}>
          <option value="all">Active and inactive</option><option value="active">Active only</option><option value="inactive">Inactive only</option>
        </select>
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/products">Clear</Link>}
      </form>
      {products.length === 0 ? <p className="empty" data-empty="products">No products match these filters.</p> : (
        <div className="table-wrap"><table data-products-table>
          <thead><tr><th className="thumb-col">Image</th><th>Product</th><th>SKU</th><th>Category</th><th className="num">Price</th><th className="num">Stock</th><th>Status</th></tr></thead>
          <tbody>{products.map(p => {
            const img = productImageUrl(p.primaryImage);
            return (
              <tr key={p.id} data-product-row={p.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <td className="thumb">{img ? <img src={img} alt="" width={44} height={56} loading="lazy" /> : <span className="note">—</span>}</td>
                <td className="product-cell"><Link className="row-link" href={`/products/${p.id}`}>{p.name}</Link>
                  <div className="meta-line"><span className="mono">{p.id}</span>{p.isFeatured && <span className="badge featured">featured</span>}</div></td>
                <td className="mono nowrap">{p.sku}</td>
                <td>{p.categoryLabel}{p.subcategoryLabel && <div className="note">{p.subcategoryLabel}</div>}</td>
                <td className="num" data-price>₹{paiseToRupees(p.pricePaise)}</td>
                <td className="num"><span className="qty">{formatNumber(p.stockUnits)}</span><div className="note">{p.sellableVariants}/{p.variants} sizes</div>
                  {p.attentionVariants > 0 && <span className="badge low_stock" data-attention>{p.attentionVariants} low</span>}</td>
                <td><StatusBadge status={p.status} /></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </>
  );
}
