/* One production order (2026-10-08: on the shared entity frame).

     header  number, status, the piece and size, planned and completed; the next thing to do
     tabs    Overview · Materials · Output · Activity

   The order, its steps and its rules are core's and unchanged: planned → in progress → completed (by recording the
   quality check) / cancelled. There are no manufacturing stages in the model, so there is no separate "Production" tab:
   starting and cancelling are on Overview.
   · Materials: what is planned and what was used. "Used" is recorded with the existing action, which takes the quantity
     from material stock through the material ledger (refused when there is not enough) in the same transaction.
   · Output: the quality check completes the order ONCE. Passed pieces enter the online store's stock through the stock
     ledger (reason production_in, the order's number on the row); rejected pieces never do. There is no partial output.
   This page never changes a quantity itself; it shows the ledger rows the order wrote so they can be followed. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getProductionOrder, listMaterials, listVendors, productionMaterialNeeds } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Entity, Facts, Figures, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { consumeMaterialAction, productionInputAction, productionStatusAction, qualityCheckAction, raiseProductionPoAction } from '../actions';

export const metadata: Metadata = { title: 'Production order' };
/** Procurement status of a production order (see core procurementStatus). */
const PROCUREMENT: Record<string, string> = { no_plan: 'No materials planned', in_stock: 'Covered by stock', not_ordered: 'Not ordered (short, no purchase order)', partially_ordered: 'Partially ordered (part of the shortfall is on order)', ordered: 'Ordered (the shortfall is on order)', received: 'Received' };
const NEXT: Record<string, string> = {
  planned: 'Planned. Plan the materials it needs, then start production.',
  in_progress: 'In progress. Record the materials used; the quality check completes the order and adds the passed pieces to stock.',
  completed: 'Completed. Its passed pieces are in stock.',
  cancelled: 'Cancelled. It added nothing to stock.',
};
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['overview', 'Overview'], ['materials', 'Materials'], ['output', 'Output'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default async function ProductionOrderPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/production', label: 'Production' }];
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production order" crumbs={crumbs} /><Forbidden permission="production.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getProductionOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const o = d.order;
  const manage = can(actor, 'production.manage'), seeBuying = can(actor, 'procurement.read'), seeAudit = can(actor, 'audit.read'), seeStock = can(actor, 'inventory.read'), seeProducts = can(actor, 'products.read');
  const tabs = TABS.filter(t => t[0] !== 'activity' || seeAudit);
  const tab: Tab = tabs.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const self = `/production/${o.id}`;
  const href = (t: string) => (t === 'overview' ? self : `${self}?tab=${t}`);
  const open = o.status === 'planned' || o.status === 'in_progress';
  const passed = d.qc?.qty_passed ?? 0, rejected = d.qc?.qty_rejected ?? 0;
  const remaining = o.status === 'cancelled' ? 0 : Math.max(0, o.qty_planned - passed - rejected);

  const onMaterials = tab === 'materials';
  const materials = onMaterials && manage && open && seeBuying ? (await listMaterials(db(), actor)).filter(m => m.is_active) : [];
  // What still has to be bought for this order, and the purchase orders raised for it (core).
  const needs = (onMaterials || tab === 'overview') && seeBuying ? await productionMaterialNeeds(db(), actor, o.id) : null;
  const canBuy = onMaterials && !!needs && open && can(actor, 'procurement.manage');
  const vendors = canBuy ? (await listVendors(db(), actor)).filter(v => v.is_active) : [];
  const short = needs?.needs.filter(n => n.active && (n.shortfall ?? 0) > 0) ?? [];
  // The ledger rows this order wrote (read-only): material used, and the pieces that entered stock.
  const usage = onMaterials ? await db().selectFrom('material_movements as mv').innerJoin('materials as mt', 'mt.id', 'mv.material_id').leftJoin('staff_users as s', 's.id', 'mv.staff_id')
    .select(['mv.id', 'mv.created_at', 'mv.delta', 'mv.balance_after', 'mt.id as material_id', 'mt.code', 'mt.name', 'mt.unit', 's.email as staff_email'])
    .where('mv.reason', '=', 'consume').where('mv.note', '=', o.number).orderBy('mv.id', 'desc').limit(200).execute() : [];
  const [output, online] = tab === 'output' ? await Promise.all([
    db().selectFrom('inventory_movements as m').leftJoin('locations as l', 'l.id', 'm.location_id').leftJoin('staff_users as s', 's.id', 'm.staff_id')
      .select(['m.id', 'm.created_at', 'm.delta', 'm.balance_after', 'm.location_id', 'l.name as location', 's.email as staff_email'])
      .where('m.reason', '=', 'production_in').where('m.variant_id', '=', o.variant_id).where('m.note', '=', o.number).orderBy('m.id').execute(),
    db().selectFrom('locations').select(['id', 'name']).where('is_online', '=', true).executeTakeFirst(),
  ]) : [[], undefined];

  return (
    <Entity module={{ href: '/production', label: 'Production' }} name="production-order" title={o.number} status={<StatusBadge status={o.status} />}
      factsAttr="data-production-facts"
      facts={[
        { label: 'Piece', value: <>{seeProducts ? <Link href={`/products/${o.product_id}?tab=production`}>{o.product}</Link> : o.product} · size {o.size}</>, attr: 'piece' },
        { label: 'Planned', value: `${o.qty_planned} piece${o.qty_planned === 1 ? '' : 's'}`, attr: 'planned' },
        ...(d.qc ? [{ label: 'Passed into stock', value: `${passed} of ${o.qty_planned}`, attr: 'passed' }] : []),
        ...(o.due_on ? [{ label: 'Due', value: formatDay(o.due_on) }] : []),
        ...(o.batch_ref ? [{ label: 'Batch', value: <Link href={`/production?batch=${encodeURIComponent(o.batch_ref)}`} className="mono">{o.batch_ref}</Link> }] : []),
      ]}
      actions={<div className="ord-head-actions">
        {o.status === 'in_progress' && manage && tab !== 'materials' && <NavLink className="btn ghost sm" href={href('materials')} data-link="record-materials">Record materials used</NavLink>}
        {d.canQc && tab !== 'output' && <NavLink className="btn sm" href={href('output')} data-link="record-output">Complete with quality check</NavLink>}
      </div>}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'materials' ? d.inputs.length : undefined }))} current={tab} tabHref={href}
      notice={o.status === 'cancelled' ? <p className="msg" data-cancelled>Cancelled{o.cancel_note ? `: ${o.cancel_note}` : '.'}</p> : undefined}>

      {tab === 'overview' && <>
        <Section id="pp-h" title="Where it stands" name="progress" hint={NEXT[o.status]}>
          <div data-production-progress>
            <Figures items={[
              { label: 'Planned', value: o.qty_planned },
              { label: 'Completed', value: d.qc ? passed : '—', note: d.qc ? 'passed, added to stock' : 'nothing made yet' },
              { label: 'Rejected', value: d.qc ? rejected : '—', note: d.qc?.reject_reason ?? (d.qc ? 'none' : undefined) },
              { label: 'Remaining', value: remaining, note: o.status === 'completed' && remaining > 0 ? 'not made on this order' : open ? 'to make' : undefined },
            ]} />
          </div>
          {o.status === 'completed' && remaining > 0 && <p className="note" data-production-short>This order is complete: an order is completed once, by one quality check. To make the remaining {remaining}, plan a new production order.</p>}
        </Section>
        <Section id="pd-h" title="Order" name="order">
          <Facts attr="data-production-meta" items={[
            { label: 'Piece', value: <>{seeProducts ? <Link href={`/products/${o.product_id}?tab=production`}>{o.product}</Link> : o.product}<span className="note mono"> · {o.variant_sku} · size {o.size}</span></> },
            { label: 'Online store stock of this size', value: <>{o.stock_qty}{seeStock ? <> · <Link href={`/inventory/movements?q=${encodeURIComponent(o.variant_sku)}`} data-link="size-ledger">stock ledger</Link></> : null}</> },
            { label: 'Created', value: `${formatDateTime(o.created_at as Date)}${o.created_by ? ` · ${o.created_by}` : ''}` },
            ...(o.started_at ? [{ label: 'Started', value: formatDateTime(o.started_at as Date) }] : []),
            ...(o.completed_at ? [{ label: 'Completed', value: formatDateTime(o.completed_at as Date) }] : []),
            ...(needs ? [{ label: 'Materials', value: <><span data-procurement-summary={needs.procurement}>{PROCUREMENT[needs.procurement]}</span> · <NavLink href={href('materials')}>open Materials</NavLink></> }] : []),
            ...(o.notes ? [{ label: 'Notes', value: o.notes }] : []),
          ]} />
        </Section>
        {manage && d.next.length > 0 && (
          <Section id="st-h" title="Status" name="status" hint={o.status === 'planned' ? 'Starting lets materials used and the quality check be recorded.' : 'Completing is done with the quality check, under Output.'}>
            {d.next.includes('in_progress') && (
              <ActionForm action={productionStatusAction} submitLabel="Start production" className="inline-form" id="production-start-form" label="Start production">
                <Hidden name="productionOrderId" value={o.id} /><Hidden name="status" value="in_progress" /><Hidden name="expectedStatus" value={o.status} />
              </ActionForm>
            )}
            {d.next.includes('cancelled') && (
              <details className="row-edit"><summary className="btn ghost sm">Cancel production</summary>
                <ActionForm action={productionStatusAction} submitLabel="Cancel" variant="danger" className="form compact row-edit-form" id="production-cancel-form" label="Cancel production"
                  confirmText={`Cancel ${o.number}? This cannot be undone. Materials already recorded as used stay used.`}>
                  <Hidden name="productionOrderId" value={o.id} /><Hidden name="status" value="cancelled" /><Hidden name="expectedStatus" value={o.status} />
                  <Field name="note" label="Reason" required />
                </ActionForm>
              </details>
            )}
          </Section>
        )}
      </>}

      {tab === 'materials' && <>
        <Section id="in-h" title="Materials" name="inputs" wide meta={d.inputs.length ? `${d.inputs.length}` : undefined}
          hint="Planned is what the order is expected to need; Used is what has been taken from material stock for it.">
          {d.inputs.length ? <div className="table-wrap"><table data-production-inputs>
            <thead><tr><th>Material</th><th className="num">Planned</th><th className="num">Used</th><th className="num">Still to use</th><th className="num">In stock now</th></tr></thead>
            <tbody>{d.inputs.map(i => (
              <tr key={i.id} data-input={i.code}>
                <td>{seeBuying ? <Link href={`/materials/${i.material_id}`} className="row-link">{i.name}</Link> : <b>{i.name}</b>}<div className="note mono">{i.code}</div></td>
                <td className="num" data-planned>{i.planned === null ? '—' : `${fmt(i.planned)} ${i.unit}`}</td>
                <td className="num" data-used>{fmt(i.consumed)} {i.unit}</td>
                <td className="num">{i.planned === null ? '—' : `${fmt(Math.max(0, +(i.planned - i.consumed).toFixed(3)))} ${i.unit}`}</td>
                <td className="num" data-stock>{fmt(i.stock)} {i.unit}</td>
              </tr>
            ))}</tbody>
          </table></div> : <StateBlock title="No materials recorded" name="production-inputs">{manage && open ? 'Plan the materials this order needs below.' : 'No material was planned or used for this order.'}</StateBlock>}
        </Section>
        {manage && open && materials.length > 0 && (
          <Section id="pl-h" title="Plan a material" name="plan-material" hint="The planned quantity is optional. Planning takes nothing from stock.">
            <ActionForm action={productionInputAction} submitLabel="Plan material" className="form compact" id="production-input-form" label="Plan a material" resetOnSuccess>
              <Hidden name="productionOrderId" value={o.id} />
              <Select name="materialId" label="Material" options={materials.map(m => ({ value: m.id, label: `${m.code} · ${m.name} (${fmt(m.stock)} ${m.unit} in stock)` }))} />
              <Field name="qtyPlanned" label="Planned quantity (optional)" />
            </ActionForm>
          </Section>
        )}
        {manage && o.status === 'in_progress' && materials.length > 0 && (
          <Section id="us-h" title="Record material used" name="consume" hint="The quantity is taken from material stock through the material ledger. It is refused when there is not enough in stock.">
            <ActionForm action={consumeMaterialAction} submitLabel="Record material used" className="form compact" id="consume-form" label="Record material used" resetOnSuccess
              confirmText={`Record this material as used on ${o.number}? It is taken from material stock and written to the material ledger. It cannot be edited afterwards.`}>
              <Hidden name="productionOrderId" value={o.id} />
              {d.inputs.map(i => <Hidden key={i.id} name={`used:${i.material_id}`} value={String(i.consumed)} />)}
              <Select name="materialId" label="Material" options={materials.map(m => ({ value: m.id, label: `${m.code} · ${m.name} (${fmt(m.stock)} ${m.unit} in stock)` }))} />
              <Field name="qty" label="Quantity used" required />
            </ActionForm>
          </Section>
        )}
        {manage && o.status === 'planned' && <p className="note" data-consume-later>Material used can be recorded once production has started.</p>}
        {manage && open && materials.length === 0 && seeBuying && <p className="note">Add materials under <Link href="/materials">Materials</Link> to record what production uses.</p>}
        {usage.length > 0 && (
          <Section id="ul-h" title="Material ledger rows of this order" name="usage-ledger" wide hint="What recording material used wrote to the material ledger, newest first.">
            <div className="table-wrap"><table data-usage-ledger>
              <thead><tr><th>When</th><th>Material</th><th className="num">Change</th><th className="num">Balance after</th><th>By</th></tr></thead>
              <tbody>{usage.map(u => (
                <tr key={String(u.id)} data-usage={u.code}><td className="nowrap">{formatDateTime(u.created_at as Date)}</td>
                  <td>{seeBuying ? <Link href={`/materials/${u.material_id}`}>{u.name}</Link> : u.name}<div className="note mono">{u.code}</div></td>
                  <td className="num" data-delta>{fmt(Number(u.delta))} {u.unit}</td><td className="num" data-balance>{fmt(Number(u.balance_after))} {u.unit}</td><td>{u.staff_email ?? '—'}</td></tr>
              ))}</tbody>
            </table></div>
          </Section>
        )}
        {needs && (
          <Section id="buy-h" title="Materials to buy" name="materials-to-buy" wide
            hint="Still needed = planned − used. Short = still needed − in stock − already on order for this production order. Materials with no planned quantity are not counted.">
            <p data-procurement-status={needs.procurement}><b>Procurement:</b> {PROCUREMENT[needs.procurement]}</p>
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
                  <tr key={l.id}><td><Link href={`/purchase-orders/${l.id}`} className="mono">{l.po_number}</Link></td><td>{l.vendor}</td><td><StatusBadge status={l.status} /></td>
                    <td className="num">{fmt(l.ordered)}</td><td className="num">{fmt(l.received)}</td><td className="num">{fmt(l.remaining)}</td></tr>
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
          </Section>
        )}
      </>}

      {tab === 'output' && <>
        {d.canQc && (
          <Section id="qc-h" title="Quality check and completion" name="qc"
            hint={`Planned: ${o.qty_planned}. Passed pieces are added to the stock of size ${o.size} at ${online?.name ?? 'the online store'}. Rejected pieces are recorded and never enter stock. This completes the order; it is done once.`}>
            <ActionForm action={qualityCheckAction} submitLabel="Complete production" id="qc-form" label="Quality check" confirmText="Complete this production order? Passed pieces go into stock; this cannot be undone.">
              <Hidden name="productionOrderId" value={o.id} />
              <Field name="passed" label="Pieces passed" type="number" defaultValue={String(o.qty_planned)} required />
              <Field name="rejected" label="Pieces rejected" type="number" defaultValue="0" required />
              <Field name="rejectReason" label="Reason for rejections" hint="Required when pieces are rejected." />
              <Field name="note" label="Note (optional)" />
            </ActionForm>
          </Section>
        )}
        {d.qc ? (
          <Section id="qr-h" title="Quality check" name="qc-result">
            <Facts attr="data-qc-result" items={[
              { label: 'Planned', value: o.qty_planned },
              { label: 'Passed (added to stock)', value: d.qc.qty_passed, attr: 'passed' },
              { label: 'Rejected', value: `${d.qc.qty_rejected}${d.qc.reject_reason ? ` — ${d.qc.reject_reason}` : ''}`, attr: 'rejected' },
              { label: 'Remaining', value: remaining > 0 ? `${remaining} not made on this order` : '0', attr: 'remaining' },
              { label: 'Checked', value: `${formatDateTime(d.qc.inspected_at as Date)}${d.qc.inspected_by ? ` by ${d.qc.inspected_by}` : ''}` },
              ...(d.qc.note ? [{ label: 'Note', value: d.qc.note }] : []),
            ]} />
          </Section>
        ) : !d.canQc && (
          <StateBlock title={o.status === 'cancelled' ? 'Cancelled before completion' : 'No output yet'} name="production-output">
            {o.status === 'cancelled' ? 'This order added nothing to stock.' : o.status === 'planned' ? 'Start production first; the quality check then completes the order and adds the passed pieces to stock.'
              : 'The quality check completes the order and adds the passed pieces to stock. Recording it needs the qc.record permission.'}
          </StateBlock>
        )}
        {output.length > 0 && (
          <Section id="om-h" title="Stock movement of this order" name="output-movement" wide hint="The stock-ledger row the quality check wrote: this is how the finished pieces entered stock.">
            <div className="table-wrap"><table data-output-movement>
              <thead><tr><th>When</th><th>Size</th><th className="num">Change</th><th className="num">Balance after</th><th>Stock</th><th>By</th><th>Ledger</th></tr></thead>
              <tbody>{output.map(m => (
                <tr key={String(m.id)}><td className="nowrap">{formatDateTime(m.created_at as Date)}</td><td className="mono">{o.variant_sku}</td>
                  <td className="num" data-delta>+{m.delta}</td><td className="num" data-balance>{m.balance_after}</td>
                  <td>{(() => { const lid = m.location_id ?? online?.id, name = m.location ?? online?.name ?? 'Online stock'; return lid && seeStock ? <Link href={`/locations/${lid}`}>{name}</Link> : name; })()}</td>
                  <td>{m.staff_email ?? '—'}</td>
                  <td>{seeStock ? <Link href={`/inventory/movements?q=${encodeURIComponent(o.variant_sku)}&reason=production_in`} data-link="ledger">Stock ledger</Link> : '—'}</td></tr>
              ))}</tbody>
            </table></div>
          </Section>
        )}
        {d.qc && d.qc.qty_passed === 0 && <p className="note" data-no-output>No piece passed, so nothing was added to stock.</p>}
      </>}

      {tab === 'activity' && (
        <Section id="pa-h" title="Activity" name="activity" wide hint="Every change to this production order, from the audit log.">
          <RecordActivity entityType="production_orders" entityId={o.id} name="production-order" empty="Changes to this production order are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
