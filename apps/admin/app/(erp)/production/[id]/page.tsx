import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getProductionOrder, listMaterials, listVendors, productionMaterialNeeds } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { consumeMaterialAction, productionInputAction, productionStatusAction, qualityCheckAction, raiseProductionPoAction } from '../actions';

export const metadata: Metadata = { title: 'Production order' };
/** Procurement status of a production order (client change request; see core procurementStatus). */
const PROCUREMENT: Record<string, string> = { no_plan: 'no materials planned', in_stock: 'covered by stock', not_ordered: 'NOT ORDERED (short, no purchase order)',  partially_ordered: 'PARTIALLY ORDERED (part of the shortfall is on order)', ordered: 'ORDERED (the shortfall is on order)', received: 'RECEIVED' };
type Params = Promise<{ id: string }>;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default async function ProductionOrderPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/production', label: 'Production' }];
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production order" crumbs={crumbs} /><Forbidden permission="production.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getProductionOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const o = d.order;
  const manage = can(actor, 'production.manage');
  const open = o.status === 'planned' || o.status === 'in_progress';
  const materials = manage && open && can(actor, 'procurement.read') ? (await listMaterials(db(), actor)).filter(m => m.is_active) : [];
  // Client change request: what still has to be bought for this order, and the purchase orders raised for it.
  const needs = can(actor, 'procurement.read') ? await productionMaterialNeeds(db(), actor, o.id) : null;
  const canBuy = !!needs && open && can(actor, 'procurement.manage');
  const vendors = canBuy ? (await listVendors(db(), actor)).filter(v => v.is_active) : [];
  const short = needs?.needs.filter(n => n.active && (n.shortfall ?? 0) > 0) ?? [];
  return (
    <>
      <PageHead section="Supply" title={o.number} crumbs={crumbs} eyebrow={`${o.product} · ${o.variant_sku} · size ${o.size} · ${o.qty_planned} piece(s) planned`}>
        <StatusBadge status={o.status} />
      </PageHead>
      {o.status === 'cancelled' && <p className="msg" data-cancelled>Cancelled{o.cancel_note ? `: ${o.cancel_note}` : '.'}</p>}
      <div className="grid two">
        <section className="card" aria-labelledby="in-h" data-section="inputs">
          <SectionTitle id="in-h">Materials</SectionTitle>
          {d.inputs.length ? <div className="table-wrap"><table data-production-inputs>
            <thead><tr><th>Material</th><th className="num">Planned</th><th className="num">Used</th><th className="num">In stock</th></tr></thead>
            <tbody>{d.inputs.map(i => (
              <tr key={i.id} data-input={i.code}>
                <td><b>{i.name}</b><div className="note mono">{i.code}</div></td>
                <td className="num">{i.planned === null ? '—' : `${fmt(i.planned)} ${i.unit}`}</td>
                <td className="num">{fmt(i.consumed)} {i.unit}</td>
                <td className="num">{fmt(i.stock)} {i.unit}</td>
              </tr>
            ))}</tbody>
          </table></div> : <p className="note">No materials recorded.</p>}
          {manage && open && materials.length > 0 && (
            <ActionForm action={productionInputAction} submitLabel="Plan material" className="form compact" id="production-input-form" label="Plan a material" resetOnSuccess>
              <Hidden name="productionOrderId" value={o.id} />
              <Select name="materialId" label="Material" options={materials.map(m => ({ value: m.id, label: `${m.code} · ${m.name} (${fmt(m.stock)} ${m.unit} in stock)` }))} />
              <Field name="qtyPlanned" label="Planned quantity (optional)" />
            </ActionForm>
          )}
          {manage && o.status === 'in_progress' && materials.length > 0 && (
            <ActionForm action={consumeMaterialAction} submitLabel="Record material used" className="form compact" id="consume-form" label="Record material used" resetOnSuccess>
              <Hidden name="productionOrderId" value={o.id} />
              <Select name="materialId" label="Material" options={materials.map(m => ({ value: m.id, label: `${m.code} · ${m.name} (${fmt(m.stock)} ${m.unit} in stock)` }))} />
              <Field name="qty" label="Quantity used" required />
            </ActionForm>
          )}
          {manage && open && materials.length === 0 && can(actor, 'procurement.read') && <p className="note">Add materials under <Link href="/materials">Materials</Link> to record what production uses.</p>}
        </section>
        <aside className="side-panels">
          {manage && d.next.length > 0 && (
            <section className="card" aria-labelledby="st-h" data-section="status">
              <SectionTitle id="st-h">Status</SectionTitle>
              {d.next.includes('in_progress') && (
                <ActionForm action={productionStatusAction} submitLabel="Start production" id="production-start-form" label="Start production">
                  <Hidden name="productionOrderId" value={o.id} /><Hidden name="status" value="in_progress" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('cancelled') && (
                <details className="row-edit"><summary className="btn ghost sm">Cancel production</summary>
                  <ActionForm action={productionStatusAction} submitLabel="Cancel" variant="danger" className="form compact row-edit-form" id="production-cancel-form" label="Cancel production">
                    <Hidden name="productionOrderId" value={o.id} /><Hidden name="status" value="cancelled" /><Hidden name="expectedStatus" value={o.status} />
                    <Field name="note" label="Reason" required />
                  </ActionForm>
                </details>
              )}
            </section>
          )}
          {d.canQc && (
            <section className="card" aria-labelledby="qc-h" data-section="qc">
              <SectionTitle id="qc-h">Quality check and completion</SectionTitle>
              <p className="note">Passed pieces are added to stock of size {o.size}. Rejected pieces are recorded and never enter stock.</p>
              <ActionForm action={qualityCheckAction} submitLabel="Complete production" id="qc-form" label="Quality check" confirmText="Complete this production order? Passed pieces go into stock; this cannot be undone.">
                <Hidden name="productionOrderId" value={o.id} />
                <Field name="passed" label="Pieces passed" type="number" defaultValue={String(o.qty_planned)} required />
                <Field name="rejected" label="Pieces rejected" type="number" defaultValue="0" required />
                <Field name="rejectReason" label="Reason for rejections" hint="Required when pieces are rejected." />
                <Field name="note" label="Note (optional)" />
              </ActionForm>
            </section>
          )}
          {d.qc && (
            <section className="card" aria-labelledby="qr-h" data-section="qc-result">
              <SectionTitle id="qr-h">Quality check</SectionTitle>
              <dl className="kv" data-qc-result>
                <div><dt>Passed (added to stock)</dt><dd>{d.qc.qty_passed}</dd></div>
                <div><dt>Rejected</dt><dd>{d.qc.qty_rejected}{d.qc.reject_reason ? ` — ${d.qc.reject_reason}` : ''}</dd></div>
                <div><dt>Checked</dt><dd>{formatDateTime(d.qc.inspected_at as Date)}{d.qc.inspected_by ? ` by ${d.qc.inspected_by}` : ''}</dd></div>
              </dl>
            </section>
          )}
          <section className="card" aria-labelledby="pi-h" data-section="piece">
            <SectionTitle id="pi-h">Piece</SectionTitle>
            <p><Link href={`/products/${o.product_id}`}>{o.product}</Link> · size {o.size}</p>
            <p className="note">Current stock of this size: {o.stock_qty}. Created {formatDateTime(o.created_at as Date)}{o.created_by ? ` by ${o.created_by}` : ''}.</p>
          </section>
        </aside>
      </div>
      {needs && (
        <section className="card" aria-labelledby="buy-h" data-section="materials-to-buy">
          <SectionTitle id="buy-h">Materials to buy</SectionTitle>
          <p data-procurement-status={needs.procurement}><b>Procurement:</b> {PROCUREMENT[needs.procurement]}</p>
          <p className="note">Still needed = planned − used. Short = still needed − in stock − already on order for this production order. Materials with no planned quantity are not counted.</p>
          {needs.needs.length === 0 ? <p className="note">No materials are planned for this order.</p> : (
            <div className="table-wrap"><table data-material-needs>
              <thead><tr><th>Material</th><th className="num">Still needed</th><th className="num">In stock</th><th className="num">On order</th><th className="num">Short</th></tr></thead>
              <tbody>{needs.needs.map(n => (
                <tr key={n.materialId} data-need={n.code}><td>{n.code} · {n.name}</td><td className="num">{n.remaining === null ? '—' : `${fmt(n.remaining)} ${n.unit}`}</td>
                  <td className="num">{fmt(n.stock)}</td><td className="num">{fmt(n.onOrder)}</td><td className="num">{n.shortfall === null ? '—' : <b>{fmt(n.shortfall)}</b>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {needs.linked.length > 0 && (
            <div className="table-wrap spaced"><table data-linked-pos>
              <thead><tr><th>Purchase order</th><th>Vendor</th><th>Status</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Remaining</th></tr></thead>
              <tbody>{needs.linked.map(l => (
                <tr key={l.id}><td><Link href={`/purchase-orders/${l.id}`}>{l.po_number}</Link></td><td>{l.vendor}</td><td>{l.status.replace(/_/g, ' ')}</td>
                  <td className="num">{l.ordered}</td><td className="num">{l.received}</td><td className="num">{l.remaining}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {canBuy && short.length > 0 && (vendors.length === 0 ? <p className="note">Add a vendor under <Link href="/vendors">Vendors</Link> to raise a purchase order.</p> : (
            <ActionForm action={raiseProductionPoAction} submitLabel="Raise draft purchase order" id="raise-po-form" label="Raise purchase order"
              confirmText="Create a draft purchase order for these materials? You can still change it before placing it with the vendor.">
              <Hidden name="productionOrderId" value={o.id} />
              <Select name="vendorId" label="Vendor" options={vendors.map(v => ({ value: v.id, label: v.name }))} />
              {short.map(n => (
                <div key={n.materialId} className="field">
                  <Hidden name="materialIds[]" value={n.materialId} />
                  <label htmlFor={`q-${n.materialId}`}>{n.code} · {n.name} ({n.unit})</label>
                  <input id={`q-${n.materialId}`} name="qtys[]" className="input" inputMode="decimal" defaultValue={String(n.shortfall)} />
                </div>
              ))}
              <Field name="notes" label="Note on the purchase order (optional)" />
            </ActionForm>
          ))}
        </section>
      )}
    </>
  );
}
