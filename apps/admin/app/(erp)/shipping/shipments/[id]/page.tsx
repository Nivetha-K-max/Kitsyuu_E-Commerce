import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getShipmentDetail, listCouriers, SHIPMENT_MOVES } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { updateShipmentAction } from '../../actions';

export const metadata: Metadata = { title: 'Shipment' };

export default async function ShipmentPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/shipping', label: 'Shipping' }];
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipment" crumbs={crumbs} /><Forbidden permission="shipping.read" /></>;
  const { id } = await params;
  let data;
  try { data = await getShipmentDetail(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { shipment: s, events } = data;
  const couriers = (await listCouriers(db(), actor)).filter(c => c.is_active || c.code === s.carrier_code);
  const moves = SHIPMENT_MOVES[s.status] ?? [];
  const ship = (s.shipping_address ?? {}) as Record<string, string | null>;
  const manage = can(actor, 'shipping.manage');
  return (
    <>
      <PageHead title={`Shipment · ${s.order_number}`} crumbs={crumbs} eyebrow={`Order ${s.order_status.replace(/_/g, ' ')} · ${s.courier_name ?? s.carrier_code}`}>
        {can(actor, 'orders.read') && <Link className="btn ghost" href={`/orders/${s.order_id}`}>Open order</Link>}
      </PageHead>
      <div className="grid-2">
        <section className="card" aria-labelledby="sd-h" data-section="shipment">
          <h2 id="sd-h">Delivery</h2>
          <dl className="dl-grid">
            <dt>Status</dt><dd><StatusBadge status={s.status} /></dd>
            <dt>Courier</dt><dd>{s.courier_name ?? s.carrier_code}</dd>
            <dt>Tracking</dt><dd className="mono">{s.tracking_number ? (s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noopener noreferrer">{s.tracking_number}</a> : s.tracking_number) : '—'}</dd>
            <dt>Shipped</dt><dd>{formatDateTime(s.shipped_at as Date)}</dd>
            <dt>In transit</dt><dd>{formatDateTime(s.in_transit_at as Date)}</dd>
            <dt>Delivered</dt><dd>{formatDateTime(s.delivered_at as Date)}</dd>
            {s.failed_at && <><dt>Delivery failed</dt><dd>{formatDateTime(s.failed_at as Date)} — {s.failure_reason}</dd></>}
            <dt>Deliver to</dt><dd>{[ship.name ?? ship.full_name, ship.line1, ship.line2, ship.city, ship.state, ship.pin].filter(Boolean).join(', ')}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="su-h" data-section="shipment-update">
          <h2 id="su-h">Update</h2>
          {!manage ? <p className="note">Updating shipments needs shipping.manage.</p>
            : ['pending', 'processing', 'packed'].includes(s.status) ? <p className="note">Pack and ship this order from its order page; delivery updates start once it has shipped.</p>
            : (
              <ActionForm action={updateShipmentAction} submitLabel="Save update" id="shipment-update-form" label="Update shipment">
                <Hidden name="shipmentId" value={s.id} />
                <Select name="status" label="Status" defaultValue={s.status} options={[{ value: s.status, label: `${s.status.replace(/_/g, ' ')} (no change)` },
                  ...moves.map(m => ({ value: m, label: m === 'delivered' ? 'delivered (also marks the order delivered)' : m === 'in_transit' && s.status === 'failed_delivery' ? 'in transit (new delivery attempt)' : m.replace(/_/g, ' ') }))]} />
                <Select name="courierCode" label="Courier" defaultValue={s.carrier_code} options={couriers.map(c => ({ value: c.code, label: c.name }))} />
                <Field name="trackingNumber" label="Tracking number" defaultValue={s.tracking_number ?? ''} />
                <Field name="failureReason" label="Why the delivery failed" hint="Needed when marking a failed delivery." />
                <TextArea name="note" label="Note (staff only)" rows={2} />
              </ActionForm>
            )}
        </section>
      </div>
      <section className="card" aria-labelledby="se-h" data-section="shipment-events">
        <h2 id="se-h">History</h2>
        {events.length === 0 ? <p className="note">No events recorded yet.</p> : (
          <ol className="timeline">{events.map(e => (
            <li key={e.id}><StatusBadge status={e.status} /> <span className="who">{formatDateTime(e.created_at as Date)} · {e.staff_email ?? e.source}</span>{e.note && <p className="msg-body">{e.note}</p>}</li>
          ))}</ol>
        )}
      </section>
    </>
  );
}
