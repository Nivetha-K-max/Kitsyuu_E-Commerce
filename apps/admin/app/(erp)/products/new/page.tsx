import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listAttributes, listCategories } from '@kitsyuu/core';
import { ActionForm, Field, TextArea } from '@/components/forms';
import NewProductFields from '@/components/NewProductFields';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createProductAction } from '../manage-actions';

export const metadata: Metadata = { title: 'New product' };

export default async function NewProductPage() {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }];
  if (!can(actor, 'products.write')) return <><PageHead section="Catalogue" title="New product" crumbs={crumbs} /><Forbidden permission="products.write" /></>;
  const [categories, attributes] = await Promise.all([listCategories(db(), actor), listAttributes(db(), actor)]);
  const colours = (attributes.find(a => a.id === 'colour')?.values ?? []).filter(v => v.isActive).map(v => v.label);
  const label = (c: { label: string; is_active: boolean }) => c.label + (c.is_active ? '' : ' (inactive)');
  return (
    <>
      <PageHead section="Catalogue" title="New product" crumbs={crumbs} eyebrow="Created as a hidden draft — sizes and stock can be added here; the image next" />
      <section className="card form-panel" aria-label="New product">
      <p className="note">The product is created as a <b>draft</b>, hidden from the store. Add its sizes and opening stock below (or later), an image on the next screen, then send it for approval.
        The product ID is generated automatically and never changes. Fields marked * are required.</p>
      <ActionForm action={createProductAction} submitLabel="Create draft product" pendingLabel="Creating…" id="create-product-form" label="Create product" className="form cols-form">
        <Field name="name" label="Name" autoComplete="off" required />
        <Field name="sku" label="SKU" autoComplete="off" required hint="e.g. KTS-TOP-023. Must be unique; sizes get SKU-SIZE." />
        <Field name="price" label="Price (₹, tax-inclusive)" autoComplete="off" required hint="Rupees with up to 2 decimals." />
        <NewProductFields categories={categories.map(c => ({ id: c.id, label: label(c), parentId: c.parent_id }))} colours={colours} canStock={can(actor, 'inventory.adjust')} />
        <TextArea name="description" label="Description" rows={4} />
      </ActionForm>
      </section>
    </>
  );
}
