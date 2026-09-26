import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, paiseToRupees, productId as productIdSchema } from '@kitsyuu/contracts';
import { getProduct, listAdjustmentReasons, listCategories } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, FileField, Hidden, Select, TextArea } from '@/components/forms';
import { PriceForm, StockAdjustForm } from '@/components/CatalogueForms';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { adjustStockAction, setProductStatusAction, updatePriceAction, updateProductAction } from '../actions';
import { addVariantAction, moveImageAction, moveNewArrivalAction, moveVariantAction, newArrivalAction, removeImageAction, setPrimaryImageAction, updateImageAction, updateVariantAction, uploadImageAction } from '../manage-actions';

export const metadata: Metadata = { title: 'Product' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

const STATUS_HELP: Record<string, string> = {
  active: 'Visible and purchasable in the store.',
  draft: 'Hidden from the store (not ready yet).',
  archived: 'Hidden from the store (retired). Nothing is deleted.',
};

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }];
  if (!can(actor, 'products.read')) return <><PageHead title="Product" crumbs={crumbs} /><Forbidden permission="products.read" /></>;
  const { id } = await params;
  if (!productIdSchema.safeParse(id).success) notFound();
  const { product: p, images, variants, movements, newArrival } = await getProduct(db(), actor, id)
    .catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const write = can(actor, 'products.write'), adjust = can(actor, 'inventory.adjust'), catWrite = can(actor, 'categories.write');
  const created = (await searchParams).notice === 'created';
  const [categories, reasons] = await Promise.all([
    write ? listCategories(db(), actor) : Promise.resolve([]),
    adjust ? listAdjustmentReasons(db(), actor) : Promise.resolve([]),
  ]);
  const sellable = variants?.filter(v => v.is_active) ?? [];
  const units = sellable.reduce((n, v) => n + v.stock_qty, 0);
  const attention = sellable.filter(v => v.stock_status !== 'in_stock').length;

  return (
    <>
      <PageHead title={p.name} eyebrow={`${p.id} · ${p.sku}`} crumbs={crumbs}><StatusBadge status={p.status} /></PageHead>
      {created && <p className="msg ok" role="status" data-notice="created">Draft product created. Add sizes, stock and an image, then activate it.</p>}

      <div className="grid two">
        <section className="card" aria-labelledby="ov-h" data-section="overview">
          <h2 id="ov-h">Overview</h2>
          <dl className="facts" data-product-facts>
            <dt>Product ID</dt><dd className="mono" data-fact="id">{p.id}</dd>
            <dt>SKU</dt><dd className="mono" data-fact="sku">{p.sku}</dd>
            <dt>Store URL</dt><dd className="mono">/product/{p.slug}</dd>
            <dt>Category</dt><dd data-fact="category">{p.category_label}{p.subcategory_label ? ` / ${p.subcategory_label}` : ''}</dd>
            <dt>Price</dt><dd data-fact="price"><b className="price">₹{paiseToRupees(p.price_paise)}</b> <span className="note">tax-inclusive</span></dd>
            <dt>Stock</dt><dd data-fact="stock">{variants ? <>{formatNumber(units)} units in {sellable.length} sizes{attention > 0 && <> · <span className="badge low_stock">{attention} low</span></>}</> : <span className="note">needs inventory.read</span>}</dd>
            <dt>Colour</dt><dd>{p.colour_label ?? '—'}</dd>
            <dt>Data</dt><dd>{p.data_status}</dd>
            <dt>Last changed</dt><dd>{formatDateTime(p.updated_at)}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="img-h" data-section="images">
          <h2 id="img-h">Images</h2>
          {images.length === 0 ? <p className="empty" data-empty="images">No images for this product.</p> : (
            <div className="gallery">
              {images.map((i, n) => {
                const src = productImageUrl(i.storage_path);
                return (
                  <figure key={i.id} data-image={i.storage_path} data-primary={i.is_primary || undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {src ? <img src={src} alt={i.alt || p.name} loading="lazy" /> : <div className="note">Image URL not configured</div>}
                    <figcaption className="note mono">{i.storage_path.replace(/^products\//, '')}{i.is_primary ? ' · primary' : ''}{i.width ? ` · ${i.width}×${i.height}` : ''}</figcaption>
                    {write && (
                      <div className="image-tools" data-image-tools={i.id}>
                        <ActionForm action={updateImageAction} submitLabel="Save alt" className="form compact" label={`Alt text for image ${n + 1}`}>
                          <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} />
                          <Field name="alt" label="Alt text" defaultValue={i.alt} />
                        </ActionForm>
                        <div className="actions">
                          {!i.is_primary && <ActionForm action={setPrimaryImageAction} submitLabel="Make primary" variant="ghost" className="inline-form" label={`Make image ${n + 1} primary`}>
                            <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} /></ActionForm>}
                          {n > 0 && <ActionForm action={moveImageAction} submitLabel="←" variant="ghost" className="inline-form" label={`Move image ${n + 1} earlier`}>
                            <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} /><Hidden name="direction" value="up" /></ActionForm>}
                          {n < images.length - 1 && <ActionForm action={moveImageAction} submitLabel="→" variant="ghost" className="inline-form" label={`Move image ${n + 1} later`}>
                            <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} /><Hidden name="direction" value="down" /></ActionForm>}
                          <ActionForm action={removeImageAction} submitLabel="Remove" variant="danger" className="inline-form" label={`Remove image ${n + 1}`}
                            confirmText={`Remove this image${i.is_primary && images.length > 1 ? ' (the next image becomes primary)' : ''}? The file is deleted.`}>
                            <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} /></ActionForm>
                        </div>
                      </div>
                    )}
                  </figure>
                );
              })}
            </div>
          )}
          {write ? (
            <ActionForm action={uploadImageAction} submitLabel="Upload image" pendingLabel="Uploading…" id="upload-image-form" label="Upload an image" resetOnSuccess>
              <Hidden name="productId" value={p.id} />
              <FileField name="file" label="Image file" accept="image/jpeg,image/png,image/webp" hint="JPEG, PNG or WebP, at most 5 MB. Converted to WebP; the first image becomes the primary one." />
              <Field name="alt" label="Alt text" hint="Describe the image for people who cannot see it." />
            </ActionForm>
          ) : <p className="note" data-readonly="images">Changing images needs the products.write permission.</p>}
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card" aria-labelledby="price-h" data-section="price">
          <h2 id="price-h">Price</h2>
          <p className="price-now" data-current-price>₹{paiseToRupees(p.price_paise)}</p>
          {write ? <PriceForm action={updatePriceAction} productId={p.id} currentPaise={p.price_paise} />
            : <p className="note" data-readonly="price">Changing the price needs the products.write permission.</p>}
        </section>
        <section className="card" aria-labelledby="status-h" data-section="status">
          <h2 id="status-h">Status</h2>
          <p className="note">{STATUS_HELP[p.status]}</p>
          {write ? (
            <ActionForm action={setProductStatusAction} submitLabel="Save status" id="status-form" label="Product status"
              confirmText={p.status === 'active' ? 'Deactivating hides this product from the store. Continue?' : undefined}>
              <Hidden name="productId" value={p.id} />
              <Select name="status" label="Status" defaultValue={p.status}
                options={[{ value: 'active', label: 'Active (in the store)' }, { value: 'draft', label: 'Draft (hidden)' }, { value: 'archived', label: 'Archived (hidden)' }]} />
            </ActionForm>
          ) : <p className="note" data-readonly="status">Changing the status needs the products.write permission.</p>}
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }} aria-labelledby="stock-h" data-section="stock">
        <h2 id="stock-h">Stock by size</h2>
        {!variants ? <p className="note">Viewing stock needs the inventory.read permission.</p> : variants.length === 0 ? <p className="empty">This product has no sizes.</p> : (
          <>
            <div className="table-wrap"><table data-variants-table>
              <thead><tr><th>Size</th><th>SKU</th><th className="num">In stock</th><th className="num">Reorder at</th><th>Status</th><th>Price</th><th>Last movement</th></tr></thead>
              <tbody>{variants.map(v => (
                <tr key={v.variant_id} data-variant={v.variant_sku}>
                  <td>{v.size}</td><td className="mono">{v.variant_sku}</td>
                  <td className="num" data-qty>{v.stock_qty}</td><td className="num">{v.reorder_level}</td>
                  <td>{v.is_active ? <StatusBadge status={v.stock_status} /> : <span className="badge">size not offered</span>}</td>
                  <td>{v.price_paise === null ? <span className="note">product price</span> : `₹${paiseToRupees(v.price_paise)}`}</td>
                  <td>{formatDateTime(v.last_movement_at)}</td>
                </tr>))}
              </tbody>
            </table></div>
            {adjust ? (
              <div className="stock-forms" data-stock-forms>
                {variants.map(v => (
                  <StockAdjustForm key={v.variant_id} action={adjustStockAction} productId={p.id} reasons={reasons}
                    variant={{ id: v.variant_id, sku: v.variant_sku, size: v.size, stockQty: v.stock_qty }} />
                ))}
              </div>
            ) : <p className="note" data-readonly="stock" style={{ marginTop: 10 }}>Adjusting stock needs the inventory.adjust permission.</p>}
          </>
        )}
      </section>

      {write && variants && (
        <section className="card" style={{ marginTop: 14 }} aria-labelledby="sizes-h" data-section="sizes">
          <h2 id="sizes-h">Sizes</h2>
          <p className="note">A size&apos;s SKU never changes (orders keep it) and sizes are not deleted: turn &quot;Offered&quot; off instead. New sizes start at 0 units; add stock with a restock adjustment above.</p>
          <div className="stock-forms" data-size-forms>
            {variants.map((v, n) => (
              <div className="stock-form" key={v.variant_id} data-size={v.variant_sku}>
                <p className="mono" style={{ margin: 0 }}>{v.variant_sku}</p>
                <ActionForm action={updateVariantAction} submitLabel="Save size" className="form compact" id={`size-${v.variant_sku}`} label={`Settings for size ${v.size}`}>
                  <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="expectedVersion" value={v.version} />
                  <Checkbox name="isActive" label="Offered in the store" defaultChecked={v.is_active} />
                  <Field name="price" label="Price override (₹)" defaultValue={v.price_paise === null ? '' : paiseToRupees(v.price_paise).replace(/,/g, '')} hint="Blank = product price." />
                  <Field name="reorderLevel" label="Reorder level" defaultValue={v.own_reorder_level === null ? '' : String(v.own_reorder_level)} hint={`Blank = default (${v.reorder_level}).`} />
                </ActionForm>
                <div className="actions">
                  {n > 0 && <ActionForm action={moveVariantAction} submitLabel="↑ Earlier" variant="ghost" className="inline-form" label={`Move size ${v.size} earlier`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="direction" value="up" /></ActionForm>}
                  {n < variants.length - 1 && <ActionForm action={moveVariantAction} submitLabel="↓ Later" variant="ghost" className="inline-form" label={`Move size ${v.size} later`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="direction" value="down" /></ActionForm>}
                </div>
              </div>
            ))}
          </div>
          <ActionForm action={addVariantAction} submitLabel="Add size" id="add-size-form" label="Add a size" resetOnSuccess>
            <Hidden name="productId" value={p.id} />
            <Field name="size" label="New size" autoComplete="off" hint={`e.g. XXL, 32, FREE. The SKU becomes ${p.sku}-<SIZE>.`} />
          </ActionForm>
        </section>
      )}

      {newArrival && (
        <section className="card" style={{ marginTop: 14 }} aria-labelledby="na-h" data-section="new-arrivals">
          <h2 id="na-h">New Arrivals</h2>
          <p data-new-arrival={newArrival.member ? 'yes' : 'no'}>{newArrival.member ? <>In New Arrivals, position {newArrival.rank} of {newArrival.count}.</> : 'Not in New Arrivals.'}</p>
          {catWrite ? (
            <div className="actions">
              <ActionForm action={newArrivalAction} submitLabel={newArrival.member ? 'Remove from New Arrivals' : 'Add to New Arrivals'} variant="ghost" className="inline-form" id="new-arrival-form" label="New Arrivals membership">
                <Hidden name="productId" value={p.id} /><Hidden name="member" value={newArrival.member ? 'off' : 'on'} />
              </ActionForm>
              {newArrival.member && (newArrival.rank ?? 1) > 1 && <ActionForm action={moveNewArrivalAction} submitLabel="↑ Earlier" variant="ghost" className="inline-form" id="na-up" label="Move earlier in New Arrivals">
                <Hidden name="productId" value={p.id} /><Hidden name="direction" value="up" /></ActionForm>}
              {newArrival.member && (newArrival.rank ?? 0) < (newArrival.count ?? 0) && <ActionForm action={moveNewArrivalAction} submitLabel="↓ Later" variant="ghost" className="inline-form" id="na-down" label="Move later in New Arrivals">
                <Hidden name="productId" value={p.id} /><Hidden name="direction" value="down" /></ActionForm>}
            </div>
          ) : <p className="note" data-readonly="new-arrivals">Changing New Arrivals needs the categories.write permission.</p>}
        </section>
      )}

      {movements && (
        <section className="card" style={{ marginTop: 14 }} aria-labelledby="mv-h" data-section="movements">
          <h2 id="mv-h">Recent stock movements</h2>
          {movements.length === 0 ? <p className="empty">No stock movements yet.</p> : (
            <div className="table-wrap"><table data-movements-table>
              <thead><tr><th>When</th><th>SKU</th><th className="num">Change</th><th className="num">Balance after</th><th>Reason</th><th>By</th><th>Note</th></tr></thead>
              <tbody>{movements.map(m => (
                <tr key={m.id} data-movement={m.sku}>
                  <td>{formatDateTime(m.created_at)}</td><td className="mono">{m.sku}</td>
                  <td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td className="num">{m.balance_after ?? '—'}</td>
                  <td>{m.reason}</td><td>{m.staff_email ?? <span className="note">system</span>}</td><td>{m.note ?? ''}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
          {can(actor, 'audit.read') && <p style={{ marginTop: 10 }}><Link className="btn ghost" href="/audit?entityType=product_variants">Stock changes in the audit log</Link></p>}
        </section>
      )}

      {write && (
        <section className="card" style={{ marginTop: 14 }} aria-labelledby="det-h" data-section="details">
          <h2 id="det-h">Details</h2>
          <ActionForm action={updateProductAction} submitLabel="Save details" id="details-form" label="Product details">
            <Hidden name="productId" value={p.id} />
            <Field name="name" label="Name" defaultValue={p.name} />
            <TextArea name="description" label="Description" defaultValue={p.description} rows={5} />
            <Select name="categoryId" label="Category" defaultValue={p.category_id}
              options={categories.filter(c => !c.parent_id).map(c => ({ value: c.id, label: c.label }))} />
            <Select name="subcategoryId" label="Subcategory" defaultValue={p.subcategory_id ?? ''} hint="Must belong to the chosen category."
              options={[{ value: '', label: 'None' }, ...categories.filter(c => c.parent_id).map(c => ({ value: c.id, label: `${categories.find(x => x.id === c.parent_id)?.label} / ${c.label}` }))]} />
            <Field name="colourLabel" label="Colour" defaultValue={p.colour_label ?? ''} />
            <TextArea name="features" label="Features (one per line)" defaultValue={p.features.join('\n')} rows={4} />
            <Field name="material" label="Material" defaultValue={p.material ?? ''} />
            <Field name="care" label="Care" defaultValue={p.care ?? ''} />
            <Field name="origin" label="Origin" defaultValue={p.origin ?? ''} />
            <Checkbox name="isFeatured" label="Featured in the store" defaultChecked={p.is_featured} />
          </ActionForm>
          <p className="note">Product ID, SKU and store URL are fixed identifiers and cannot be edited.</p>
        </section>
      )}
    </>
  );
}
