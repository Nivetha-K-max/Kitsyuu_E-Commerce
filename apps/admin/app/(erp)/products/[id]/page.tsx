import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, paiseToRupees, productId as productIdSchema } from '@kitsyuu/contracts';
import { getProduct, listAdjustmentReasons, listCategories } from '@kitsyuu/core';
import { ActionForm, Checkbox, DropzoneField, Field, Hidden, Select, TextArea } from '@/components/forms';
import { PriceForm, StockAdjustForm } from '@/components/CatalogueForms';
import { Empty, Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
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

/** A fixed identifier shown inside the details form; it is display only (not a form field). */
function Fixed({ label, value }: { label: string; value: string }) {
  return <div className="field"><span className="label">{label}</span><p className="static mono">{value}</p></div>;
}

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }];
  if (!can(actor, 'products.read')) return <><PageHead title="Product" section="Catalogue" crumbs={crumbs} /><Forbidden permission="products.read" /></>;
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
      <PageHead title={p.name} section="Catalogue" crumbs={crumbs} eyebrow={`SKU ${p.sku} · ID ${p.id}`}><StatusBadge status={p.status} /></PageHead>
      {created && <p className="msg ok" role="status" data-notice="created">Draft product created. Add sizes, stock and an image, then activate it.</p>}

      <section className="spec-strip" aria-label="Product record" data-section="overview">
        <dl data-product-facts>
          <div><dt>Product ID</dt><dd className="mono" data-fact="id">{p.id}</dd></div>
          <div><dt>SKU</dt><dd className="mono" data-fact="sku">{p.sku}</dd></div>
          <div><dt>Store URL</dt><dd className="mono">/product/{p.slug}</dd></div>
          <div><dt>Category</dt><dd data-fact="category">{p.category_label}{p.subcategory_label ? ` / ${p.subcategory_label}` : ''}</dd></div>
          <div><dt>Price</dt><dd data-fact="price"><b className="price">₹{paiseToRupees(p.price_paise)}</b> <span className="note">tax-inclusive</span></dd></div>
          <div><dt>Stock</dt><dd data-fact="stock">{variants ? <>{formatNumber(units)} units in {sellable.length} sizes{attention > 0 && <> · <span className="badge low_stock">{attention} low</span></>}</> : <span className="note">needs inventory.read</span>}</dd></div>
          <div><dt>Colour</dt><dd>{p.colour_label ?? '—'}</dd></div>
          <div><dt>Data</dt><dd>{p.data_status}</dd></div>
          <div><dt>Last changed</dt><dd>{formatDateTime(p.updated_at)}</dd></div>
        </dl>
      </section>

      <div className="product-layout">
        <aside className="product-aside" aria-label="Price, status and merchandising">
          <section className="card" aria-labelledby="price-h" data-section="price">
            <SectionTitle id="price-h">Pricing</SectionTitle>
            <p className="price-now" data-current-price>₹{paiseToRupees(p.price_paise)}</p>
            {write ? <PriceForm action={updatePriceAction} productId={p.id} currentPaise={p.price_paise} />
              : <p className="note" data-readonly="price">Changing the price needs the products.write permission.</p>}
          </section>

          <section className="card" aria-labelledby="status-h" data-section="status">
            <SectionTitle id="status-h">Status</SectionTitle>
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

          {newArrival && (
            <section className="card" aria-labelledby="na-h" data-section="new-arrivals">
              <SectionTitle id="na-h">New Arrivals</SectionTitle>
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
        </aside>

        <div className="product-main">
          {write && (
            <section className="card" aria-labelledby="det-h" data-section="details">
              <h2 id="det-h" className="sr-only">Product information</h2>
              <ActionForm action={updateProductAction} submitLabel="Save details" id="details-form" label="Product details" className="form record-form">
                <Hidden name="productId" value={p.id} />
                <fieldset className="block">
                  <legend>Basic information</legend>
                  <div className="cols">
                    <div className="span-2"><Field name="name" label="Name" defaultValue={p.name} required /></div>
                    <Fixed label="SKU" value={p.sku} />
                    <Fixed label="Slug" value={`/product/${p.slug}`} />
                  </div>
                  <TextArea name="description" label="Description" defaultValue={p.description} rows={5} />
                </fieldset>
                <fieldset className="block">
                  <legend>Classification</legend>
                  <div className="cols">
                    <Select name="categoryId" label="Category" defaultValue={p.category_id} required
                      options={categories.filter(c => !c.parent_id).map(c => ({ value: c.id, label: c.label }))} />
                    <Select name="subcategoryId" label="Subcategory" defaultValue={p.subcategory_id ?? ''} hint="Must belong to the chosen category."
                      options={[{ value: '', label: 'None' }, ...categories.filter(c => c.parent_id).map(c => ({ value: c.id, label: `${categories.find(x => x.id === c.parent_id)?.label} / ${c.label}` }))]} />
                  </div>
                  <Checkbox name="isFeatured" label="Featured in the store" defaultChecked={p.is_featured} />
                </fieldset>
                <fieldset className="block">
                  <legend>Product details</legend>
                  <div className="cols">
                    <Field name="colourLabel" label="Colour" defaultValue={p.colour_label ?? ''} />
                    <Field name="material" label="Material" defaultValue={p.material ?? ''} />
                    <Field name="care" label="Care" defaultValue={p.care ?? ''} />
                    <Field name="origin" label="Origin" defaultValue={p.origin ?? ''} />
                  </div>
                  <TextArea name="features" label="Features (one per line)" defaultValue={p.features.join('\n')} rows={4} />
                </fieldset>
              </ActionForm>
              <p className="note form-foot">Fields marked * are required. Product ID, SKU and store URL are fixed identifiers and cannot be edited. Status and price are saved separately in the side panel.</p>
            </section>
          )}

          <section className="card" aria-labelledby="img-h" data-section="images">
            <div className="section-head">
              <SectionTitle id="img-h">Media</SectionTitle>
              <span className="section-meta">{images.length} image{images.length === 1 ? '' : 's'}</span>
            </div>
            {images.length === 0 ? <Empty title="No images yet" kind="images" compact>Upload at least one image before activating the product.</Empty> : (
              <div className="media-grid">
                {images.map((i, n) => {
                  const src = productImageUrl(i.storage_path);
                  return (
                    <figure className="media-card" key={i.id} data-image={i.storage_path} data-primary={i.is_primary || undefined}>
                      <div className="media-thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {src ? <img src={src} alt={i.alt || p.name} loading="lazy" /> : <p className="note">Image URL not configured</p>}
                        <span className="media-index" aria-hidden="true">{String(n + 1).padStart(2, '0')}</span>
                        {i.is_primary && <span className="media-tag">Primary</span>}
                      </div>
                      <figcaption>
                        <span className="media-file" title={i.storage_path}>{i.storage_path.replace(/^products\//, '')}</span>
                        <span className="media-dim">{i.width ? `${i.width} × ${i.height}` : 'size unknown'}</span>
                      </figcaption>
                      {write && (
                        <div className="image-tools" data-image-tools={i.id}>
                          <ActionForm action={updateImageAction} submitLabel="Save alt" variant="ghost" className="form compact alt-form" label={`Alt text for image ${n + 1}`}>
                            <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} />
                            <Field name="alt" label="Alt text" defaultValue={i.alt} />
                          </ActionForm>
                          <div className="media-actions">
                            {!i.is_primary && <ActionForm action={setPrimaryImageAction} submitLabel="Set primary" variant="ghost" className="inline-form" label={`Make image ${n + 1} primary`}>
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
              <ActionForm action={uploadImageAction} submitLabel="Upload image" pendingLabel="Uploading…" id="upload-image-form" label="Upload an image" className="form upload-form" resetOnSuccess>
                <Hidden name="productId" value={p.id} />
                <DropzoneField name="file" title="Add product image" accept="image/jpeg,image/png,image/webp" formats="JPEG / PNG / WEBP · MAX 5 MB"
                  hint="Converted to WebP; the first image becomes the primary one." />
                <Field name="alt" label="Alt text" hint="Describe the image for people who cannot see it." />
              </ActionForm>
            ) : <p className="note" data-readonly="images">Changing images needs the products.write permission.</p>}
          </section>

          <section className="card" aria-labelledby="stock-h" data-section="stock">
            <SectionTitle id="stock-h">Inventory</SectionTitle>
            {!variants ? <p className="note">Viewing stock needs the inventory.read permission.</p> : variants.length === 0 ? <p className="empty">This product has no sizes.</p> : (
              <>
                <div className="table-wrap"><table data-variants-table>
                  <thead><tr><th>Size</th><th>SKU</th><th className="num">In stock</th><th className="num">Reorder at</th><th>Status</th><th>Price</th><th>Last movement</th></tr></thead>
                  <tbody>{variants.map(v => (
                    <tr key={v.variant_id} data-variant={v.variant_sku} data-level={v.is_active ? v.stock_status : 'off'}>
                      <td className="size-cell">{v.size}</td><td className="mono">{v.variant_sku}</td>
                      <td className="num qty" data-qty>{v.stock_qty}</td><td className="num">{v.reorder_level}</td>
                      <td>{v.is_active ? <StatusBadge status={v.stock_status} /> : <span className="badge">size not offered</span>}</td>
                      <td>{v.price_paise === null ? <span className="note">product price</span> : `₹${paiseToRupees(v.price_paise)}`}</td>
                      <td className="nowrap">{formatDateTime(v.last_movement_at)}</td>
                    </tr>))}
                  </tbody>
                </table></div>
                {adjust ? (
                  <>
                    <h3 className="sub">Adjust stock</h3>
                    <p className="note">Each change is recorded in the stock ledger with a reason.</p>
                    <div className="stock-forms" data-stock-forms>
                      {variants.map(v => (
                        <StockAdjustForm key={v.variant_id} action={adjustStockAction} productId={p.id} reasons={reasons}
                          variant={{ id: v.variant_id, sku: v.variant_sku, size: v.size, stockQty: v.stock_qty }} />
                      ))}
                    </div>
                  </>
                ) : <p className="note" data-readonly="stock">Adjusting stock needs the inventory.adjust permission.</p>}
              </>
            )}
          </section>

          {write && variants && (
            <section className="card" aria-labelledby="sizes-h" data-section="sizes">
              <SectionTitle id="sizes-h">Sizes</SectionTitle>
              <p className="note">A size&apos;s SKU never changes (orders keep it) and sizes are not deleted: turn &quot;Offered&quot; off instead. New sizes start at 0 units; add stock with a restock adjustment above.</p>
              <div className="stock-forms" data-size-forms>
                {variants.map((v, n) => (
                  <div className="stock-form" key={v.variant_id} data-size={v.variant_sku}>
                    <p className="stock-form-head"><b>{v.size}</b><span className="mono">{v.variant_sku}</span></p>
                    <ActionForm action={updateVariantAction} submitLabel="Save size" variant="ghost" className="form compact" id={`size-${v.variant_sku}`} label={`Settings for size ${v.size}`}>
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
              <ActionForm action={addVariantAction} submitLabel="Add size" id="add-size-form" label="Add a size" className="form add-size" resetOnSuccess>
                <Hidden name="productId" value={p.id} />
                <Field name="size" label="New size" autoComplete="off" hint={`e.g. XXL, 32, FREE. The SKU becomes ${p.sku}-<SIZE>.`} />
              </ActionForm>
            </section>
          )}

          {movements && (
            <section className="card" aria-labelledby="mv-h" data-section="movements">
              <SectionTitle id="mv-h">Stock movements</SectionTitle>
              {movements.length === 0 ? <p className="empty">No stock movements yet.</p> : (
                <div className="table-wrap"><table data-movements-table>
                  <thead><tr><th>When</th><th>SKU</th><th className="num">Change</th><th className="num">Balance after</th><th>Reason</th><th>By</th><th>Note</th></tr></thead>
                  <tbody>{movements.map(m => (
                    <tr key={m.id} data-movement={m.sku}>
                      <td className="nowrap">{formatDateTime(m.created_at)}</td><td className="mono">{m.sku}</td>
                      <td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td className="num">{m.balance_after ?? '—'}</td>
                      <td>{m.reason}</td><td>{m.staff_email ?? <span className="note">system</span>}</td><td>{m.note ?? ''}</td>
                    </tr>))}
                  </tbody>
                </table></div>
              )}
              {can(actor, 'audit.read') && <p className="section-foot"><Link className="btn ghost" href="/audit?entityType=product_variants">Stock changes in the audit log</Link></p>}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
