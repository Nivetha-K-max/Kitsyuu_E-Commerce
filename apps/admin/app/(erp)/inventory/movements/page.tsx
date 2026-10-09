/* Inventory → Movements (2026-10-08): the stock ledger, read as it is.
   One row per ledger row (inventory_movements), newest first: when, which size, at which location, why (the ledger's own
   reason), by how much, the balance the ledger recorded after it, what it came from (order, transfer, goods receipt)
   and who did it. Nothing is worked out or filled in here: a balance the ledger did not record is shown as "—".
   Read only. Stock changes where the work is done (an order, a product, a location, a transfer, a receipt, a count),
   always through the stock functions that write these rows. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listLocations } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Stock movements' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MovementsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Stock movements" /><Forbidden permission="inventory.read" /></>;
  const sp = await searchParams;
  const q = (one(sp.q) ?? '').trim().slice(0, 80);
  const dir = one(sp.direction) === 'in' || one(sp.direction) === 'out' ? one(sp.direction) as 'in' | 'out' : '';
  const page = Math.min(10_000, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const [locations, reasons] = await Promise.all([listLocations(db(), actor), db().selectFrom('inventory_reasons').select(['code', 'label']).orderBy('sort_order').orderBy('code').execute()]);
  const location = locations.find(l => l.id === (UUID.test(one(sp.location) ?? '') ? one(sp.location) : '')) ?? null;
  const reason = reasons.find(r => r.code === one(sp.reason))?.code ?? '';
  const online = locations.find(l => l.is_online) ?? null;
  const seeProducts = can(actor, 'products.read'), seeOrders = can(actor, 'orders.read'), seePurchasing = can(actor, 'procurement.read');

  let query = db().selectFrom('inventory_movements as m').innerJoin('product_variants as v', 'v.id', 'm.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('inventory_reasons as r', 'r.code', 'm.reason').leftJoin('staff_users as s', 's.id', 'm.staff_id').leftJoin('locations as l', 'l.id', 'm.location_id')
    .leftJoin('orders as o', 'o.id', 'm.order_id').leftJoin('stock_transfers as t', 't.id', 'm.transfer_id').leftJoin('goods_receipts as g', 'g.id', 'm.goods_receipt_id')
    .select(['m.id', 'm.created_at', 'm.delta', 'm.reason', 'r.label as reason_label', 'm.balance_after', 'm.note', 'm.location_id', 'l.name as location_name',
      'v.sku', 'v.size', 'p.id as product_id', 'p.name as product_name', 's.email as staff_email', 'm.order_id', 'o.order_number', 'm.transfer_id', 't.number as transfer_number',
      'm.goods_receipt_id', 'g.purchase_order_id', 'g.receipt_number']);
  if (q) { const like = `%${q.replace(/[\\%_]/g, x => '\\' + x)}%`; query = query.where(eb => eb.or([eb('p.name', 'ilike', like), eb('v.sku', 'ilike', like), eb('o.order_number', 'ilike', like), eb('t.number', 'ilike', like)])); }
  // A ledger row without a location is the online store's stock (rows written before locations existed, and the store's own).
  if (location) query = query.where(eb => (location.is_online ? eb.or([eb('m.location_id', '=', location.id), eb('m.location_id', 'is', null)]) : eb('m.location_id', '=', location.id)));
  if (reason) query = query.where('m.reason', '=', reason);
  if (dir) query = query.where('m.delta', dir === 'in' ? '>' : '<', 0);
  const found = await query.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(PAGE_SIZE + 1).offset((page - 1) * PAGE_SIZE).execute();
  const rows = found.slice(0, PAGE_SIZE), hasNext = found.length > PAGE_SIZE;
  const filtered = !!(q || location || reason || dir);
  const link = (p: number) => {
    const qs = new URLSearchParams(Object.entries({ q, location: location?.id ?? '', reason, direction: dir, page: p > 1 ? String(p) : '' }).filter(([, v]) => v)).toString();
    return qs ? `/inventory/movements?${qs}` : '/inventory/movements';
  };

  return (
    <Workspace name="movements" title="Stock movements" summary="The stock ledger: every change to stock, newest first">
      <ModuleViews module="inventory" label="Inventory" current="/inventory/movements" />
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter movements" data-movement-filters>
          <label className="sr-only" htmlFor="mv-q">Search</label>
          <input id="mv-q" name="q" className="input" placeholder="Search product, SKU, order or transfer" defaultValue={q} />
          {locations.length > 1 && <>
            <label className="sr-only" htmlFor="mv-location">Location</label>
            <select id="mv-location" name="location" className="input" defaultValue={location?.id ?? ''}>
              <option value="">All locations</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </>}
          <label className="sr-only" htmlFor="mv-reason">Movement type</label>
          <select id="mv-reason" name="reason" className="input" defaultValue={reason}>
            <option value="">All movement types</option>{reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="mv-dir">Direction</label>
          <select id="mv-dir" name="direction" className="input" defaultValue={dir}><option value="">In and out</option><option value="in">Stock in</option><option value="out">Stock out</option></select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/inventory/movements" data-clear-filters>Clear</FilterLink>}
      </div>
      {rows.length === 0 ? (
        <StateBlock title={filtered ? 'No matching movements' : 'No stock movements yet'} name="movements" action={filtered ? <Link className="btn ghost sm" href="/inventory/movements">Show all movements</Link> : undefined}>
          {filtered ? 'No ledger row matches these filters.' : 'Every change to stock is listed here as it happens.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={link(page)}><table data-movements-ledger>
          <thead><tr><th>Product and size</th><th className="num">Change</th><th>Movement</th><th>Location</th><th className="num">Balance after</th><th>From</th><th>By</th><th>When</th></tr></thead>
          <tbody>{rows.map(m => (
            <tr key={String(m.id)} data-movement={String(m.id)} data-reason={m.reason} data-sku={m.sku}>
              <td className="ord-who">{seeProducts ? <NavLink className="row-link" href={`/products/${m.product_id}?tab=variants`}>{m.product_name}</NavLink> : <b>{m.product_name}</b>}
                <div className="ord-no">{m.sku}<span> · size {m.size}</span></div></td>
              <td className="num ord-amount" data-delta>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
              <td className="ord-stage">{m.reason_label ?? m.reason}{m.note ? <div className="note">{m.note}</div> : null}</td>
              <td className="ord-extra" data-label="Location">{m.location_id ? <Link href={`/locations/${m.location_id}`}>{m.location_name}</Link> : online ? <Link href={`/locations/${online.id}`}>{online.name}</Link> : '—'}</td>
              <td className="num ord-extra" data-label="Balance after" data-balance>{m.balance_after ?? '—'}</td>
              <td className="ord-extra" data-label="From" data-reference>
                {m.order_id ? (seeOrders ? <Link href={`/orders/${m.order_id}?tab=items`}>Order {m.order_number}</Link> : `Order ${m.order_number}`)
                  : m.transfer_id ? <Link href={`/transfers/${m.transfer_id}`}>Transfer {m.transfer_number}</Link>
                  : m.goods_receipt_id ? (seePurchasing && m.purchase_order_id ? <Link href={`/purchase-orders/${m.purchase_order_id}/receipts/${m.goods_receipt_id}`}>Receipt {m.receipt_number ?? ''}</Link> : `Receipt ${m.receipt_number ?? ''}`)
                  : <span className="note">—</span>}
              </td>
              <td className="ord-extra" data-label="By">{m.staff_email ?? <span className="note">system</span>}</td>
              <td className="nowrap ord-placed">{formatDateTime(m.created_at as Date)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {(page > 1 || hasNext) && (
        <nav className="pager" aria-label="Movement pages" data-pager>
          {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={link(page - 1)}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {formatNumber(page)}</span>
          {hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={link(page + 1)}>Older →</FilterLink> : <span />}
        </nav>
      )}
      <p className="note section-foot">Rows are never edited or removed. A correction is a new row with its own reason.</p>
    </Workspace>
  );
}
