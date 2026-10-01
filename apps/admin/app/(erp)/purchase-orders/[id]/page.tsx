import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getPurchaseOrder, listMaterials, purchasableSizes, purchaseOrderProduction } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { poStatusAction, receiveGoodsAction, removePoLineAction, setPoLineAction } from '../actions';

export const metadata: Metadata = { title: 'Purchase order' };
type Params = Promise<{ id: string }>;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* A purchase order (finished products and / or materials). Steps: draft → approved → sent (ordered) → partly received →
   received → closed; each delivery is a numbered goods receipt (GRN) with its own page and print-out. */
export default async function PurchaseOrderPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/purchase-orders', label: 'Purchase orders' }];
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase order" crumbs={crumbs} /><Forbidden permission="procurement.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getPurchaseOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const forProduction = await purchaseOrderProduction(db(), actor, id);   // client change request: production ↔ purchasing
  const o = d.order;
  const manage = can(actor, 'procurement.manage'), receive = can(actor, 'procurement.receive'), approve = can(actor, 'procurement.approve');
  const draft = o.status === 'draft', open = o.status === 'ordered' || o.status === 'partially_received';
  const [materials, sizes] = manage && draft
    ? await Promise.all([listMaterials(db(), actor).then(m => m.filter(x => x.is_active)), purchasableSizes(db(), actor, o.vendor_id)])
    : [[], []];
  const items = [...sizes.map(s => ({ value: `v:${s.id}`, label: `${s.label} (${s.sku})${s.supplied ? ' · supplied by this vendor' : ''}` })),
    ...materials.map(m => ({ value: `m:${m.id}`, label: `Material: ${m.code} · ${m.name} (${m.unit})` }))];
  const remaining = d.lines.reduce((n, l) => n + l.outstanding, 0);
  return (
    <>
      <PageHead section="Supply" title={o.po_number} crumbs={crumbs} eyebrow={`${o.vendor} · created ${formatDateTime(o.created_at as Date)}${o.created_by ? ` by ${o.created_by}` : ''}`}>
        <Link className="btn ghost sm" href={`/purchase-orders/${o.id}/print`} data-link="print-po">Print / PDF</Link>
        <StatusBadge status={o.status} />
      </PageHead>
      <dl className="facts" data-po-meta>
        <dt>Receive at</dt><dd>{o.location}</dd>
        {o.expected_on && <><dt>Expected</dt><dd>{String(o.expected_on)}</dd></>}
        {o.approved_at && <><dt>Approved</dt><dd>{formatDateTime(o.approved_at as Date)}{o.approved_by ? ` · ${o.approved_by}` : ''}</dd></>}
        {o.ordered_at && <><dt>Sent to the vendor</dt><dd>{formatDateTime(o.ordered_at as Date)}</dd></>}
        {o.closed_at && <><dt>Closed</dt><dd>{formatDateTime(o.closed_at as Date)}{o.closed_by ? ` · ${o.closed_by}` : ''}{o.close_note ? ` · ${o.close_note}` : ''}</dd></>}
      </dl>
      {forProduction.length > 0 && <p className="note" data-po-production>Linked production: {forProduction.map((x, i) => <span key={x.id}>{i > 0 && ', '}{can(actor, 'production.read') ? <Link href={`/production/${x.id}`}>{x.number}</Link> : x.number}</span>)}</p>}
      <div className="grid two">
        <section className="card" aria-labelledby="l-h" data-section="lines">
          <SectionTitle id="l-h">Items</SectionTitle>
          {d.lines.length ? <div className="table-wrap"><table data-po-lines>
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Remaining</th>{d.canSeeCosts && <th className="num">Unit cost</th>}{manage && draft && <th />}</tr></thead>
            <tbody>{d.lines.map(l => (
              <tr key={l.id} data-line={l.code} data-line-kind={l.kind}>
                <td><b>{l.name}</b><div className="note mono">{l.kind === 'product' ? 'Product' : 'Material'} · {l.code}</div></td>
                <td className="num">{fmt(l.ordered)} {l.unit}</td>
                <td className="num" data-received>{fmt(l.received)} {l.unit}</td>
                <td className="num" data-remaining>{fmt(l.outstanding)} {l.unit}{l.outstanding > 0 && !draft ? <div className="note">to come</div> : null}</td>
                {d.canSeeCosts && <td className="num">{l.unitCostPaise == null ? '—' : rupees(l.unitCostPaise)}</td>}
                {manage && draft && <td><ActionForm action={removePoLineAction} submitLabel="Remove" variant="danger" className="inline-form" id={`rm-${l.id}`} label={`Remove ${l.name}`}>
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="lineId" value={l.id} /></ActionForm></td>}
              </tr>
            ))}</tbody>
            {d.canSeeCosts && d.totalPaise !== undefined && <tfoot><tr><td colSpan={4}>Order value (lines with a cost)</td><td className="num" data-po-total>{rupees(d.totalPaise)}</td>{manage && draft && <td />}</tr></tfoot>}
          </table></div> : <p className="note">No items yet.</p>}
          {manage && draft && (items.length ? (
            <ActionForm action={setPoLineAction} submitLabel="Add or update line" className="form compact" id="po-line-form" label="Add an item" resetOnSuccess>
              <Hidden name="purchaseOrderId" value={o.id} />
              <Select name="item" label="Product size or material" options={items} />
              <Field name="qty" label="Quantity" required />
              {d.canSeeCosts && <Field name="unitCost" label="Unit cost, ₹ (optional)" />}
            </ActionForm>
          ) : <p className="note">Add products or materials first.</p>)}
        </section>
        <aside className="side-panels">
          {manage && d.next.length > 0 && (
            <section className="card" aria-labelledby="s-h" data-section="status">
              <SectionTitle id="s-h">Order status</SectionTitle>
              {d.next.includes('approved') && approve && (
                <ActionForm action={poStatusAction} submitLabel="Approve" id="po-approve-form" label="Approve the order" confirmText="Approve this purchase order? It can then be sent to the vendor.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="approved" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('ordered') && (o.status === 'approved' || approve) && (
                <ActionForm action={poStatusAction} submitLabel={o.status === 'draft' ? 'Approve and send to vendor' : 'Mark as sent to vendor'} id="po-place-form" label="Send to the vendor"
                  confirmText="Send this order to the vendor? Lines can no longer be changed.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="ordered" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {draft && !approve && <p className="note" data-po-needs-approval>An approver (procurement.approve) approves the order before it is sent.</p>}
              {d.next.includes('draft') && (
                <ActionForm action={poStatusAction} submitLabel="Back to draft" variant="ghost" id="po-reopen-form" label="Back to draft">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="draft" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('closed') && approve && (
                <details className="row-edit" open={o.status === 'received' || undefined}><summary className="btn ghost sm">Close order</summary>
                  <ActionForm action={poStatusAction} submitLabel="Close order" className="form compact row-edit-form" id="po-close-form" label="Close order"
                    confirmText={remaining > 0 ? 'Close the order? Nothing more will be received on it.' : 'Close the order?'}>
                    <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="closed" /><Hidden name="expectedStatus" value={o.status} />
                    <Field name="note" label={remaining > 0 ? 'Reason (part of it has not arrived)' : 'Note (optional)'} required={remaining > 0} />
                  </ActionForm>
                </details>
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
              <SectionTitle id="r-h">Record goods received</SectionTitle>
              <p className="note">Enter only what physically arrived; products go into stock at {o.location}. Each delivery gets its own goods receipt number.</p>
              <ActionForm action={receiveGoodsAction} submitLabel="Record goods received" id="receive-form" label="Record goods received" resetOnSuccess>
                <Hidden name="purchaseOrderId" value={o.id} />
                {d.lines.filter(l => l.outstanding > 0).map(l => (
                  <Field key={l.id} name={`received:${l.id}`} label={`${l.name} (${fmt(l.outstanding)} ${l.unit} to come)`} hint="Leave empty if none arrived." />
                ))}
                <Field name="vendorRef" label="Vendor's delivery note / invoice no. (optional)" />
                <Field name="note" label="Note (optional)" />
              </ActionForm>
            </section>
          )}
          <section className="card" aria-labelledby="g-h" data-section="receipts">
            <SectionTitle id="g-h">Goods received</SectionTitle>
            {d.receipts.length ? <ul className="plain" data-po-receipts>{d.receipts.map(g => (
              <li key={g.id} data-receipt={g.receipt_number ?? ''}>
                {g.receipt_number ? <Link href={`/purchase-orders/${o.id}/receipts/${g.id}`} className="mono-strong">{g.receipt_number}</Link> : 'Delivery'} · {formatDateTime(g.received_at as Date)} · {g.received_by ?? 'staff'}
                {g.location_name ? ` · ${g.location_name}` : ''}{g.vendor_ref ? ` · ref ${g.vendor_ref}` : ''}
                {g.items && <div className="note">{g.items}</div>}{g.note && <div className="note">{g.note}</div>}
              </li>))}</ul>
              : <p className="note">Nothing received yet.</p>}
          </section>
        </aside>
      </div>
    </>
  );
}
