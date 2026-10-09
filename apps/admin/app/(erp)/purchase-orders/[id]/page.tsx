/* One purchase order (2026-10-08: on the shared entity frame, like an order or a product).

     header  number, status, vendor, where it is received, how much has arrived; Print and the next thing to do
     tabs    Overview · Items · Receiving · Documents · Activity

   The order, its steps and its rules are core's and unchanged: draft → approved → sent (ordered) → partly received →
   received → closed, or cancelled. Ordered / received / remaining are the order's own lines; only a goods receipt (GRN)
   changes "received", and the same transaction writes the stock ledger: product sizes into stock at the order's location
   (inventory_movements, reason purchase_in, linked to the receipt), materials into material stock (material_movements).
   This page never changes stock itself. Receiving shows each receipt and the ledger rows it wrote, so a delivery can be
   followed from the order to the receipt to the stock movement to the location. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getPurchaseOrder, listMaterials, purchasableSizes, purchaseOrderProduction } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Entity, Facts, Figures, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { poStatusAction, receiveGoodsAction, removePoLineAction, setPoLineAction } from '../actions';

export const metadata: Metadata = { title: 'Purchase order' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['overview', 'Overview'], ['items', 'Items'], ['receiving', 'Receiving'], ['documents', 'Documents'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const NEXT: Record<string, string> = {
  draft: 'A draft. Check the items, then an approver approves it and it is sent to the vendor.',
  approved: 'Approved. Send it to the vendor; after that its items can no longer be changed.',
  ordered: 'Sent to the vendor. Record each delivery under Receiving as it arrives.',
  partially_received: 'Part of the order has arrived. Record the rest under Receiving, or close the order if nothing more is coming.',
  received: 'Everything ordered has arrived. Close the order when it is settled.',
  closed: 'Closed. Nothing more can be received on it.',
  cancelled: 'Cancelled. It added nothing to stock.',
};

export default async function PurchaseOrderPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/purchase-orders', label: 'Purchase orders' }];
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase order" crumbs={crumbs} /><Forbidden permission="procurement.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getPurchaseOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const o = d.order;
  const manage = can(actor, 'procurement.manage'), receive = can(actor, 'procurement.receive'), approve = can(actor, 'procurement.approve');
  const seeAudit = can(actor, 'audit.read'), seeStock = can(actor, 'inventory.read'), seeProduction = can(actor, 'production.read');
  const tabs = TABS.filter(t => t[0] !== 'activity' || seeAudit);
  const tab: Tab = tabs.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const self = `/purchase-orders/${o.id}`;
  const href = (t: string) => (t === 'overview' ? self : `${self}?tab=${t}`);
  const draft = o.status === 'draft', open = o.status === 'ordered' || o.status === 'partially_received';
  const ordered = d.lines.reduce((n, l) => n + l.ordered, 0), received = d.lines.reduce((n, l) => n + l.received, 0);
  const remaining = Math.max(0, +(ordered - received).toFixed(3));
  const counting = !draft && o.status !== 'approved' && o.status !== 'cancelled';
  const lineState = (l: (typeof d.lines)[number]) => (l.received <= 0 ? 'Not received' : l.outstanding > 0 ? 'Partly received' : 'Fully received');

  const forProduction = tab === 'overview' ? await purchaseOrderProduction(db(), actor, id) : [];
  const [materials, sizes] = tab === 'items' && manage && draft
    ? await Promise.all([listMaterials(db(), actor).then(m => m.filter(x => x.is_active)), purchasableSizes(db(), actor, o.vendor_id)]) : [[], []];
  const items = [...sizes.map(s => ({ value: `v:${s.id}`, label: `${s.label} (${s.sku})${s.supplied ? ' · supplied by this vendor' : ''}` })),
    ...materials.map(m => ({ value: `m:${m.id}`, label: `Material: ${m.code} · ${m.name} (${m.unit})` }))];
  // Receiving: the ledger rows the receipts wrote (read-only), so a delivery can be followed into stock.
  const receiptIds = d.receipts.map(g => g.id);
  const [stockMoves, materialMoves] = tab === 'receiving' && receiptIds.length ? await Promise.all([
    db().selectFrom('inventory_movements as m').innerJoin('product_variants as v', 'v.id', 'm.variant_id').innerJoin('goods_receipts as g', 'g.id', 'm.goods_receipt_id')
      .leftJoin('locations as l', 'l.id', 'm.location_id')
      .select(['m.id', 'm.delta', 'm.balance_after', 'v.sku', 'm.location_id', 'l.name as location', 'g.receipt_number']).where('m.goods_receipt_id', 'in', receiptIds).orderBy('m.id').execute(),
    db().selectFrom('material_movements as m').innerJoin('materials as mt', 'mt.id', 'm.material_id').innerJoin('goods_receipts as g', 'g.id', 'm.goods_receipt_id')
      .select(['m.id', 'm.delta', 'm.balance_after', 'mt.id as material_id', 'mt.code', 'mt.unit', 'g.receipt_number']).where('m.goods_receipt_id', 'in', receiptIds).orderBy('m.id').execute(),
  ]) : [[], []];

  return (
    <Entity module={{ href: '/purchase-orders', label: 'Purchase orders' }} name="purchase-order" title={o.po_number} status={<StatusBadge status={o.status} />}
      factsAttr="data-po-facts"
      facts={[
        { label: 'Vendor', value: <Link href={`/vendors/${o.vendor_id}`}>{o.vendor}</Link>, attr: 'vendor' },
        { label: 'Receive at', value: o.location, attr: 'location' },
        ...(o.expected_on ? [{ label: 'Expected', value: formatDay(o.expected_on) }] : []),
        { label: counting ? 'Received' : 'Ordered', value: counting ? `${fmt(received)} of ${fmt(ordered)}` : fmt(ordered), attr: 'received' },
      ]}
      actions={<div className="ord-head-actions">
        <Link className="btn ghost sm" href={`${self}/print`} data-link="print-po">Print / PDF</Link>
        {receive && open && tab !== 'receiving' && <NavLink className="btn sm" href={href('receiving')} data-link="receive">Receive goods</NavLink>}
      </div>}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'items' ? d.lines.length : tid === 'receiving' ? d.receipts.length : undefined }))} current={tab} tabHref={href}>

      {tab === 'overview' && <>
        <Section id="st-h" title="Where it stands" name="progress" hint={NEXT[o.status]}>
          <div data-po-progress>
            <Figures items={[
              { label: 'Ordered', value: fmt(ordered), note: `${d.lines.length} line${d.lines.length === 1 ? '' : 's'}` },
              { label: 'Received', value: fmt(received), note: d.receipts.length ? `${d.receipts.length} goods receipt${d.receipts.length === 1 ? '' : 's'}` : 'nothing yet' },
              { label: o.status === 'closed' && remaining > 0 ? 'Not received' : 'Remaining', value: fmt(remaining), note: open && remaining > 0 ? 'still to come' : undefined },
              ...(d.canSeeCosts && d.totalPaise !== undefined ? [{ label: 'Order value', value: formatPaise(Math.round(d.totalPaise)), note: 'lines with a unit cost' }] : []),
            ]} />
          </div>
          {forProduction.length > 0 && <p className="note" data-po-production>Linked production: {forProduction.map((x, i) => <span key={x.id}>{i > 0 && ', '}{seeProduction ? <Link href={`/production/${x.id}`}>{x.number}</Link> : x.number}</span>)}</p>}
        </Section>
        <Section id="o-h" title="Order" name="order">
          <Facts attr="data-po-meta" items={[
            { label: 'Vendor', value: <><Link href={`/vendors/${o.vendor_id}`}>{o.vendor}</Link>{o.vendor_contact ? ` · ${o.vendor_contact}` : ''}</> },
            ...(o.vendor_phone || o.vendor_email ? [{ label: 'Vendor contact', value: [o.vendor_phone, o.vendor_email].filter(Boolean).join(' · ') }] : []),
            { label: 'Receive products at', value: o.location },
            { label: 'Expected', value: o.expected_on ? formatDay(o.expected_on) : 'No date given' },
            { label: 'Created', value: `${formatDateTime(o.created_at as Date)}${o.created_by ? ` · ${o.created_by}` : ''}` },
            ...(o.approved_at ? [{ label: 'Approved', value: `${formatDateTime(o.approved_at as Date)}${o.approved_by ? ` · ${o.approved_by}` : ''}` }] : []),
            ...(o.ordered_at ? [{ label: 'Sent to the vendor', value: formatDateTime(o.ordered_at as Date) }] : []),
            ...(o.closed_at ? [{ label: 'Closed', value: `${formatDateTime(o.closed_at as Date)}${o.closed_by ? ` · ${o.closed_by}` : ''}${o.close_note ? ` · ${o.close_note}` : ''}` }] : []),
            ...(o.notes ? [{ label: 'Notes / terms', value: o.notes }] : []),
          ]} />
        </Section>
        {manage && d.next.length > 0 && (
          <Section id="s-h" title="Order status" name="status" hint="Each step is recorded with who did it. Receiving moves the order to partly received and received by itself.">
            <div className="actions">
              {d.next.includes('approved') && approve && (
                <ActionForm action={poStatusAction} submitLabel="Approve" className="inline-form" id="po-approve-form" label="Approve the order" confirmText="Approve this purchase order? It can then be sent to the vendor.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="approved" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('ordered') && (o.status === 'approved' || approve) && (
                <ActionForm action={poStatusAction} submitLabel={draft ? 'Approve and send to vendor' : 'Mark as sent to vendor'} className="inline-form" id="po-place-form" label="Send to the vendor"
                  confirmText="Send this order to the vendor? Lines can no longer be changed.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="ordered" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
              {d.next.includes('draft') && (
                <ActionForm action={poStatusAction} submitLabel="Back to draft" variant="ghost" className="inline-form" id="po-reopen-form" label="Back to draft">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="draft" /><Hidden name="expectedStatus" value={o.status} />
                </ActionForm>
              )}
            </div>
            {draft && !approve && <p className="note" data-po-needs-approval>An approver (procurement.approve) approves the order before it is sent.</p>}
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
                <ActionForm action={poStatusAction} submitLabel="Cancel order" variant="danger" className="form compact row-edit-form" id="po-cancel-form" label="Cancel order"
                  confirmText="Cancel this purchase order? This cannot be undone.">
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="status" value="cancelled" /><Hidden name="expectedStatus" value={o.status} />
                  <Field name="note" label="Reason" required />
                </ActionForm>
              </details>
            )}
          </Section>
        )}
      </>}

      {tab === 'items' && <>
        <Section id="l-h" title="Items" name="lines" wide meta={d.lines.length ? `${d.lines.length}` : undefined}
          hint={draft ? 'Items can be changed while the order is a draft.' : 'Ordered, received and remaining for every line. Received changes only when a delivery is recorded.'}>
          {d.lines.length ? <div className="table-wrap"><table data-po-lines>
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Remaining</th>{!draft && <th>Receiving</th>}
              {d.canSeeCosts && <th className="num">Unit cost</th>}{d.canSeeCosts && <th className="num">Line total</th>}{manage && draft && <th />}</tr></thead>
            <tbody>{d.lines.map(l => (
              <tr key={l.id} data-line={l.code} data-line-kind={l.kind}>
                <td><b>{l.name}</b><div className="note mono">{l.kind === 'product' ? 'Product' : 'Material'} · {l.code}</div></td>
                <td className="num">{fmt(l.ordered)} {l.unit}</td>
                <td className="num" data-received>{fmt(l.received)} {l.unit}</td>
                <td className="num" data-remaining>{fmt(l.outstanding)} {l.unit}{l.outstanding > 0 && open ? <div className="note">to come</div> : null}</td>
                {!draft && <td data-line-state>{o.status === 'approved' || o.status === 'cancelled' ? '—' : lineState(l)}</td>}
                {d.canSeeCosts && <td className="num">{l.unitCostPaise == null ? '—' : formatPaise(l.unitCostPaise)}</td>}
                {d.canSeeCosts && <td className="num">{l.unitCostPaise == null ? '—' : formatPaise(Math.round(l.unitCostPaise * l.ordered))}</td>}
                {manage && draft && <td><ActionForm action={removePoLineAction} submitLabel="Remove" variant="danger" className="inline-form" id={`rm-${l.id}`} label={`Remove ${l.name}`}>
                  <Hidden name="purchaseOrderId" value={o.id} /><Hidden name="lineId" value={l.id} /></ActionForm></td>}
              </tr>
            ))}</tbody>
            {d.canSeeCosts && d.totalPaise !== undefined && <tfoot><tr><td colSpan={draft ? 5 : 6}>Order value (lines with a cost)</td><td className="num" data-po-total>{formatPaise(Math.round(d.totalPaise))}</td>{manage && draft && <td />}</tr></tfoot>}
          </table></div> : <StateBlock title="No items yet" name="po-lines">{manage && draft ? 'Add the first product size or material below.' : 'This order has no items.'}</StateBlock>}
        </Section>
        {manage && draft && (
          <Section id="al-h" title="Add or change an item" name="add-line" hint="Choosing an item that is already on the order replaces its quantity.">
            {items.length ? (
              <ActionForm action={setPoLineAction} submitLabel="Add or update line" className="form compact" id="po-line-form" label="Add an item" resetOnSuccess>
                <Hidden name="purchaseOrderId" value={o.id} />
                <Select name="item" label="Product size or material" options={items} />
                <Field name="qty" label="Quantity" required />
                {d.canSeeCosts && <Field name="unitCost" label="Unit cost, ₹ (optional)" />}
              </ActionForm>
            ) : <p className="note">Add products or materials first.</p>}
          </Section>
        )}
      </>}

      {tab === 'receiving' && <>
        <Section id="rs-h" title="Ordered, received, remaining" name="receiving-status" wide
          hint={open ? `Products go into stock at ${o.location}; materials into material stock.` : NEXT[o.status]}>
          {d.lines.length ? <div className="table-wrap"><table data-receiving-lines>
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Remaining</th><th>Receiving</th></tr></thead>
            <tbody>{d.lines.map(l => (
              <tr key={l.id} data-receiving-line={l.code}>
                <td><b>{l.name}</b><div className="note mono">{l.code}</div></td>
                <td className="num" data-ordered>{fmt(l.ordered)} {l.unit}</td><td className="num" data-received>{fmt(l.received)} {l.unit}</td>
                <td className="num" data-remaining><b>{fmt(l.outstanding)}</b> {l.unit}</td><td>{counting ? lineState(l) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div> : <p className="note">This order has no items.</p>}
        </Section>
        {open && (receive ? (
          <Section id="r-h" title="Record goods received" name="receive"
            hint="Enter only what physically arrived. No more than the remaining quantity of a line can be received. Each delivery gets its own goods receipt number.">
            <ActionForm action={receiveGoodsAction} submitLabel="Record goods received" id="receive-form" label="Record goods received" resetOnSuccess
              confirmText={`Record this delivery on ${o.po_number}? The quantities are added to stock through the stock ledger and a goods receipt is created. It cannot be edited afterwards.`}>
              <Hidden name="purchaseOrderId" value={o.id} />
              {d.lines.filter(l => l.outstanding > 0).map(l => <Hidden key={`seen-${l.id}`} name={`seen:${l.id}`} value={String(l.received)} />)}
              {d.lines.filter(l => l.outstanding > 0).map(l => (
                <Field key={l.id} name={`received:${l.id}`} label={`${l.name} (${fmt(l.outstanding)} ${l.unit} to come)`} hint={`Ordered ${fmt(l.ordered)} · received ${fmt(l.received)}. Leave empty if none arrived.`} />
              ))}
              <Field name="vendorRef" label="Vendor's delivery note / invoice no. (optional)" />
              <Field name="note" label="Note (optional)" />
            </ActionForm>
          </Section>
        ) : <p className="note" data-readonly="receiving">Recording a delivery needs the procurement.receive permission.</p>)}
        <Section id="g-h" title="Goods received" name="receipts" wide meta={d.receipts.length ? `${d.receipts.length}` : undefined} hint="One row per delivery. A goods receipt opens with its lines and can be printed.">
          {d.receipts.length ? <div className="table-wrap"><table data-po-receipts>
            <thead><tr><th>Goods receipt</th><th>Received</th><th>By</th><th>At</th><th>Items</th><th>Vendor&apos;s ref</th></tr></thead>
            <tbody>{d.receipts.map(g => (
              <tr key={g.id} data-receipt={g.receipt_number ?? ''}>
                <td>{g.receipt_number ? <Link href={`${self}/receipts/${g.id}`} className="mono-strong">{g.receipt_number}</Link> : 'Delivery'}</td>
                <td className="nowrap">{formatDateTime(g.received_at as Date)}</td><td>{g.received_by ?? 'staff'}</td><td>{g.location_name ?? '—'}</td>
                <td>{g.items ?? '—'}{g.note && <div className="note">{g.note}</div>}</td><td>{g.vendor_ref ? `ref ${g.vendor_ref}` : '—'}</td>
              </tr>))}</tbody>
          </table></div> : <StateBlock title="Nothing received yet" name="receipts">{open ? 'Deliveries recorded on this order are listed here.' : draft || o.status === 'approved' ? 'Goods can be received once the order has been sent to the vendor.' : 'No delivery was recorded on this order.'}</StateBlock>}
        </Section>
        {(stockMoves.length > 0 || materialMoves.length > 0) && (
          <Section id="m-h" title="Stock movements from these receipts" name="receipt-movements" wide
            hint="The ledger rows each goods receipt wrote: this is how the delivery entered stock. Nothing else on this page changes stock.">
            <div className="table-wrap"><table data-receipt-movements>
              <thead><tr><th>Goods receipt</th><th>Item</th><th className="num">Change</th><th className="num">Balance after</th><th>Stock</th><th>Ledger</th></tr></thead>
              <tbody>
                {stockMoves.map(m => (
                  <tr key={`s${m.id}`} data-movement={m.sku}>
                    <td className="mono">{m.receipt_number}</td><td className="mono">{m.sku}</td><td className="num" data-delta>+{m.delta}</td><td className="num" data-balance>{m.balance_after}</td>
                    <td>{m.location_id && seeStock ? <Link href={`/locations/${m.location_id}`}>{m.location}</Link> : m.location ?? 'Online stock'}</td>
                    <td>{seeStock ? <Link href={`/inventory/movements?q=${encodeURIComponent(m.sku)}&reason=purchase_in`} data-link="ledger">Stock ledger</Link> : '—'}</td>
                  </tr>))}
                {materialMoves.map(m => (
                  <tr key={`m${m.id}`} data-movement={m.code}>
                    <td className="mono">{m.receipt_number}</td><td className="mono">{m.code}</td><td className="num" data-delta>+{fmt(Number(m.delta))} {m.unit}</td><td className="num" data-balance>{fmt(Number(m.balance_after))} {m.unit}</td>
                    <td>Material stock</td><td><Link href={`/materials/${m.material_id}`} data-link="material-ledger">Material ledger</Link></td>
                  </tr>))}
              </tbody>
            </table></div>
          </Section>
        )}
      </>}

      {tab === 'documents' && (
        <Section id="d-h" title="Documents" name="documents" wide hint="Printed from the browser (print, or save as PDF). They are produced from the order as it is now; no file is stored.">
          <div className="table-wrap"><table data-po-documents>
            <thead><tr><th>Document</th><th>About</th><th>State</th><th>Open</th></tr></thead>
            <tbody>
              <tr data-document="purchase-order"><td><b>Purchase order</b><div className="note mono">{o.po_number}</div></td><td>{o.vendor} · {d.lines.length} line{d.lines.length === 1 ? '' : 's'}</td>
                <td>{draft ? 'Draft: not yet sent to the vendor' : o.status === 'cancelled' ? 'Cancelled order' : 'Ready to print'}</td>
                <td><Link className="btn ghost sm" href={`${self}/print`} data-link="print-po-document">Open to print</Link></td></tr>
              {d.receipts.filter(g => g.receipt_number).map(g => (
                <tr key={g.id} data-document={g.receipt_number!}><td><b>Goods receipt</b><div className="note mono">{g.receipt_number}</div></td>
                  <td>{formatDateTime(g.received_at as Date)}{g.location_name ? ` · ${g.location_name}` : ''}{g.items ? <div className="note">{g.items}</div> : null}</td><td>Ready to print</td>
                  <td><Link className="btn ghost sm" href={`${self}/receipts/${g.id}`}>Open to print</Link></td></tr>))}
            </tbody>
          </table></div>
        </Section>
      )}

      {tab === 'activity' && (
        <Section id="a-h" title="Activity" name="activity" wide hint="Every change to this order, from the audit log.">
          <RecordActivity entityType="purchase_orders" entityId={o.id} name="purchase-order" empty="Changes to this purchase order are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
