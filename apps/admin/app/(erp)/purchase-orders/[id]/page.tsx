import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getPurchaseOrder, listMaterials, purchaseOrderProduction } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { poStatusAction, receiveGoodsAction, removePoLineAction, setPoLineAction } from '../actions';

export const metadata: Metadata = { title: 'Purchase order' };
type Params = Promise<{ id: string }>;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function PurchaseOrderPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/purchase-orders', label: 'Purchase orders' }];
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase order" crumbs={crumbs} /><Forbidden permission="procurement.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getPurchaseOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const forProduction = await purchaseOrderProduction(db(), actor, id);   // client change request: production ↔ purchasing
  const o = d.order;
  const manage = can(actor, 'procurement.manage'), receive = can(actor, 'procurement.receive');
  const draft = o.status === 'draft', open = o.status === 'ordered' || o.status === 'partially_received';
  const materials = manage && draft ? (await listMaterials(db(), actor)).filter(m => m.is_active) : [];
  return (
    <>
      <PageHead section="Supply" title={o.po_number} crumbs={crumbs} eyebrow={`${o.vendor} · created ${formatDateTime(o.created_at as Date)}${o.created_by ? ` by ${o.created_by}` : ''}`}>
        <Link className="btn ghost sm" href={`/purchase-orders/${o.id}/print`} data-link="print-po">Print PO</Link>
        <StatusBadge status={o.status} />
      </PageHead>
      {forProduction.length > 0 && <p className="note" data-po-production>Raised for production: {forProduction.map((x, i) => <span key={x.id}>{i > 0 && ', '}{can(actor, 'production.read') ? <Link href={`/production/${x.id}`}>{x.number}</Link> : x.number}</span>)}</p>}
      <div className="grid two">
        <section className="card" aria-labelledby="l-h" data-section="lines">
          <SectionTitle id="l-h">Materials</SectionTitle>
          {d.lines.length ? <div className="table-wrap"><table data-po-lines>
            <thead><tr><th>Material</th><th className="num">Ordered</th><th className="num">Received</th>{d.canSeeCosts && <th className="num">Unit cost</th>}{manage && draft && <th />}</tr></thead>
            <tbody>{d.lines.map(l => (
              <tr key={l.id} data-line={l.code}>
                <td><b>{l.name}</b><div className="note mono">{l.code}</div></td>
                <td className="num">{fmt(l.ordered)} {l.unit}</td>
                <td className="num">{fmt(l.received)} {l.unit}{l.outstanding > 0 && !draft && <div className="note">{fmt(l.outstanding)} to come</div>}</td>
                {d.canSeeCosts && <td className="num">{l.unitCostPaise == null ? '—' : rupees(l.unitCostPaise)}</td>}
                {manage && draft && <td><ActionForm action={removePoLineAction} submitLabel="Remove" variant="danger" className="inline-form" id={`rm-${l.id}`} label={`Remove ${l.name}`}>
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="lineId" value={l.id} /></ActionForm></td>}
              </tr>
            ))}</tbody>
            {d.canSeeCosts && d.totalPaise !== undefined && <tfoot><tr><td colSpan={3}>Order value (lines with a cost)</td><td className="num" data-po-total>{rupees(d.totalPaise)}</td>{manage && draft && <td />}</tr></tfoot>}
          </table></div> : <p className="note">No materials yet.</p>}
          {manage && draft && (materials.length ? (
            <ActionForm action={setPoLineAction} submitLabel="Add or update line" className="form compact" id="po-line-form" label="Add a material" resetOnSuccess>
              <Hidden name="purchaseOrderId" value={o.id} />
              <Select name="materialId" label="Material" options={materials.map(m => ({ value: m.id, label: `${m.code} · ${m.name} (${m.unit})` }))} />
              <Field name="qty" label="Quantity" required />
              {d.canSeeCosts && <Field name="unitCost" label="Unit cost, ₹ (optional)" />}
            </ActionForm>
          ) : <p className="note">Add materials first under <Link href="/materials">Materials</Link>.</p>)}
        </section>
        <aside className="side-panels">
          {manage && d.next.length > 0 && (
            <section className="card" aria-labelledby="s-h" data-section="status">
              <SectionTitle id="s-h">Order status</SectionTitle>
              {d.next.includes('ordered') && (
                <ActionForm action={poStatusAction} submitLabel="Place order" id="po-place-form" label="Place order" confirmText="Place this order with the vendor? Lines can no longer be changed.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="ordered" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('cancelled') && (
                <details className="row-edit"><summary className="btn ghost sm">Cancel order</summary>
                  <ActionForm action={poStatusAction} submitLabel="Cancel order" variant="danger" className="form compact row-edit-form" id="po-cancel-form" label="Cancel order">
                    <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="cancelled" /><Hidden name="expectedStatus" value={o.status} />
                    <Field name="note" label="Reason" required />
                  </ActionForm>
                </details>
              )}
            </section>
          )}
          {receive && open && (
            <section className="card" aria-labelledby="r-h" data-section="receive">
              <SectionTitle id="r-h">Record a delivery</SectionTitle>
              <ActionForm action={receiveGoodsAction} submitLabel="Record delivery" id="receive-form" label="Record a delivery" resetOnSuccess>
                <Hidden name="purchaseOrderId" value={o.id} />
                {d.lines.filter(l => l.outstanding > 0).map(l => (
                  <Field key={l.id} name={`received:${l.id}`} label={`${l.name} (${fmt(l.outstanding)} ${l.unit} to come)`} hint="Leave empty if none arrived." />
                ))}
                <Field name="note" label="Note (optional)" hint="e.g. the delivery challan number" />
              </ActionForm>
            </section>
          )}
          <section className="card" aria-labelledby="g-h" data-section="receipts">
            <SectionTitle id="g-h">Deliveries</SectionTitle>
            {d.receipts.length ? <ul className="plain">{d.receipts.map(g => <li key={g.id}>{formatDateTime(g.received_at as Date)} · {g.received_by ?? 'staff'}{g.note ? ` · ${g.note}` : ''}</li>)}</ul>
              : <p className="note">Nothing received yet.</p>}
          </section>
        </aside>
      </div>
    </>
  );
}
