/* Purchasing → New purchase order (2026-10-08: its own page; the form, its fields and its action are unchanged).
   One vendor, as many finished products (sizes) and materials as needed. The order is created as a draft: an approver
   approves it, then it is sent to the vendor. Nothing is added to stock until goods are received. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listMaterials, listVendors, purchasableSizes } from '@kitsyuu/core';
import MaterialLines from '@/components/MaterialLines';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { StateBlock } from '@/components/frame';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createPurchaseOrderWithLinesAction } from '../actions';

export const metadata: Metadata = { title: 'New purchase order' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/purchase-orders', label: 'Purchase orders' }];
  if (!can(actor, 'procurement.manage')) return <><PageHead section="Supply" title="New purchase order" crumbs={crumbs} /><Forbidden permission="procurement.manage" /></>;
  const sp = await searchParams;
  const vendorParam = typeof sp.vendor === 'string' && /^[0-9a-f-]{36}$/i.test(sp.vendor) ? sp.vendor : null;
  const [vendors, materials, sizes, locations] = await Promise.all([listVendors(db(), actor), listMaterials(db(), actor), purchasableSizes(db(), actor, vendorParam),
    db().selectFrom('locations').select(['id', 'name', 'is_online']).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute()]);
  const active = materials.filter(m => m.is_active), activeVendors = vendors.filter(v => v.is_active);
  return (
    <div className="ord ws" data-workspace="new-purchase-order">
      <PageHead section="Supply" title="New purchase order" crumbs={crumbs} eyebrow="Created as a draft. Nothing enters stock until goods are received." />
      {activeVendors.length === 0 ? (
        <StateBlock title="Add a vendor first" name="new-po" action={<Link className="btn ghost sm" href="/vendors">Open Vendors</Link>}>A purchase order is placed with a vendor. There is no active vendor yet.</StateBlock>
      ) : !active.length && !sizes.length ? (
        <StateBlock title="Nothing to order yet" name="new-po">Add products or materials first.</StateBlock>
      ) : (
        <section className="card form-panel" aria-labelledby="npo-h" data-section="new-po">
          <h2 id="npo-h" className="sr-only">Order details</h2>
          <form className="actions" method="get" data-po-vendor-pick>
            <label className="inline-label">Vendor <select name="vendor" className="input" defaultValue={vendorParam ?? ''}>
              <option value="">Choose…</option>{activeVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <button className="btn ghost sm" type="submit">Show what they supply</button>
          </form>
          <p className="note">Enter a quantity for each item to order (and its unit price, if you see costs); rows left empty are not ordered.</p>
          <ActionForm action={createPurchaseOrderWithLinesAction} submitLabel="Create purchase order" id="create-po-form" label="New purchase order"
            confirmText="Create this purchase order as a draft?">
            <div className="cols">
              <Select name="vendorId" label="Vendor" defaultValue={vendorParam ?? undefined} options={activeVendors.map(v => ({ value: v.id, label: v.name }))} />
              <Field name="expectedOn" label="Expected delivery (optional)" type="date" />
              <Select name="locationId" label="Receive products at" options={locations.map(l => ({ value: l.is_online ? '' : l.id, label: l.is_online ? `${l.name} (online stock)` : l.name }))}
                hint="Materials are not kept per location." />
            </div>
            <MaterialLines materials={active.map(m => ({ id: m.id, code: m.code, name: m.name, unit: m.unit, stock: m.stock }))} products={sizes} showCosts={can(actor, 'costs.read')} />
            <TextArea name="notes" label="Notes / terms (optional)" rows={2} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
