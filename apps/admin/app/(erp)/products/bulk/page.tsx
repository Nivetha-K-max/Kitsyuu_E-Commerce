import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { productListQuery, type ProductListQuery } from '@kitsyuu/contracts';
import { BULK_MAX_PRODUCTS, listAttributes, listBulkEditDrafts, listCategories, listCollections, listProducts, listVendors, maxSaleDiscountPercent } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import SelectAll from '@/components/SelectAll';
import TagPicker from '@/components/TagPicker';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { bulkEditAction } from './actions';

export const metadata: Metadata = { title: 'Bulk edit products' };

/* Client change request: the bulk product editor. Select products (filter first), choose ONE change and confirm. Publishing
   uses the same completeness rules as publishing one product (active category, an offered size, a primary image); a sale
   uses the same maximum-discount rule as a single sale. Everything is checked again on the server and audited.
   2026-10-01: the change is saved as a numbered draft change set (nothing changes yet), reviewed old → new and then applied. */
export default async function BulkEditPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }];
  if (!can(actor, 'products.write')) return <><PageHead title="Bulk edit" crumbs={crumbs} /><Forbidden permission="products.write" /></>;
  const sp = await searchParams;
  const parsed = productListQuery.safeParse({ q: one(sp.q), category: one(sp.category), status: one(sp.status), collection: one(sp.collection), stock: one(sp.stock) });
  const query: ProductListQuery = parsed.success ? parsed.data : { status: 'all', q: undefined, category: undefined, collection: undefined, stock: 'all' };
  const [products, categories, collections, attributes, limit, drafts, vendors] = await Promise.all([listProducts(db(), actor, query), listCategories(db(), actor),
    can(actor, 'categories.read') ? listCollections(db(), actor) : Promise.resolve([]), listAttributes(db(), actor), maxSaleDiscountPercent(db()),
    listBulkEditDrafts(db(), actor), can(actor, 'procurement.manage') ? listVendors(db(), actor) : Promise.resolve([])]);
  const top = categories.filter(c => !c.parent_id);
  const categoryOptions = top.flatMap(c => [{ value: c.id, label: c.label }, ...categories.filter(s => s.parent_id === c.id).map(s => ({ value: `${c.id}/${s.id}`, label: `${c.label} → ${s.label}` }))]);
  const actions = [
    { value: '', label: 'Choose a change…' },
    ...(can(actor, 'products.publish') ? [{ value: 'publish', label: 'Publish (show in the store)' }] : []), { value: 'draft', label: 'Move to draft (hide)' }, { value: 'archive', label: 'Archive' },
    { value: 'price_set', label: 'Set the price…' }, { value: 'price_percent', label: 'Change the price by %…' },
    { value: 'category', label: 'Move to category…' },
    ...(can(actor, 'categories.write') ? [{ value: 'collection_add', label: 'Add to collections…' }, { value: 'collection_remove', label: 'Remove from collections…' }] : []),
    { value: 'attribute_add', label: 'Add attribute values…' }, { value: 'attribute_remove', label: 'Remove attribute values…' },
    ...(can(actor, 'pricing.manage') ? [{ value: 'sale_percent', label: 'Put on sale (% off each price)…' }, { value: 'sale_clear', label: 'End the sale' }] : []),
    ...(vendors.length ? [{ value: 'vendor_add', label: 'Add a vendor (supplier)…' }, { value: 'vendor_remove', label: 'Remove a vendor…' }] : []),
  ];
  const pending = drafts.filter(d => d.status === 'draft');
  return (
    <>
      <PageHead title="Bulk edit products" crumbs={crumbs} eyebrow={`Select up to ${BULK_MAX_PRODUCTS} products and choose a change. It is saved as a draft for review (old → new for each product); nothing changes until it is applied.`} />
      {drafts.length > 0 && (
        <section className="card" aria-labelledby="bd-h" data-bulk-drafts>
          <h2 id="bd-h">Bulk edits{pending.length ? ` · ${pending.length} waiting to be applied` : ''}</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Number</th><th>Change</th><th className="num">Products</th><th>Status</th><th>Created</th><th>Applied</th></tr></thead>
            <tbody>{drafts.slice(0, 20).map(d => (
              <tr key={d.id} data-bulk-draft={d.number}>
                <td><Link href={`/products/bulk/${d.id}`} className="mono-strong">{d.number}</Link></td>
                <td>{(d.changes as { action: string }[]).map(c => actions.find(a => a.value === c.action)?.label.replace(/…$/, '') ?? c.action).join(', ')}</td>
                <td className="num">{d.products}</td>
                <td><StatusBadge status={d.status} /></td>
                <td>{formatDateTime(d.created_at as Date)}<div className="note">{d.created_by ?? ''}</div></td>
                <td>{d.applied_at ? <>{formatDateTime(d.applied_at as Date)}<div className="note">{d.applied_by ?? ''}</div></> : '—'}</td>
              </tr>))}</tbody>
          </table></div>
        </section>
      )}
      <FilterForm className="actions" role="search" aria-label="Filter products" data-bulk-filters>
        <label className="sr-only" htmlFor="bk-q">Search</label>
        <input id="bk-q" name="q" className="input" placeholder="Name or SKU" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="bk-s">Status</label>
        <select id="bk-s" name="status" className="input" defaultValue={query.status}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="draft">Draft</option><option value="review">Awaiting approval</option><option value="archived">Archived</option>
        </select>
        <label className="sr-only" htmlFor="bk-c">Category</label>
        <select id="bk-c" name="category" className="input" defaultValue={query.category ?? ''}>
          <option value="">All categories</option>{top.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {products.length === 0 ? <Empty title="No products match" kind="bulk" /> : (
        <ActionForm action={bulkEditAction} submitLabel="Save for review" className="form form-wide" id="bulk-edit-form" label="Bulk edit">
          <p className="note" data-bulk-count>{products.length} product{products.length === 1 ? '' : 's'} listed. Tick the ones to change (use the box in the header to tick all).</p>
          <div className="table-wrap"><table data-bulk-table>
            <thead><tr><th><SelectAll name="productIds[]" label="Select all listed products" /></th>
              <th>Product</th><th>Category</th><th className="num">Price</th><th>Status</th></tr></thead>
            <tbody>{products.map(p => (
              <tr key={p.id} data-bulk-row={p.sku}>
                <td><input type="checkbox" name="productIds[]" value={p.id} aria-label={`Select ${p.name}`} /></td>
                <td><b>{p.name}</b><div className="note mono">{p.sku}</div></td>
                <td>{p.categoryLabel}{p.subcategoryLabel && ` → ${p.subcategoryLabel}`}</td>
                <td className="num money">{formatPaise(p.pricePaise)}</td>
                <td><StatusBadge status={p.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          <fieldset className="fieldset" data-bulk-change>
            <legend>Change</legend>
            <Select name="action" label="What to change" options={actions} required />
            <div className="cols">
              <Select name="category" label="Category (for “Move to category”)" options={[{ value: '', label: '—' }, ...categoryOptions]} />
              {can(actor, 'pricing.manage') && <>
                <Field name="percent" label="% off (for “Put on sale”)" hint={limit ? `Maximum ${limit}% unless you hold the sale override permission.` : 'No maximum is set in Settings.'} />
                <Field name="startsAt" label="Sale starts (optional)" type="datetime-local" />
                <Field name="endsAt" label="Sale ends (optional)" type="datetime-local" />
              </>}
              <Field name="price" label="New price, ₹ (for “Set the price”)" />
              {!can(actor, 'pricing.manage') && <Field name="percent" label="% change (for “Change the price by %”, e.g. 10 or -5)" />}
              {vendors.length > 0 && <Select name="vendorId" label="Vendor (for “Add / Remove a vendor”)" options={[{ value: '', label: '—' }, ...vendors.filter(v => v.is_active).map(v => ({ value: v.id, label: v.name }))]} />}
            </div>
            {can(actor, 'pricing.manage') && <p className="note">The % field is used both for “Put on sale” (% off) and “Change the price by %” (e.g. 10 or -5).</p>}
            <p className="note">Sizes that have their own price keep it; put those on sale from each product’s pricing page.</p>
            {collections.length > 0 && <TagPicker name="collectionIds[]" label="Collections (for “Add to / Remove from collection”)" addLabel="+ Add collection" selected={[]}
              options={collections.map(c => ({ value: c.id, label: c.label }))} />}
            <div data-bulk-attributes><p className="note">Attribute values (for “Add / Remove attribute values”). Adding a value of a one-value attribute replaces the product’s current one.</p>
              {attributes.filter(a => a.values.length).map(a => <TagPicker key={a.id} name="attributeValues[]" label={a.label} addLabel={`+ Add ${a.label.toLowerCase()}`} selected={[]}
                single={a.selection === 'single'} options={a.values.map(v => ({ value: `${a.id}:${v.slug}`, label: v.label, swatch: v.swatch, inactive: !v.isActive }))} />)}
            </div>
          </fieldset>
          <TextArea name="note" label="Note for the reviewer (optional)" rows={2} />
        </ActionForm>
      )}
      <p className="note"><Link href="/products">Back to products</Link></p>
    </>
  );
}
