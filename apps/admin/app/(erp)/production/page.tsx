/* Production (2026-10-08: on the shared workspace frame).
   One row per production order: which piece and size, how many are planned, and (once the quality check has completed
   it) how many passed into stock and how many were rejected. The views are the order's real statuses:
   planned → in progress → completed (by recording the quality check) / cancelled. Manufacturing stages are not modelled.
   An order is completed once, by one quality check: there is no partial output, so an open order has made nothing yet
   and a completed one shows what it made. Planning is on its own page (/production/new); nothing here changes stock.
   Several open orders can be ticked and linked to a purchase order (a record of what was bought for them; no stock moves). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listProductionOrders, listPurchaseOrders } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { ActionForm, Select } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { linkProductionPoAction } from './actions';

export const metadata: Metadata = { title: 'Production' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_TAB: Record<Status, string> = { planned: 'Planned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const PAGE_SIZE = 50;

export default async function ProductionPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production" /><Forbidden permission="production.read" /></>;
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(one(sp.status) ?? '') ? one(sp.status) as Status : undefined;
  const batch = typeof sp.batch === 'string' && sp.batch.length <= 40 ? sp.batch : undefined;
  const q = (one(sp.q) ?? '').trim().slice(0, 80);
  const manage = can(actor, 'production.manage');
  const linkable = manage && can(actor, 'procurement.read');
  const [all, pos] = await Promise.all([listProductionOrders(db(), actor, { batch }), linkable ? listPurchaseOrders(db(), actor, {}) : Promise.resolve([])]);
  const needle = q.toLowerCase();
  const matching = all.filter(o => !needle || [o.number, o.product, o.variant_sku, o.sku, o.batch_ref, o.purchase_orders].some(x => x?.toLowerCase().includes(needle)));
  const countOf = (s: Status) => matching.filter(o => o.status === s).length;
  const rows = matching.filter(o => !status || o.status === status);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const openPos = pos.filter(p => p.status !== 'cancelled' && p.status !== 'closed');
  const selectable = linkable && openPos.length > 0 && shown.some(o => o.status === 'planned' || o.status === 'in_progress');
  const filtered = !!(q || status || batch);
  const link = (patch: Record<string, string>) => {
    const next = { status: status ?? '', q, batch: batch ?? '', page: '', ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
    return qs ? `/production?${qs}` : '/production';
  };
  const open = all.filter(o => o.status === 'planned' || o.status === 'in_progress').length;

  return (
    <Workspace name="production" title="Production"
      summary={`${formatNumber(all.length)} order${all.length === 1 ? '' : 's'}${open ? ` · ${formatNumber(open)} open` : ''}`}
      actions={manage ? <Link className="btn" href="/production/new" data-link="new-production">Plan production</Link> : undefined}>
      <div data-production-tabs>
        <ViewTabs label="Production status" current={status ?? 'all'}
          items={[{ id: 'all', label: 'All', href: link({ status: '' }) }, ...STATUSES.map(s => ({ id: s, label: STATUS_TAB[s], href: link({ status: s }), count: countOf(s) }))]} />
      </div>
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter production orders" data-production-filters>
          {status && <input type="hidden" name="status" value={status} />}
          {batch && <input type="hidden" name="batch" value={batch} />}
          <label className="sr-only" htmlFor="pr-q">Search</label>
          <input id="pr-q" name="q" className="input" placeholder="Search order, piece, SKU, batch or purchase order" defaultValue={q} />
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/production" data-clear-filters>Clear</FilterLink>}
      </div>
      {batch && <p className="note" data-production-batch>Batch {batch} · <Link href="/production">show all</Link></p>}
      {shown.length === 0 ? (
        <StateBlock title={filtered ? 'No matching production orders' : 'No production orders yet'} name="production"
          action={filtered ? <Link className="btn ghost sm" href="/production">Show all orders</Link> : manage ? <Link className="btn ghost sm" href="/production/new">Plan production</Link> : undefined}>
          {filtered ? 'No production order matches these filters.' : 'Plan how many pieces of a size to make. Passed pieces enter stock when the quality check completes the order.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={link({ page: String(page) })}><table data-production-table>
          <thead><tr>{selectable && <th><span className="sr-only">Select</span></th>}<th>Order</th><th>Piece</th><th className="num">Planned</th><th className="num">Passed into stock</th><th className="num">Rejected</th><th>Batch · purchase orders</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{shown.map(o => (
            <tr key={o.id} data-production={o.number} data-production-status={o.status}>
              {selectable && <td className="ord-extra" data-label="Select to link">{(o.status === 'planned' || o.status === 'in_progress') &&
                <input type="checkbox" name="productionOrderIds[]" value={o.id} form="link-production-form" aria-label={`Select ${o.number}`} />}</td>}
              <td className="ord-who"><NavLink href={`/production/${o.id}`} className="row-link mono-strong">{o.number}</NavLink><div className="ord-no">{formatDateTime(o.created_at as Date)}</div></td>
              <td className="ord-extra" data-label="Piece">{o.product}<div className="note mono">{o.variant_sku} · {o.size}</div></td>
              <td className="num ord-amount" data-planned>{o.qty_planned}</td>
              <td className="num ord-extra" data-label="Passed into stock" data-passed>{o.qty_passed === null ? '—' : `${o.qty_passed} of ${o.qty_planned}`}</td>
              <td className="num ord-extra" data-label="Rejected">{o.qty_rejected === null ? '—' : o.qty_rejected}</td>
              <td className="ord-extra" data-label="Batch · purchase orders" data-production-links>{o.batch_ref ? <Link href={`/production?batch=${encodeURIComponent(o.batch_ref)}`} className="mono">{o.batch_ref}</Link> : '—'}
                {o.purchase_orders && <div className="note">{o.purchase_orders}</div>}</td>
              <td className="ord-extra nowrap" data-label="Due">{o.due_on ? formatDay(o.due_on) : '—'}</td>
              <td className="ord-stage"><StatusBadge status={o.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Production pages" data-pager>
          {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: page === 2 ? '' : String(page - 1) })}>← Previous</FilterLink> : <span />}
          <span className="pager-page">Page {page} of {pages} · {formatNumber(rows.length)} orders</span>
          {page < pages ? <FilterLink className="btn ghost sm" group="page" current={false} href={link({ page: String(page + 1) })}>Next →</FilterLink> : <span />}
        </nav>
      )}
      {selectable && (
        <section className="card form-panel" aria-labelledby="lpo-h" data-section="link-production">
          <h2 id="lpo-h">Link selected to a purchase order</h2>
          <p className="note">Tick planned or in-progress orders above. The link only records what was bought for them; it moves no stock and makes nothing wait.</p>
          <ActionForm action={linkProductionPoAction} submitLabel="Link selected" className="form compact" id="link-production-form" label="Link to a purchase order">
            <Select name="purchaseOrderId" label="Purchase order" options={[{ value: '', label: 'Choose…' }, ...openPos.map(p => ({ value: p.id, label: `${p.po_number} · ${p.vendor} · ${p.status.replace(/_/g, ' ')}` }))]} />
          </ActionForm>
        </section>
      )}
      <p className="note section-foot" data-production-definitions>An order is completed by its quality check: the pieces that pass enter the online store&apos;s stock through the stock ledger, rejected pieces never do.
        Until then an order has added nothing to stock.</p>
    </Workspace>
  );
}
