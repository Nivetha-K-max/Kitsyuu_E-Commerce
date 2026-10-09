import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { SHIPMENT_STATUSES, shipmentListQuery } from '@kitsyuu/contracts';
import { listCouriers, listShipments } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { FilterLink, NavFrame, NavLink } from '@/components/NavFrame';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { StagePill } from '../orders/order-ui';
import ShippingNav from './ShippingNav';

export const metadata: Metadata = { title: 'Shipping' };
const words = (s: string) => s.replace(/_/g, ' ');
const title = (s: string) => words(s).replace(/^./, c => c.toUpperCase());

type Row = Awaited<ReturnType<typeof listShipments>>['rows'][number];
type Step = { label: string; why: string; by: 'order' | 'delivery' } | null;
/** The next fulfilment step for a shipment, from the order's status, its packing state and the delivery status (all
    existing states). It is a pointer: the step is taken, and checked, on the order's Fulfilment tab. `by` says which
    existing action does it: the order workflow (orders.update_status) or a delivery update (shipping.manage). */
function nextStep(s: Row, packing: string | null): Step {
  if (s.status === 'cancelled' || s.order_status === 'cancelled' || s.order_status === 'refunded') return null;
  if (s.status === 'delivered' || s.order_status === 'delivered') return null;
  if (s.status === 'failed_delivery') return { label: 'Record new attempt', why: s.failure_reason ? `delivery failed: ${s.failure_reason}` : 'delivery failed', by: 'delivery' };
  if (s.status === 'in_transit') return { label: 'Update delivery', why: 'in transit', by: 'delivery' };
  if (s.order_status === 'shipped') return s.tracking_number ? { label: 'Update delivery', why: 'with the courier', by: 'delivery' } : { label: 'Add tracking', why: 'shipped without a tracking number', by: 'order' };
  if (s.order_status === 'processing') return packing === 'packed' ? { label: 'Mark shipped', why: 'packed, ready for the courier', by: 'order' }
    : { label: 'Finish packing', why: packing === 'packing' ? 'being packed' : 'packing not started', by: 'order' };
  if (s.order_status === 'paid') return { label: 'Start packing', why: 'paid, not started', by: 'order' };
  return null;
}

/* Shipping: the queue of fulfilment work across orders. It finds the shipment; packing, shipping, tracking and delivery
   updates are done on the order's Fulfilment tab (one shipment record, one workflow). */
export default async function ShipmentsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipping" /><Forbidden permission="shipping.read" /></>;
  const sp = await searchParams;
  const parsed = shipmentListQuery.safeParse({ q: one(sp.q), status: one(sp.status) || undefined, courier: one(sp.courier), page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : shipmentListQuery.parse({});
  const [list, couriers] = await Promise.all([listShipments(db(), actor, query), listCouriers(db(), actor)]);
  // The packing state and the customer of the listed shipments (the shipment's own row and its order's contact).
  const ids = list.rows.map(r => r.id), orderIds = [...new Set(list.rows.map(r => r.order_id))];
  const [packs, contacts] = ids.length ? await Promise.all([
    db().selectFrom('shipments').select(['id', 'packing_state']).where('id', 'in', ids).execute(),
    db().selectFrom('orders').select(['id', 'contact']).where('id', 'in', orderIds).execute(),
  ]) : [[], []];
  const packingOf = (id: string) => packs.find(p => p.id === id)?.packing_state ?? null;
  const nameOf = (orderId: string) => { const c = (contacts.find(x => x.id === orderId)?.contact ?? {}) as { name?: string | null; email?: string | null }; return c.name || c.email || null; };
  const canOrders = can(actor, 'orders.read'), canStatus = can(actor, 'orders.update_status'), manage = can(actor, 'shipping.manage');
  const href = (change: Partial<Record<'q' | 'status' | 'courier' | 'page', string | undefined>>) => {
    const next = { q: query.q, status: query.status as string, courier: query.courier, page: undefined as string | undefined, ...change };
    const qs = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === 'status' && v === 'open')) as [string, string][]).toString();
    return qs ? `/shipping?${qs}` : '/shipping';
  };
  const open = (s: Row) => (canOrders ? `/orders/${s.order_id}?tab=fulfilment` : `/shipping/shipments/${s.id}`);
  const total = Object.values(list.counts).reduce((n, c) => n + c, 0);
  const openCount = Object.entries(list.counts).filter(([s]) => s !== 'delivered' && s !== 'cancelled').reduce((n, [, c]) => n + c, 0);
  const filtered = !!query.q || !!query.courier || query.status !== 'open';
  const chips = SHIPMENT_STATUSES.filter(s => (list.counts[s] ?? 0) > 0 || query.status === s);
  return (
    <NavFrame className="ord ws queue" data-workspace="shipping">
      <PageHead title="Shipping" eyebrow={`${openCount} open · ${list.counts.shipped ?? 0} shipped · ${list.counts.in_transit ?? 0} in transit · ${list.counts.failed_delivery ?? 0} failed deliveries`} />
      <ShippingNav current="/shipping" />
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter shipments" data-shipment-filters>
          <label className="sr-only" htmlFor="sh-q">Search</label>
          <input id="sh-q" name="q" className="input" placeholder="Search order no. or tracking no." defaultValue={query.q ?? ''} />
          {query.status !== 'open' && <input type="hidden" name="status" value={query.status} />}
          <label className="sr-only" htmlFor="sh-c">Courier</label>
          <select id="sh-c" name="courier" className="input ord-pay-filter" defaultValue={query.courier ?? ''} data-courier-filter>
            <option value="">Any courier</option>{couriers.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/shipping" data-clear-filters>Clear all</FilterLink>}
      </div>
      <nav className="ord-chipset ord-stages" aria-label="Filter by shipment status" data-shipment-status-chips>
        <span className="ord-chip-label" aria-hidden="true">Status</span>
        <FilterLink className="ord-chip" group="status" href={href({ status: 'open' })} current={query.status === 'open'} data-shipment-status-chip="open">Open<span className="ord-count">{openCount}</span></FilterLink>
        {chips.map(s => <FilterLink key={s} className="ord-chip" group="status" href={href({ status: s })} current={query.status === s} data-shipment-status-chip={s}>{title(s)}<span className="ord-count">{list.counts[s] ?? 0}</span></FilterLink>)}
        <FilterLink className="ord-chip" group="status" href={href({ status: 'all' })} current={query.status === 'all'} data-shipment-status-chip="all">All<span className="ord-count">{total}</span></FilterLink>
      </nav>
      {list.rows.length === 0 ? (
        <Empty title={total === 0 ? 'No shipments yet' : query.q || query.courier ? 'No matching shipments' : query.status === 'open' ? 'Nothing waiting to be shipped or delivered' : 'No shipments in this status'} kind="shipments"
          action={filtered ? <Link className="btn ghost" href="/shipping">Show open shipments</Link> : undefined}>
          {total === 0 ? 'A shipment appears here once an order is being packed or has shipped.'
            : query.q || query.courier ? 'No shipment matches these filters.' : query.status === 'open' ? 'Every shipment has been delivered or cancelled.' : 'Choose another status above.'}
        </Empty>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={href({ page: String(query.page) })}><table data-shipments-table>
          <thead><tr><th>Shipment for</th><th>Courier &amp; tracking</th><th>Status</th><th>Deliver to</th><th>Updated (IST)</th><th>Next step</th></tr></thead>
          <tbody>{list.rows.map(s => {
            const packing = packingOf(s.id), n = nextStep(s, packing);
            const actionable = !!n && (n.by === 'order' ? canStatus : manage);
            const dispatched = !!s.shipped_at;
            return (
              <tr key={s.id} data-shipment={s.order_number} data-shipment-state={s.status}>
                <td className="ord-who"><NavLink prefetch className="row-link" href={open(s)} aria-label={`Shipment of order ${s.order_number}`}>{nameOf(s.order_id) ?? 'No customer details'}</NavLink>
                  <div className="ord-no"><span className="mono">{s.order_number}</span></div></td>
                <td className="ord-items">{dispatched ? s.courier_name ?? s.carrier_code : <span className="note">not shipped yet</span>}
                  {dispatched && <div className="note">{s.tracking_number ? (s.tracking_url ? <a className="mono" href={s.tracking_url} target="_blank" rel="noopener noreferrer">{s.tracking_number}</a> : <span className="mono">{s.tracking_number}</span>) : 'no tracking number'}</div>}</td>
                <td className="ord-stage">{['in_transit', 'failed_delivery', 'cancelled'].includes(s.status) ? <StatusBadge status={s.status} /> : <StagePill status={s.order_status} packingState={packing} />}
                  {n?.why && <div className="note" data-shipment-why>{n.why}</div>}</td>
                <td className="ord-extra" data-label="Deliver to">{[s.city, s.state].filter(Boolean).join(', ') || '—'}</td>
                <td className="nowrap ord-placed">{formatDateTime(s.updated_at as Date)}{s.shipped_at && <div className="note">shipped {formatDateTime(s.shipped_at as Date)}</div>}</td>
                <td className="ord-next" data-next-step>{actionable && canOrders
                  ? <NavLink className="btn sm" href={open(s)} aria-label={`${n!.label}: order ${s.order_number}`}>{n!.label}<span aria-hidden="true"> →</span></NavLink>
                  : <NavLink className="btn ghost sm" href={open(s)} aria-label={`View shipment of order ${s.order_number}`}>View</NavLink>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {(query.page > 1 || list.hasNext) && (
        <nav className="pager" aria-label="Shipment pages">
          {query.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page - 1) })}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {list.hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page + 1) })}>Older →</FilterLink> : <span />}
        </nav>
      )}
    </NavFrame>
  );
}
