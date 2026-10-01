import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listProducibleVariants, listProductionOrders, listPurchaseOrders } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import MaterialLines from '@/components/MaterialLines';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createProductionBatchAction, createProductionOrderAction, linkProductionPoAction } from './actions';

export const metadata: Metadata = { title: 'Production' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const;

/* M14: production orders. Planned → in progress → completed by recording the quality check (passed pieces go into
   stock) or cancelled. Manufacturing stages are not modelled because they have not been decided.
   2026-10-01: several sizes can be planned at once (one batch reference), and several orders selected and linked to a
   purchase order (a record of what was bought for them; it moves no stock and makes nothing wait). */
export default async function ProductionPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production" /><Forbidden permission="production.read" /></>;
  const sp = await searchParams;
  const s = String(sp.status ?? ''), batch = typeof sp.batch === 'string' && sp.batch.length <= 40 ? sp.batch : undefined;
  const status = (STATUSES as readonly string[]).includes(s) ? s as typeof STATUSES[number] : undefined;
  const manage = can(actor, 'production.manage');
  const linkable = manage && can(actor, 'procurement.read');
  const [orders, variants, pos] = await Promise.all([listProductionOrders(db(), actor, { status, batch }), manage ? listProducibleVariants(db(), actor) : Promise.resolve([]),
    linkable ? listPurchaseOrders(db(), actor, {}) : Promise.resolve([])]);
  const openPos = pos.filter(p => p.status !== 'cancelled' && p.status !== 'closed');
  const selectable = linkable && openPos.length > 0;
  return (
    <>
      <PageHead section="Supply" title="Production" eyebrow="Make pieces, record materials used, and complete with the quality check." />
      <nav className="tabs actions" aria-label="Filter by status" data-production-tabs>
        <Link className={`btn sm ${status ? 'ghost' : ''}`} href="/production">All</Link>
        {STATUSES.map(x => <Link key={x} className={`btn sm ${status === x ? '' : 'ghost'}`} href={`/production?status=${x}`}>{x.replace('_', ' ')}</Link>)}
      </nav>
      {batch && <p className="note" data-production-batch>Batch {batch} · <Link href="/production">show all</Link></p>}
      {orders.length === 0 ? <Empty title="No production orders" kind="production">Production orders you create appear here.</Empty> : (
        <div className="table-wrap"><table data-production-table>
          <thead><tr>{selectable && <th><span className="sr-only">Select</span></th>}<th>Order</th><th>Piece</th><th className="num">Planned</th><th className="num">Passed / rejected</th><th>Batch · purchase orders</th><th>Status</th></tr></thead>
          <tbody>{orders.map(o => (
            <tr key={o.id} data-production={o.number}>
              {selectable && <td>{(o.status === 'planned' || o.status === 'in_progress') &&
                <input type="checkbox" name="productionOrderIds[]" value={o.id} form="link-production-form" aria-label={`Select ${o.number}`} />}</td>}
              <td><Link href={`/production/${o.id}`} className="row-link mono-strong">{o.number}</Link><div className="note">{formatDateTime(o.created_at as Date)}{o.due_on ? ` · due ${String(o.due_on).slice(0, 10)}` : ''}</div></td>
              <td>{o.product}<div className="note mono">{o.variant_sku} · {o.size}</div></td>
              <td className="num">{o.qty_planned}</td>
              <td className="num">{o.qty_passed === null ? '—' : `${o.qty_passed} / ${o.qty_rejected}`}</td>
              <td data-production-links>{o.batch_ref ? <Link href={`/production?batch=${encodeURIComponent(o.batch_ref)}`} className="mono">{o.batch_ref}</Link> : '—'}
                {o.purchase_orders && <div className="note">{o.purchase_orders}</div>}</td>
              <td><StatusBadge status={o.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {selectable && orders.length > 0 && (
        <section className="card form-panel" aria-labelledby="lpo-h" data-section="link-production">
          <h2 id="lpo-h">Link selected to a purchase order</h2>
          <p className="note">Tick planned or in-progress orders above. The link only records what was bought for them; it moves no stock.</p>
          <ActionForm action={linkProductionPoAction} submitLabel="Link selected" className="form compact" id="link-production-form" label="Link to a purchase order">
            <Select name="purchaseOrderId" label="Purchase order" options={[{ value: '', label: 'Choose…' }, ...openPos.map(p => ({ value: p.id, label: `${p.po_number} · ${p.vendor} · ${p.status.replace(/_/g, ' ')}` }))]} />
          </ActionForm>
        </section>
      )}
      {manage && variants.length > 0 && (
        <section className="card form-panel" aria-labelledby="bpr-h" data-section="new-production-batch">
          <h2 id="bpr-h">Plan several sizes at once</h2>
          <ActionForm action={createProductionBatchAction} submitLabel="Plan production" className="form form-wide" id="create-production-batch-form" label="Plan several sizes" resetOnSuccess>
            <MaterialLines materials={[]} products={variants.map(v => ({ id: v.id, sku: v.sku, label: v.name, stock: v.stock, supplied: false }))} showCosts={false} />
            <div className="cols">
              <Field name="batchRef" label="Batch reference (optional)" hint="Empty: the first order's number." />
              <Field name="dueOn" label="Due (optional)" type="date" />
            </div>
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </section>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="npr-h" data-section="new-production">
          <h2 id="npr-h">New production order</h2>
          <ActionForm action={createProductionOrderAction} submitLabel="Plan production" id="create-production-form" label="New production order">
            <Select name="variantId" label="Piece and size" options={variants.map(v => ({ value: v.id, label: v.label }))} />
            <Field name="qty" label="Pieces to make" type="number" required />
            <Field name="dueOn" label="Due (optional)" type="date" />
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </section>
      )}
    </>
  );
}
