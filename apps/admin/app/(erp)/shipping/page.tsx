import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { SHIPMENT_STATUSES, shipmentListQuery } from '@kitsyuu/contracts';
import { listCouriers, listShipments } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import ShippingNav from './ShippingNav';

export const metadata: Metadata = { title: 'Shipping' };

/* ERP module 2: shipments and their delivery status. Orders are packed and shipped from the order page (the order
   workflow); delivery updates after dispatch (in transit, failed delivery, delivered) are recorded here. */
export default async function ShipmentsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipping" /><Forbidden permission="shipping.read" /></>;
  const sp = await searchParams;
  const parsed = shipmentListQuery.safeParse({ q: one(sp.q), status: one(sp.status) || undefined, courier: one(sp.courier), page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : shipmentListQuery.parse({});
  const [list, couriers] = await Promise.all([listShipments(db(), actor, query), listCouriers(db(), actor)]);
  const qs = (p: number) => `/shipping?status=${query.status}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}${query.courier ? `&courier=${query.courier}` : ''}&page=${p}`;
  return (
    <>
      <PageHead title="Shipping" eyebrow={`${list.counts.shipped ?? 0} shipped · ${list.counts.in_transit ?? 0} in transit · ${list.counts.failed_delivery ?? 0} failed deliveries`} />
      <ShippingNav current="/shipping" />
      <FilterForm className="actions" role="search" aria-label="Filter shipments" data-shipment-filters>
        <label className="sr-only" htmlFor="sh-q">Search</label>
        <input id="sh-q" name="q" className="input" placeholder="Order no. or tracking no." defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="sh-s">Status</label>
        <select id="sh-s" name="status" className="input" defaultValue={query.status}>
          <option value="open">Open (not delivered)</option><option value="all">All</option>
          {SHIPMENT_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <label className="sr-only" htmlFor="sh-c">Courier</label>
        <select id="sh-c" name="courier" className="input" defaultValue={query.courier ?? ''}>
          <option value="">All couriers</option>{couriers.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No shipments here" kind="shipments">Shipments appear once orders are packed or shipped from their order page.</Empty> : (
        <div className="table-wrap"><table data-shipments-table>
          <thead><tr><th>Order</th><th>Status</th><th>Courier</th><th>Tracking</th><th>Deliver to</th><th>Updated</th></tr></thead>
          <tbody>{list.rows.map(s => (
            <tr key={s.id} data-shipment={s.order_number}>
              <td className="mono"><Link className="row-link" href={`/shipping/shipments/${s.id}`}>{s.order_number}</Link><div><StatusBadge status={s.order_status} /></div></td>
              <td><StatusBadge status={s.status} />{s.failure_reason && <div className="note">{s.failure_reason}</div>}</td>
              <td>{s.courier_name ?? s.carrier_code}</td>
              <td className="mono">{s.tracking_number ? (s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noopener noreferrer">{s.tracking_number}</a> : s.tracking_number) : '—'}</td>
              <td>{[s.city, s.state].filter(Boolean).join(', ') || '—'}</td>
              <td className="nowrap">{formatDateTime(s.updated_at as Date)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {query.page > 1 && <Link className="btn ghost sm" href={qs(query.page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(query.page + 1)}>Next</Link>}
      </nav>
    </>
  );
}
