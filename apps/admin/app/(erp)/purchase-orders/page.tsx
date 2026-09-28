import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listPurchaseOrders, listVendors } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createPurchaseOrderAction } from './actions';

export const metadata: Metadata = { title: 'Purchase orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled'] as const;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase orders" /><Forbidden permission="procurement.read" /></>;
  const s = String((await searchParams).status ?? '');
  const status = (STATUSES as readonly string[]).includes(s) ? s as typeof STATUSES[number] : undefined;
  const manage = can(actor, 'procurement.manage');
  const [orders, vendors] = await Promise.all([listPurchaseOrders(db(), actor, { status }), manage ? listVendors(db(), actor) : Promise.resolve([])]);
  return (
    <>
      <PageHead section="Supply" title="Purchase orders" eyebrow={status ? `Showing ${status.replace('_', ' ')}` : 'Newest first'} />
      <nav className="tabs actions" aria-label="Filter by status" data-po-tabs>
        <Link className={`btn sm ${status ? 'ghost' : ''}`} href="/purchase-orders">All</Link>
        {STATUSES.map(x => <Link key={x} className={`btn sm ${status === x ? '' : 'ghost'}`} href={`/purchase-orders?status=${x}`}>{x.replace('_', ' ')}</Link>)}
      </nav>
      {orders.length === 0 ? <Empty title="No purchase orders" kind="purchase-orders">Purchase orders you create appear here.</Empty> : (
        <div className="table-wrap"><table data-po-table>
          <thead><tr><th>Order</th><th>Vendor</th><th className="num">Lines</th><th>Expected</th><th>Status</th></tr></thead>
          <tbody>{orders.map(o => (
            <tr key={o.id} data-po={o.po_number}>
              <td><Link href={`/purchase-orders/${o.id}`} className="mono">{o.po_number}</Link><div className="note">{formatDateTime(o.created_at as Date)}</div></td>
              <td>{o.vendor}</td><td className="num">{o.lines}</td>
              <td>{o.expected_on ? String(o.expected_on).slice(0, 10) : '—'}</td>
              <td><StatusBadge status={o.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="npo-h" data-section="new-po">
          <h2 id="npo-h">New purchase order</h2>
          {vendors.some(v => v.is_active) ? (
            <ActionForm action={createPurchaseOrderAction} submitLabel="Create draft" id="create-po-form" label="New purchase order">
              <Select name="vendorId" label="Vendor" options={vendors.filter(v => v.is_active).map(v => ({ value: v.id, label: v.name }))} />
              <Field name="expectedOn" label="Expected delivery (optional)" type="date" />
              <TextArea name="notes" label="Notes (optional)" rows={2} />
            </ActionForm>
          ) : <p className="note">Add a vendor first under <Link href="/vendors">Vendors</Link>.</p>}
        </section>
      )}
    </>
  );
}
