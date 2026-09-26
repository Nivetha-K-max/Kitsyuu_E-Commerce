import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listCategories } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { createProductAction } from '../manage-actions';

export const metadata: Metadata = { title: 'New product' };

export default async function NewProductPage() {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }];
  if (!can(actor, 'products.write')) return <><PageHead section="Catalogue" title="New product" crumbs={crumbs} /><Forbidden permission="products.write" /></>;
  const categories = await listCategories(db(), actor);
  const label = (c: { label: string; is_active: boolean }) => c.label + (c.is_active ? '' : ' (inactive)');
  return (
    <>
      <PageHead section="Catalogue" title="New product" crumbs={crumbs} eyebrow="Created as a hidden draft — add sizes, stock and an image next" />
      <section className="card form-panel" aria-label="New product">
      <p className="note">The product is created as a <b>draft</b>, hidden from the store. Add sizes, stock and an image on the next screen, then activate it.
        The product ID is generated automatically and never changes. Fields marked * are required.</p>
      <ActionForm action={createProductAction} submitLabel="Create draft product" pendingLabel="Creating…" id="create-product-form" label="Create product" className="form cols-form">
        <Field name="name" label="Name" autoComplete="off" required />
        <Field name="sku" label="SKU" autoComplete="off" required hint="e.g. KTS-TOP-023. Must be unique; sizes get SKU-SIZE." />
        <Field name="slug" label="Store URL slug (optional)" autoComplete="off" hint="Left blank, it is made from the name: /product/<slug>." />
        <Select name="categoryId" label="Category" required options={categories.filter(c => !c.parent_id).map(c => ({ value: c.id, label: label(c) }))} />
        <Select name="subcategoryId" label="Subcategory" hint="Must belong to the chosen category."
          options={[{ value: '', label: 'None' }, ...categories.filter(c => c.parent_id).map(c => ({ value: c.id, label: `${categories.find(x => x.id === c.parent_id)?.label} / ${label(c)}` }))]} />
        <Field name="price" label="Price (₹, tax-inclusive)" autoComplete="off" required hint="Rupees with up to 2 decimals." />
        <Field name="colourLabel" label="Colour (optional)" autoComplete="off" />
        <TextArea name="description" label="Description" rows={4} />
      </ActionForm>
      </section>
    </>
  );
}
