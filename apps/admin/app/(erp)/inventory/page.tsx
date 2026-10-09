/* Inventory → Stock (2026-10-08: on the shared workspace frame).
   One row per size: what the online store can sell (product_variants.stock_qty, the figure the stock ledger keeps),
   where else that size is held (location_stock), its reorder level and status, and when it last moved.

   What the figures mean here, exactly as the platform keeps them:
   · "Online store stock" is on-hand stock at the online location. An order takes its pieces when it is placed (a ledger
     row), so there is no separate "reserved" quantity: on hand IS what can still be sold. Nothing here is estimated.
   · Low / out of stock uses the size's own reorder level, else Configuration → low stock threshold (v_inventory_status).
     It is about the online store's stock; other locations have no threshold, so they show a quantity and no status.
   Nothing changes stock on this page: adjusting opens the product (online stock) or the location, which write the ledger. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { stockListQuery, type StockListQuery } from '@kitsyuu/contracts';
import { listCategories, listColours, listLocations, listStock, stockByLocation } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Inventory' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE_SIZE = 50;
const SORTS = { product: 'Product', qty_asc: 'Lowest stock first', qty_desc: 'Highest stock first', moved: 'Last moved' } as const;
type Sort = keyof typeof SORTS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InventoryPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Inventory" /><Forbidden permission="inventory.read" /></>;
  const sp = await searchParams;
  const parsed = stockListQuery.safeParse({ q: one(sp.q), status: one(sp.status) });
  const query: StockListQuery = parsed.success ? parsed.data : { status: 'all', q: undefined };
  const seeProducts = can(actor, 'products.read'), adjust = can(actor, 'inventory.adjust');
  const [{ rows: all, totals }, locations, colours, categories] = await Promise.all([
    listStock(db(), actor, query), listLocations(db(), actor), listColours(db()), seeProducts ? listCategories(db(), actor) : Promise.resolve([]),
  ]);
  const ids = all.map(r => r.variant_id);
  // What the list service does not carry: the colour of a size, the product's category, and the quantities at each location.
  const [variants, held] = await Promise.all([
    ids.length ? db().selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').select(['v.id', 'v.colour_slug', 'p.category_id', 'p.subcategory_id']).where('v.id', 'in', ids).execute() : Promise.resolve([]),
    stockByLocation(db(), ids),
  ]);
  const info = new Map(variants.map(v => [v.id, v]));
  const colourOf = (slug: string | null | undefined) => (slug ? colours.find(c => c.slug === slug)?.label ?? slug : null);
  const category = categories.some(c => c.id === one(sp.category)) ? one(sp.category)! : '';
  const location = locations.find(l => l.id === (UUID.test(one(sp.location) ?? '') ? one(sp.location) : '')) ?? null;
  const sort: Sort = (one(sp.sort) ?? '') in SORTS ? one(sp.sort) as Sort : 'product';
  const at = (variantId: string, locationId: string) => held.find(h => h.variant_id === variantId && h.location_id === locationId)?.qty ?? 0;

  let rows = all.filter(r => !category || info.get(r.variant_id)?.category_id === category || info.get(r.variant_id)?.subcategory_id === category);
  // A location: the sizes it holds. (The online location's quantity is the store's stock itself.)
  if (location) rows = rows.filter(r => (location.is_online ? r.stock_qty : at(r.variant_id, location.id)) > 0);
  const qtyOf = (r: (typeof all)[number]) => (location && !location.is_online ? at(r.variant_id, location.id) : r.stock_qty);
  if (sort === 'qty_asc') rows = [...rows].sort((a, b) => qtyOf(a) - qtyOf(b) || a.variant_sku.localeCompare(b.variant_sku));
  if (sort === 'qty_desc') rows = [...rows].sort((a, b) => qtyOf(b) - qtyOf(a) || a.variant_sku.localeCompare(b.variant_sku));
  if (sort === 'moved') rows = [...rows].sort((a, b) => new Date(b.last_movement_at ?? 0).getTime() - new Date(a.last_movement_at ?? 0).getTime());

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const filtered = !!(query.q || query.status !== 'all' || category || location);
  const link = (patch: Record<string, string>) => {
    const next = { q: query.q ?? '', status: query.status === 'all' ? '' : query.status, category, location: location?.id ?? '', sort: sort === 'product' ? '' : sort, page: '', ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
    return qs ? `/inventory?${qs}` : '/inventory';
  };
  const attention = all.filter(r => r.is_active && r.stock_status !== 'in_stock').length;
  const elsewhere = locations.filter(l => !l.is_online);

  return (
    <Workspace name="inventory" title="Inventory"
      summary={`${formatNumber(totals.units)} units across ${formatNumber(totals.variants)} sizes${query.q || query.status !== 'all' ? '' : attention ? ` · ${formatNumber(attention)} low or out` : ''}`}>
      <ModuleViews module="inventory" label="Inventory" current="/inventory" />
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter stock" data-stock-filters>
          <label className="sr-only" htmlFor="s-q">Search</label>
          <input id="s-q" name="q" className="input" placeholder="Search product, SKU or ID" defaultValue={query.q ?? ''} />
          <label className="sr-only" htmlFor="s-status">Stock status</label>
          <select id="s-status" name="status" className="input" defaultValue={query.status}>
            <option value="all">All sizes</option><option value="attention">Needs attention (sellable, low or out)</option>
            <option value="low_stock">Low stock</option><option value="out_of_stock">Out of stock</option><option value="in_stock">In stock</option>
          </select>
          {locations.length > 1 && <>
            <label className="sr-only" htmlFor="s-location">Location</label>
            <select id="s-location" name="location" className="input" defaultValue={location?.id ?? ''}>
              <option value="">All locations</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.is_active ? '' : ' (inactive)'}</option>)}
            </select>
          </>}
          {categories.length > 0 && <>
            <label className="sr-only" htmlFor="s-category">Category</label>
            <select id="s-category" name="category" className="input" defaultValue={category}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.parent_id ? `${categories.find(p => p.id === c.parent_id)?.label ?? ''} / ${c.label}` : c.label}</option>)}
            </select>
          </>}
          <label className="sr-only" htmlFor="s-sort">Sort</label>
          <select id="s-sort" name="sort" className="input" defaultValue={sort === 'product' ? '' : sort}>
            <option value="">Sort: product</option><option value="qty_asc">{SORTS.qty_asc}</option><option value="qty_desc">{SORTS.qty_desc}</option><option value="moved">{SORTS.moved}</option>
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/inventory" data-clear-filters>Clear</FilterLink>}
      </div>
      {shown.length === 0 ? (
        <StateBlock title={query.status === 'attention' && !query.q && !category && !location ? 'Nothing needs attention' : 'No matching sizes'} name="stock"
          action={filtered ? <Link className="btn ghost sm" href="/inventory">Show all sizes</Link> : undefined}>
          {query.status === 'attention' && !query.q && !category && !location ? 'No sellable size is low or out of stock.' : location ? `No size matching these filters is held at ${location.name}.` : 'No sizes match these filters.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={link({ page: String(page) })}><table data-stock-table>
          <thead><tr><th>Product and size</th>{location && !location.is_online ? <th className="num">At {location.name}</th> : null}
            <th className="num">Online store stock</th>{elsewhere.length > 0 && <th>Other locations</th>}<th className="num">Reorder at</th><th>Status</th><th>Last movement</th><th>Open</th></tr></thead>
          <tbody>{shown.map(r => {
            const v = info.get(r.variant_id), colour = colourOf(v?.colour_slug), other = held.filter(h => h.variant_id === r.variant_id && !h.is_online);
            return (
              <tr key={r.variant_id} data-stock-row={r.variant_sku} data-level={r.is_active ? r.stock_status : 'off'}>
                <td className="ord-who product-cell">
                  {seeProducts ? <NavLink className="row-link" href={`/products/${r.product_id}?tab=variants`}>{r.product_name}</NavLink> : <b>{r.product_name}</b>}
                  <div className="ord-no">{r.variant_sku}<span> · {colour ? `${colour} / ` : ''}size {r.size}</span>{r.is_active ? null : <span> · size not offered</span>}</div>
                  {r.product_status !== 'active' && <div className="meta-line"><StatusBadge status={r.product_status} /></div>}
                </td>
                {location && !location.is_online ? <td className="num ord-extra" data-label={`At ${location.name}`} data-qty-here>{formatNumber(at(r.variant_id, location.id))}</td> : null}
                <td className="num qty ord-amount" data-qty>{r.stock_qty}</td>
                {elsewhere.length > 0 && <td className="ord-extra note" data-label="Other locations" data-by-location>
                  {other.length === 0 ? '—' : other.map((h, i) => <span key={h.location_id}>{i > 0 && ' · '}<Link href={`/locations/${h.location_id}`}>{h.name}</Link> {h.qty}</span>)}</td>}
                <td className="num ord-extra" data-label="Reorder at">{r.reorder_level}</td>
                <td className="ord-stage">{r.is_active ? <StatusBadge status={r.stock_status} /> : <span className="badge">size not offered</span>}</td>
                <td className="nowrap note ord-extra" data-label="Last movement">{formatDateTime(r.last_movement_at)}</td>
                <td className="ord-next"><div className="actions row-actions">
                  <Link className="btn ghost sm" href={`/inventory/movements?q=${encodeURIComponent(r.variant_sku)}`} data-link="movements" aria-label={`Movements of ${r.variant_sku}`}>History</Link>
                  {adjust && seeProducts && <Link className="btn ghost sm" href={`/products/${r.product_id}?tab=variants#adjust-h`} aria-label={`Adjust ${r.variant_sku}`}>Adjust</Link>}
                </div></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Stock pages" data-pager>
          {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: page === 2 ? '' : String(page - 1) })}>← Previous</FilterLink> : <span />}
          <span className="pager-page">Page {page} of {pages} · {formatNumber(rows.length)} sizes</span>
          {page < pages ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: String(page + 1) })}>Next →</FilterLink> : <span />}
        </nav>
      )}
      <p className="note section-foot" data-stock-definitions>Online store stock is what is on hand and can be sold: an order takes its pieces when it is placed, so nothing is held back separately.
        Low and out of stock follow each size&apos;s reorder level. Every change is a row in the stock ledger (<Link href="/inventory/movements">Movements</Link>); stock is changed on the product, at a location, by a transfer or by a stock count.</p>
    </Workspace>
  );
}
