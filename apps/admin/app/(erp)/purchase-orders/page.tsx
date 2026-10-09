/* Purchasing → Purchase orders (2026-10-08: on the shared workspace frame).
   One row per purchase order: who it is with, when it is expected, where its products are received, how much of it has
   arrived and what is still to come. The figures are read from the order's own lines (qty_ordered / qty_received), which
   only a goods receipt changes; nothing is kept twice and nothing changes on this page. The views are the order's real
   statuses. A new order is started on its own page (/purchase-orders/new) because its item list needs the width. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { sql } from '@kitsyuu/db';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Purchase orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const STATUSES = ['draft', 'approved', 'ordered', 'partially_received', 'received', 'closed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_TAB: Record<Status, string> = { draft: 'Draft', approved: 'Approved', ordered: 'Sent', partially_received: 'Partly received', received: 'Received', closed: 'Closed', cancelled: 'Cancelled' };
const SORTS = { newest: 'Newest first', expected: 'Expected date', updated: 'Last updated' } as const;
type Sort = keyof typeof SORTS;
const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase orders" /><Forbidden permission="procurement.read" /></>;
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(one(sp.status) ?? '') ? one(sp.status) as Status : undefined;
  const q = (one(sp.q) ?? '').trim().slice(0, 80);
  const sort: Sort = (one(sp.sort) ?? '') in SORTS ? one(sp.sort) as Sort : 'newest';
  const manage = can(actor, 'procurement.manage'), costs = can(actor, 'costs.read');
  const [vendors, counts, online] = await Promise.all([
    db().selectFrom('vendors').select(['id', 'name']).orderBy(sql`lower(name)`).execute(),
    db().selectFrom('purchase_orders').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute(),
    db().selectFrom('locations').select('name').where('is_online', '=', true).executeTakeFirst(),
  ]);
  const vendor = vendors.find(v => v.id === (UUID.test(one(sp.vendor) ?? '') ? one(sp.vendor) : '')) ?? null;
  const countOf = (s: Status) => counts.find(c => c.status === s)?.n ?? 0;
  const total = counts.reduce((n, c) => n + c.n, 0);

  let base = db().selectFrom('purchase_orders as p').innerJoin('vendors as v', 'v.id', 'p.vendor_id');
  if (status) base = base.where('p.status', '=', status);
  if (vendor) base = base.where('p.vendor_id', '=', vendor.id);
  if (q) { const like = `%${q.replace(/[\\%_]/g, x => '\\' + x)}%`; base = base.where(eb => eb.or([eb('p.po_number', 'ilike', like), eb('v.name', 'ilike', like)])); }
  const { n: matching } = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
  const pages = Math.max(1, Math.ceil(matching / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const rows = await base.leftJoin('staff_users as s', 's.id', 'p.created_by').leftJoin('locations as l', 'l.id', 'p.location_id')
    .select(['p.id', 'p.po_number', 'p.status', 'p.expected_on', 'p.created_at', 'p.updated_at', 'p.vendor_id', 'v.name as vendor', 's.email as created_by', 'l.name as location',
      sql<number>`(select count(*)::int from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('lines'),
      sql<string>`(select coalesce(sum(ln.qty_ordered), 0)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('ordered'),
      sql<string>`(select coalesce(sum(ln.qty_received), 0)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('received'),
      sql<string | null>`(select sum(ln.qty_ordered * ln.unit_cost_paise)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('value'),
      sql<boolean>`(p.expected_on is not null and p.expected_on < current_date and p.status in ('approved', 'ordered', 'partially_received'))`.as('overdue')])
    .$if(sort === 'newest', x => x.orderBy('p.created_at', 'desc'))
    .$if(sort === 'expected', x => x.orderBy(sql`p.expected_on asc nulls last`).orderBy('p.created_at', 'desc'))
    .$if(sort === 'updated', x => x.orderBy('p.updated_at', 'desc'))
    .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE).execute();

  const filtered = !!(q || vendor || status);
  const link = (patch: Record<string, string>) => {
    const next = { status: status ?? '', q, vendor: vendor?.id ?? '', sort: sort === 'newest' ? '' : sort, page: '', ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
    return qs ? `/purchase-orders?${qs}` : '/purchase-orders';
  };
  const toReceive = countOf('ordered') + countOf('partially_received');

  return (
    <Workspace name="purchase-orders" title="Purchase orders"
      summary={`${formatNumber(total)} order${total === 1 ? '' : 's'}${toReceive ? ` · ${formatNumber(toReceive)} with goods still to come` : ''}${countOf('draft') + countOf('approved') ? ` · ${formatNumber(countOf('draft') + countOf('approved'))} not yet sent` : ''}`}
      actions={manage ? <Link className="btn" href="/purchase-orders/new" data-link="new-po">New purchase order</Link> : undefined}>
      <ModuleViews module="purchasing" label="Purchasing" current="/purchase-orders" />
      <div data-po-tabs>
        <ViewTabs label="Purchase order status" current={status ?? 'all'}
          items={[{ id: 'all', label: 'All', href: link({ status: '' }) }, ...STATUSES.map(s => ({ id: s, label: STATUS_TAB[s], href: link({ status: s }), count: countOf(s) }))]} />
      </div>
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter purchase orders" data-po-filters>
          {status && <input type="hidden" name="status" value={status} />}
          <label className="sr-only" htmlFor="po-q">Search</label>
          <input id="po-q" name="q" className="input" placeholder="Search order number or vendor" defaultValue={q} />
          {vendors.length > 1 && <>
            <label className="sr-only" htmlFor="po-vendor">Vendor</label>
            <select id="po-vendor" name="vendor" className="input" defaultValue={vendor?.id ?? ''}>
              <option value="">All vendors</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </>}
          <label className="sr-only" htmlFor="po-sort">Sort</label>
          <select id="po-sort" name="sort" className="input" defaultValue={sort === 'newest' ? '' : sort}>
            <option value="">Sort: newest first</option><option value="expected">{SORTS.expected}</option><option value="updated">{SORTS.updated}</option>
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/purchase-orders" data-clear-filters>Clear</FilterLink>}
      </div>
      {rows.length === 0 ? (
        <StateBlock title={filtered ? 'No matching purchase orders' : 'No purchase orders yet'} name="purchase-orders"
          action={filtered ? <Link className="btn ghost sm" href="/purchase-orders">Show all orders</Link> : manage ? <Link className="btn ghost sm" href="/purchase-orders/new">New purchase order</Link> : undefined}>
          {filtered ? 'No purchase order matches these filters.' : 'An order to a vendor for finished products or materials starts here. Nothing enters stock until goods are received.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={link({ page: String(page) })}><table data-po-table>
          <thead><tr><th>Order</th><th>Vendor</th><th>Expected</th><th>Receive at</th><th className="num">Received</th><th className="num">To come</th>{costs && <th className="num">Order value</th>}<th>Status</th><th>Last updated</th></tr></thead>
          <tbody>{rows.map(o => {
            const ordered = Number(o.ordered), received = Number(o.received), left = Math.max(0, +(ordered - received).toFixed(3));
            const counting = o.status !== 'draft' && o.status !== 'approved' && o.status !== 'cancelled';
            return (
              <tr key={o.id} data-po={o.po_number} data-po-status={o.status}>
                <td className="ord-who"><NavLink href={`/purchase-orders/${o.id}`} className="row-link mono-strong">{o.po_number}</NavLink>
                  <div className="ord-no">{formatDateTime(o.created_at as Date)}{o.created_by ? <span> · {o.created_by}</span> : null}</div></td>
                <td className="ord-extra" data-label="Vendor"><Link href={`/vendors/${o.vendor_id}`}>{o.vendor}</Link><div className="note">{o.lines} line{o.lines === 1 ? '' : 's'}</div></td>
                <td className="ord-extra nowrap" data-label="Expected">{o.expected_on ? formatDay(o.expected_on) : '—'}{o.overdue && <div className="note po-late" data-overdue>Date has passed</div>}</td>
                <td className="ord-extra" data-label="Receive at">{o.location ?? online?.name ?? 'Online stock'}</td>
                <td className="num ord-extra" data-label="Received" data-po-received>{counting ? `${fmt(received)} of ${fmt(ordered)}` : <span className="note">{fmt(ordered)} ordered</span>}</td>
                <td className="num ord-extra" data-label="To come" data-po-outstanding>{o.status === 'ordered' || o.status === 'partially_received' ? <b>{fmt(left)}</b> : o.status === 'closed' && left > 0 ? <span className="note">{fmt(left)} not received</span> : '—'}</td>
                {costs && <td className="num ord-amount">{o.value === null ? '—' : formatPaise(Math.round(Number(o.value)))}</td>}
                <td className="ord-stage"><StatusBadge status={o.status} /></td>
                <td className="nowrap note ord-extra" data-label="Last updated">{formatDateTime(o.updated_at as Date)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Purchase order pages" data-pager>
          {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: page === 2 ? '' : String(page - 1) })}>← Previous</FilterLink> : <span />}
          <span className="pager-page">Page {page} of {pages} · {formatNumber(matching)} orders</span>
          {page < pages ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: String(page + 1) })}>Next →</FilterLink> : <span />}
        </nav>
      )}
      <p className="note section-foot" data-po-definitions>Received and To come are the quantities on the order&apos;s lines (pieces for products, the material&apos;s own unit for materials), added up.
        They change only when a delivery is recorded as a goods receipt, which also writes the stock ledger. {costs ? 'Order value counts the lines that have a unit cost.' : ''}</p>
    </Workspace>
  );
}
