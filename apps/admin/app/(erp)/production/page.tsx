import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listProducibleVariants, listProductionOrders } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createProductionOrderAction } from './actions';

export const metadata: Metadata = { title: 'Production' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const;

/* M14: production orders. Planned → in progress → completed by recording the quality check (passed pieces go into
   stock) or cancelled. Manufacturing stages are not modelled because they have not been decided. */
export default async function ProductionPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'production.read')) return <><PageHead section="Supply" title="Production" /><Forbidden permission="production.read" /></>;
  const s = String((await searchParams).status ?? '');
  const status = (STATUSES as readonly string[]).includes(s) ? s as typeof STATUSES[number] : undefined;
  const manage = can(actor, 'production.manage');
  const [orders, variants] = await Promise.all([listProductionOrders(db(), actor, { status }), manage ? listProducibleVariants(db(), actor) : Promise.resolve([])]);
  return (
    <>
      <PageHead section="Supply" title="Production" eyebrow="Make pieces, record materials used, and complete with the quality check." />
      <nav className="tabs actions" aria-label="Filter by status" data-production-tabs>
        <Link className={`btn sm ${status ? 'ghost' : ''}`} href="/production">All</Link>
        {STATUSES.map(x => <Link key={x} className={`btn sm ${status === x ? '' : 'ghost'}`} href={`/production?status=${x}`}>{x.replace('_', ' ')}</Link>)}
      </nav>
      {orders.length === 0 ? <Empty title="No production orders" kind="production">Production orders you create appear here.</Empty> : (
        <div className="table-wrap"><table data-production-table>
          <thead><tr><th>Order</th><th>Piece</th><th className="num">Planned</th><th className="num">Passed / rejected</th><th>Status</th></tr></thead>
          <tbody>{orders.map(o => (
            <tr key={o.id} data-production={o.number}>
              <td><Link href={`/production/${o.id}`} className="mono">{o.number}</Link><div className="note">{formatDateTime(o.created_at as Date)}{o.due_on ? ` · due ${String(o.due_on).slice(0, 10)}` : ''}</div></td>
              <td>{o.product}<div className="note mono">{o.variant_sku} · {o.size}</div></td>
              <td className="num">{o.qty_planned}</td>
              <td className="num">{o.qty_passed === null ? '—' : `${o.qty_passed} / ${o.qty_rejected}`}</td>
              <td><StatusBadge status={o.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
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
