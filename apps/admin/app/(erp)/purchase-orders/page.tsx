import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listMaterials, listPurchaseOrders, listVendors } from '@kitsyuu/core';
import MaterialLines from '@/components/MaterialLines';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createPurchaseOrderWithLinesAction } from './actions';

export const metadata: Metadata = { title: 'Purchase orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled'] as const;

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase orders" /><Forbidden permission="procurement.read" /></>;
  const s = String((await searchParams).status ?? '');
  const status = (STATUSES as readonly string[]).includes(s) ? s as typeof STATUSES[number] : undefined;
  const manage = can(actor, 'procurement.manage');
  const [orders, vendors, materials] = await Promise.all([listPurchaseOrders(db(), actor, { status }), manage ? listVendors(db(), actor) : Promise.resolve([]),
    manage ? listMaterials(db(), actor) : Promise.resolve([])]);
  const active = materials.filter(m => m.is_active);
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
              <td><Link href={`/purchase-orders/${o.id}`} className="row-link mono-strong">{o.po_number}</Link><div className="note">{formatDateTime(o.created_at as Date)}</div></td>
              <td>{o.vendor}</td><td className="num">{o.lines}</td>
              <td>{formatDay(o.expected_on)}</td>
              <td><StatusBadge status={o.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="npo-h" data-section="new-po">
          <h2 id="npo-h">New purchase order</h2>
          <p className="note">One vendor, as many materials as you need: enter a quantity for each material to order (and its unit price); rows left empty are not ordered.
            The order is created as a draft; review it, then place it with the vendor.</p>
          {!vendors.some(v => v.is_active) ? <p className="note">Add a vendor first under <Link href="/vendors">Vendors</Link>.</p>
            : !active.length ? <p className="note">Add materials first under <Link href="/materials">Materials</Link>.</p> : (
            <ActionForm action={createPurchaseOrderWithLinesAction} submitLabel="Create purchase order" id="create-po-form" label="New purchase order"
              confirmText="Create this purchase order as a draft?">
              <div className="cols">
                <Select name="vendorId" label="Vendor" options={vendors.filter(v => v.is_active).map(v => ({ value: v.id, label: v.name }))} />
                <Field name="expectedOn" label="Expected delivery (optional)" type="date" />
              </div>
              <MaterialLines materials={active.map(m => ({ id: m.id, code: m.code, name: m.name, unit: m.unit, stock: m.stock }))} showCosts={can(actor, 'costs.read')} />
              <TextArea name="notes" label="Notes / terms (optional)" rows={2} />
            </ActionForm>
          )}
        </section>
      )}
    </>
  );
}
