import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listVendors, vendorProductLinks } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, TextArea } from '@/components/forms';
import ProductPicker from '@/components/ProductPicker';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { saveVendorAction, setVendorActiveAction, setVendorProductsAction } from './actions';

export const metadata: Metadata = { title: 'Vendors' };
type Vendor = Awaited<ReturnType<typeof listVendors>>[number];

function VendorFields({ v }: { v?: Vendor }) {
  return (
    <>
      {v && <Hidden name="vendorId" value={v.id} />}
      <div className="cols">
        <Field name="name" label="Name" defaultValue={v?.name} required />
        <Field name="contact" label="Contact person" defaultValue={v?.contact ?? ''} />
        <Field name="email" label="Email" type="email" defaultValue={v?.email ?? ''} />
        <Field name="phone" label="Phone" defaultValue={v?.phone ?? ''} />
        <Field name="gstin" label="GSTIN" defaultValue={v?.gstin ?? ''} hint="Optional, 15 characters." />
      </div>
      <TextArea name="address" label="Address" defaultValue={v?.address ?? ''} rows={2} />
      <TextArea name="notes" label="Notes (staff only)" defaultValue={v?.notes ?? ''} rows={2} />
    </>
  );
}

/* M13: suppliers of fabric, trims and other materials; 2026-10-01: and of finished products (chosen several at once). Vendors are never deleted (purchase orders refer to them). */
export default async function VendorsPage() {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Vendors" /><Forbidden permission="procurement.read" /></>;
  const [vendors, links] = await Promise.all([listVendors(db(), actor), vendorProductLinks(db(), actor)]);
  const productName = new Map(links.products.map(p => [p.id, p.name]));
  const manage = can(actor, 'procurement.manage');
  return (
    <>
      <PageHead section="Supply" title="Vendors" eyebrow={`${vendors.filter(v => v.is_active).length} active · ${vendors.length} in total`} />
      {vendors.length === 0 ? <Empty title="No vendors yet" kind="vendors">Add the suppliers you buy finished products, fabric, trims and other materials from.</Empty> : (
        <div className="table-wrap"><table data-vendors-table>
          <thead><tr><th>Vendor</th><th>Contact</th><th>Products supplied</th><th className="num">Open orders</th><th>Status</th>{manage && <th>Actions</th>}</tr></thead>
          <tbody>{vendors.map(v => (
            <tr key={v.id} data-vendor={v.name}>
              <td><b>{v.name}</b>{v.gstin && <div className="note mono">GSTIN {v.gstin}</div>}{v.address && <div className="note">{v.address}</div>}</td>
              <td>{v.contact ?? '—'}{v.email && <div className="note">{v.email}</div>}{v.phone && <div className="note">{v.phone}</div>}</td>
              <td data-vendor-products>{(() => { const ids = links.byVendor.get(v.id) ?? []; const names = ids.map(id => productName.get(id)).filter(Boolean);
                return <>{ids.length ? <><b>{ids.length}</b><div className="note">{names.slice(0, 3).join(', ')}{names.length > 3 ? ` +${names.length - 3} more` : ''}</div></> : <span className="note">None chosen</span>}
                  {manage && <details className="row-edit"><summary className="btn ghost sm">Choose products</summary>
                    <ActionForm action={setVendorProductsAction} submitLabel="Save products" className="form compact row-edit-form" id={`vendor-products-${v.id}`} label={`Products ${v.name} supplies`}>
                      <Hidden name="vendorId" value={v.id} />
                      <ProductPicker products={links.products} selected={ids} idPrefix={`vp-${v.id}`} />
                    </ActionForm>
                  </details>}</>; })()}</td>
              <td className="num">{v.open_orders}</td>
              <td><span className={`badge ${v.is_active ? 'active' : 'disabled'}`}>{v.is_active ? 'Active' : 'Inactive'}</span></td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveVendorAction} submitLabel="Save" className="form compact row-edit-form" id={`vendor-edit-${v.id}`} label={`Edit ${v.name}`}><VendorFields v={v} /></ActionForm>
                </details>
                <ActionForm action={setVendorActiveAction} submitLabel={v.is_active ? 'Deactivate' : 'Activate'} variant={v.is_active ? 'danger' : 'ghost'} className="inline-form"
                  id={`vendor-active-${v.id}`} label={`${v.is_active ? 'Deactivate' : 'Activate'} ${v.name}`}>
                  <Hidden name="vendorId" value={v.id} /><Hidden name="active" value={v.is_active ? 'false' : 'true'} />
                </ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="nv-h" data-section="new-vendor">
          <h2 id="nv-h">New vendor</h2>
          <ActionForm action={saveVendorAction} submitLabel="Add vendor" id="create-vendor-form" label="Add vendor" resetOnSuccess><VendorFields /></ActionForm>
        </section>
      )}
    </>
  );
}
