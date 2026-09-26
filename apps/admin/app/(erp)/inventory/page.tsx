import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { stockListQuery, type StockListQuery } from '@kitsyuu/contracts';
import { listStock } from '@kitsyuu/core';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Stock' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function InventoryPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead title="Stock" /><Forbidden permission="inventory.read" /></>;
  const sp = await searchParams;
  const parsed = stockListQuery.safeParse({ q: one(sp.q), status: one(sp.status) });
  const query: StockListQuery = parsed.success ? parsed.data : { status: 'all', q: undefined };
  const { rows, totals } = await listStock(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all');
  return (
    <>
      <PageHead title="Stock" eyebrow={`${formatNumber(totals.units)} units across ${formatNumber(totals.variants)} sizes`} />
      <form className="actions filters" method="get" role="search" aria-label="Filter stock" data-stock-filters>
        <label className="sr-only" htmlFor="s-q">Search</label>
        <input id="s-q" name="q" className="input" placeholder="Search product, SKU or ID" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="s-status">Stock status</label>
        <select id="s-status" name="status" className="input" defaultValue={query.status}>
          <option value="all">All sizes</option><option value="attention">Needs attention (sellable, low or out)</option>
          <option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option><option value="in_stock">In stock</option>
        </select>
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/inventory">Clear</Link>}
      </form>
      <p className="note">Stock is changed from each product page; every change goes through the stock ledger with a reason.</p>
      {rows.length === 0 ? <p className="empty" data-empty="stock">{query.status === 'attention' ? 'No sellable size is low or out of stock.' : 'No sizes match these filters.'}</p> : (
        <div className="table-wrap"><table data-stock-table>
          <thead><tr><th>Product</th><th>SKU</th><th>Size</th><th className="num">In stock</th><th className="num">Reorder at</th><th>Status</th><th>Last movement</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.variant_id} data-stock-row={r.variant_sku}>
              <td><Link href={`/products/${r.product_id}#stock-h`}>{r.product_name}</Link>{r.product_status !== 'active' && <> <StatusBadge status={r.product_status} /></>}</td>
              <td className="mono">{r.variant_sku}</td><td>{r.size}</td>
              <td className="num" data-qty>{r.stock_qty}</td><td className="num">{r.reorder_level}</td>
              <td>{r.is_active ? <StatusBadge status={r.stock_status} /> : <span className="badge">size not offered</span>}</td>
              <td>{formatDateTime(r.last_movement_at)}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
