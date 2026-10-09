import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { can } from '@kitsyuu/auth';
import { sql } from '@kitsyuu/db';
import { NotFoundError, paiseToRupees, productId as productIdSchema } from '@kitsyuu/contracts';
import {
  discountAmount, getProduct, getProductAttributes, getProductCollections, getProductPricing, listAdjustmentReasons, listAttributes, listCategories, listCollections, listColours,
  listDiscounts, listRelated, productActivity, productProduction, productReviews, productSales, sizeChartForProduct, stockByLocation,
} from '@kitsyuu/core';
import TagPicker from '@/components/TagPicker';
import { ActionForm, Checkbox, DropzoneField, Field, Hidden, Select, TextArea } from '@/components/forms';
import { PriceForm, StockAdjustForm } from '@/components/CatalogueForms';
import { Entity, Facts, Figures, Section, StateBlock, type EntityTab } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer, MoreMenu, type MoreItem } from '@/components/overlays';
import { ProductStatusPill } from '@/components/StatusPill';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { istLocal, rupeesField } from '@/lib/erp';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { setProductCollectionsAction } from '../../collections/actions';
import { StagePill } from '../../orders/order-ui';
import { PaymentPill } from '../../payments/payment-ui';
import { setBarcodeAction } from '../../pos/actions';
import { moderateReviewAction } from '../../reviews/actions';
import { cancelPriceChangeAction, schedulePriceAction, setPricingAction, setSaleAction } from '../../pricing/actions';
import { adjustStockAction, setMinPriceAction, setProductAttributesAction, setProductStatusAction, updatePriceAction, updateProductAction } from '../actions';
import { addColourVariantAction, setImageColourAction, setVariantColourAction } from '../colour-actions';
import {
  addRelatedAction, addVariantAction, moveImageAction, moveNewArrivalAction, moveRelatedAction, moveVariantAction, newArrivalAction, removeImageAction, removeRelatedAction,
  setPrimaryImageAction, updateImageAction, updateVariantAction, uploadImageAction,
} from '../manage-actions';

/** The initial-stock rows written by the catalogue seed carry an internal note; the reason ("Initial stock") says it all. */
const SEED_NOTE = 'Prototype demo stock';

export const metadata: Metadata = { title: 'Product' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS_HELP: Record<string, string> = {
  active: 'Visible and purchasable in the store.',
  draft: 'Hidden from the store (not ready yet). When it is complete, submit it for approval.',
  review: 'Submitted for approval: hidden from the store until an admin publishes it.',
  archived: 'Hidden from the store (retired). Nothing is deleted.',
};
/* One product: the product control centre (2026-10-08, same entity frame as the order and the customer).

     header (name, status, image, SKU, category, price, stock, the main action for its status, More)
     tabs   Overview · Variants & Stock · Pricing · Media · Merchandising · Sales · Reviews · Production · Activity

   Each tab loads only what it shows. The product owns its own record (details, sizes, prices, images); everything else
   is shown from the module that owns it and opens there: stock is the Inventory ledger, discounts are made under
   Pricing & discounts, categories / collections / attributes / size charts under Catalogue setup, a sale opens its
   Order, a production order opens in Production, and reviews are moderated with the Reviews queue's own action. */
const TABS = ['overview', 'variants', 'pricing', 'media', 'merchandising', 'sales', 'reviews', 'production', 'activity'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', variants: 'Variants & Stock', pricing: 'Pricing', media: 'Media', merchandising: 'Merchandising',
  sales: 'Sales', reviews: 'Reviews', production: 'Production', activity: 'Activity' };

const words = (s: string) => s.replace(/[._]/g, ' ');

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'products.read')) return <><PageHead title="Product" section="Catalogue" crumbs={[{ href: '/products', label: 'Products' }]} /><Forbidden permission="products.read" /></>;
  const { id } = await params;
  if (!productIdSchema.safeParse(id).success) notFound();
  const sp = await searchParams;
  const { product: p, images, variants, movements, newArrival } = await getProduct(db(), actor, id)
    .catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const write = can(actor, 'products.write'), adjust = can(actor, 'inventory.adjust'), catWrite = can(actor, 'categories.write');
  // A tab is offered only when its module's read permission is held (the tab's data is checked again on the server).
  const allowed: Record<Tab, boolean> = { overview: true, variants: true, pricing: true, media: true, merchandising: true, sales: can(actor, 'orders.read'),
    reviews: can(actor, 'reviews.read'), production: can(actor, 'production.read'), activity: can(actor, 'audit.read') };
  const wanted = one(sp.tab) as Tab | undefined;
  const tab: Tab = wanted && TABS.includes(wanted) && allowed[wanted] ? wanted : 'overview';
  const tabs: EntityTab[] = TABS.filter(t => allowed[t]).map(t => ({ id: t, label: TAB_LABEL[t] }));
  const self = `/products/${p.id}`;
  const tabHref = (t: string) => (t === 'overview' ? self : `${self}?tab=${t}`);

  const sellable = variants?.filter(v => v.is_active) ?? [];
  const units = sellable.reduce((n, v) => n + v.stock_qty, 0);
  const attention = sellable.filter(v => v.stock_status !== 'in_stock').length;
  const primary = images.find(i => i.is_primary) ?? images[0];
  const thumb = primary ? productImageUrl(primary.storage_path) : null;
  const store = process.env.STORE_URL?.replace(/\/+$/, '') || null;
  const canPublish = can(actor, 'products.publish');
  const quick = (status: 'active' | 'review', text: string, pending: string) => (
    <ActionForm action={setProductStatusAction} submitLabel={text} pendingLabel={pending} className="inline-form ent-quick" id={`quick-${status}-form`} label={text}>
      <Hidden name="productId" value={p.id} /><Hidden name="status" value={status} />
    </ActionForm>
  );

  // Rare actions: each opens the place on this page (or the module) that does it. Shown only to those who may do it.
  const more: MoreItem[] = [
    ...(write ? [{ label: 'Edit details', href: `${self}#det-h` }, { label: 'Change status…', href: `${self}#status-h` }] : []),
    ...(write || can(actor, 'pricing.manage') ? [{ label: 'Change price', href: `${self}?tab=pricing` }] : []),
    ...(adjust && variants && variants.length > 0 ? [{ label: 'Adjust stock', href: `${self}?tab=variants#adjust-h` }] : []),
    ...(write ? [{ label: 'Add an image', href: `${self}?tab=media#upload-h` }] : []),
    ...(variants ? [{ label: 'Open in Inventory', href: `/inventory?q=${encodeURIComponent(p.id)}` }] : []),
  ];

  /* The product's details (name, description, classification, specification, search engines) are saved together by one
     action, so they are one form in a drawer: opened from Overview, and from Merchandising to change the category. */
  type Category = Awaited<ReturnType<typeof listCategories>>[number];
  const detailsDrawer = (trigger: string, categories: Category[]) => (
    <Drawer trigger={trigger} triggerClass="btn ghost sm" name="details" scope="ord" title="Product details"
      description="The name, description, category and specification shown in the store. Every change is recorded in the activity.">
      <ActionForm action={updateProductAction} submitLabel="Save details" id="details-form" label="Product details">
        <Hidden name="productId" value={p.id} />
        <Field name="name" label="Name" defaultValue={p.name} required />
        <TextArea name="description" label="Description" defaultValue={p.description} rows={5} />
        <h3 className="drawer-sub">Classification</h3>
        <Select name="categoryId" label="Category" defaultValue={p.category_id} required
          options={categories.filter(c => !c.parent_id).map(c => ({ value: c.id, label: c.label }))} />
        <Select name="subcategoryId" label="Subcategory" defaultValue={p.subcategory_id ?? ''} hint="Must belong to the chosen category."
          options={[{ value: '', label: 'None' }, ...categories.filter(c => c.parent_id).map(c => ({ value: c.id, label: `${categories.find(x => x.id === c.parent_id)?.label} / ${c.label}` }))]} />
        <Checkbox name="isFeatured" label="Featured in the store" defaultChecked={p.is_featured} />
        <h3 className="drawer-sub">Specification</h3>
        <div className="cols">
          <Field name="colourLabel" label="Colour" defaultValue={p.colour_label ?? ''} />
          <Field name="material" label="Material" defaultValue={p.material ?? ''} />
          <Field name="care" label="Care" defaultValue={p.care ?? ''} />
          <Field name="origin" label="Origin" defaultValue={p.origin ?? ''} />
        </div>
        <Field name="hsnCode" label="HSN code" defaultValue={p.hsn_code ?? ''} hint="4, 6 or 8 digits. Used on GST invoices." />
        <TextArea name="features" label="Features (one per line)" defaultValue={p.features.join('\n')} rows={4} />
        <h3 className="drawer-sub">Search engines</h3>
        <Field name="seoTitle" label="SEO title" defaultValue={p.seo_title ?? ''} hint="Optional, up to 70 characters. Empty: the name is used." />
        <TextArea name="seoDescription" label="SEO description" defaultValue={p.seo_description ?? ''} rows={2} hint="Optional, up to 160 characters." />
      </ActionForm>
    </Drawer>
  );

  /* Activity: the audit log rows about this product. Core returns the product's own rows (the record, its sizes and its
     images, which includes stock adjustments and price changes); the rows other modules recorded about it are read here
     from the same log: review moderation, collection membership, production orders and scheduled price changes. Each
     audit row is one event, so nothing is listed twice. */
  type Act = { id: string | number; occurred_at: Date; actor_type: string; action: string; entity_type: string; staff_email: string | null; before_data: unknown; after_data: unknown };
  const loadActivity = async (): Promise<Act[]> => {
    const [own, reviewIds, productionIds, changeIds] = await Promise.all([
      productActivity(db(), actor, id),
      db().selectFrom('reviews').select('id').where('product_id', '=', id).execute(),
      db().selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').select('o.id').where('v.product_id', '=', id).execute(),
      db().selectFrom('price_changes').select('id').where('product_id', '=', id).execute(),
    ]);
    const groups = ([['reviews', reviewIds], ['production_orders', productionIds], ['price_changes', changeIds]] as const).filter(g => g[1].length > 0);
    const related: Act[] = await db().selectFrom('audit_logs as a').leftJoin('staff_users as s', 's.id', 'a.staff_id')
      .select(['a.id', 'a.occurred_at', 'a.actor_type', 'a.action', 'a.entity_type', 's.email as staff_email', 'a.before_data', 'a.after_data'])
      .where(eb => eb.or([
        ...groups.map(([type, rows]) => eb.and([eb('a.entity_type', '=', type), eb('a.entity_id', 'in', rows.map(r => String(r.id)))])),
        eb.and([eb('a.entity_type', '=', 'collections'), eb(sql<string>`a.metadata->>'product_id'`, '=', id)]),
      ])).orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(100).execute();
    const seen = new Set<string>();
    return [...own, ...related].filter(a => !seen.has(String(a.id)) && !!seen.add(String(a.id)))
      .sort((x, y) => new Date(y.occurred_at).getTime() - new Date(x.occurred_at).getTime() || Number(y.id) - Number(x.id)).slice(0, 100);
  };
  const shown = (key: string, v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' && key.endsWith('_paise') ? formatPaise(v)
    : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : '…') : String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v));
  const changes = (b: unknown, a: unknown) => {
    const before = (b ?? {}) as Record<string, unknown>, after = (a ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.slice(0, 4).map(k => `${words(k.replace(/_paise$/, ''))}: ${k in before ? `${shown(k, before[k])} → ` : ''}${shown(k, after[k])}`).join(' · ') + (keys.length > 4 ? ` · and ${keys.length - 4} more` : '');
  };
  const ABOUT: Record<string, string> = { products: 'product', product_variants: 'size', product_images: 'image', reviews: 'review', collections: 'collection', production_orders: 'production', price_changes: 'scheduled price' };
  const timeline = (rows: Act[]) => (
    <ol className="timeline" data-product-activity>
      {rows.map(a => (
        <li key={String(a.id)} data-timeline={a.entity_type} data-action={a.action}>
          <b>{words(a.action)}</b>
          <span className="note"> · {ABOUT[a.entity_type] ?? words(a.entity_type)} · {formatDateTime(a.occurred_at)} · {a.staff_email ?? a.actor_type}</span>
          {(a.before_data || a.after_data) && changes(a.before_data, a.after_data) ? <div className="note">{changes(a.before_data, a.after_data)}</div> : null}
        </li>
      ))}
    </ol>
  );

  let body: ReactNode;
  // ---------------------------------------------------------------- Overview: what it is, where it stands, what needs someone
  if (tab === 'overview') {
    const [categories, collections, inCollections, sales, reviews, production, activity] = await Promise.all([
      write ? listCategories(db(), actor) : Promise.resolve([]),
      can(actor, 'categories.read') ? listCollections(db(), actor) : Promise.resolve([]),
      getProductCollections(db(), actor, id),
      allowed.sales ? productSales(db(), actor, id) : Promise.resolve(null),
      allowed.reviews ? productReviews(db(), actor, id) : Promise.resolve(null),
      allowed.production ? productProduction(db(), actor, id) : Promise.resolve(null),
      allowed.activity ? loadActivity() : Promise.resolve(null),
    ]);
    const hidden = p.status === 'draft' || p.status === 'review';
    const noImage = !images.some(i => i.is_primary), noSize = !!variants && sellable.length === 0;
    const short = sellable.filter(v => v.stock_status !== 'in_stock');
    const inNames = collections.filter(c => inCollections.includes(c.id)).map(c => c.label);
    const making = production?.filter(o => o.status === 'planned' || o.status === 'in_progress') ?? [];
    const warn = (hidden && (noImage || noSize)) || p.status === 'review' || short.length > 0 || (reviews?.counts.pending ?? 0) > 0;
    body = (
      <>
        {warn && (
          <Section id="att-h" title="Needs attention" name="attention" wide>
            <ul className="ord-warnings" data-product-attention>
              {p.status === 'review' && <li data-warning="approval">Waiting for approval{p.submitted_at ? ` since ${formatDateTime(p.submitted_at as Date)}` : ''}{p.submitted_by ? ` (submitted by ${p.submitted_by})` : ''}. It is hidden from the store until an admin publishes it.</li>}
              {hidden && noImage && <li data-warning="image">No image yet: a product needs a primary image before it can be submitted or published. <NavLink href={tabHref('media')}>Add an image</NavLink></li>}
              {hidden && noSize && <li data-warning="size">No size is offered: add at least one before it can be submitted or published. <NavLink href={tabHref('variants')}>Add a size</NavLink></li>}
              {short.length > 0 && <li data-warning="stock">{short.length} of {sellable.length} offered {sellable.length === 1 ? 'size is' : 'sizes are'} low or out of stock ({short.map(v => `${v.size}: ${v.stock_qty}`).join(', ')}). <NavLink href={tabHref('variants')}>Variants &amp; Stock</NavLink></li>}
              {reviews && reviews.counts.pending > 0 && <li data-warning="reviews">{reviews.counts.pending} review{reviews.counts.pending === 1 ? ' is' : 's are'} waiting for moderation. <NavLink href={tabHref('reviews')}>Reviews</NavLink></li>}
            </ul>
          </Section>
        )}

        <Section id="det-h" title="Product" name="details" hint="What customers see on the product page. The product ID, SKU and store URL are fixed: orders keep them.">
          <Facts attr="data-product-record" items={[
            { label: 'Description', value: p.description ? <span className="ent-clamp">{p.description}</span> : '—' },
            { label: 'Colour', value: p.colour_label ?? '—' },
            { label: 'Material', value: p.material ?? '—' },
            ...(p.care ? [{ label: 'Care', value: p.care }] : []),
            ...(p.origin ? [{ label: 'Origin', value: p.origin }] : []),
            { label: 'HSN code', value: p.hsn_code ?? '—' },
            { label: 'Product ID', value: <span className="mono">{p.id}</span>, attr: 'id' },
            { label: 'Store URL', value: <span className="mono">/product/{p.slug}</span> },
            { label: 'Last changed', value: formatDateTime(p.updated_at) },
          ]} />
          {write ? detailsDrawer('Edit details', categories) : <p className="note" data-readonly="details">Changing the details needs the products.write permission.</p>}
        </Section>

        <Section id="status-h" title="Status" name="status" hint={STATUS_HELP[p.status]}>
          <Facts items={[
            { label: 'Status', value: <ProductStatusPill status={p.status} /> },
            ...(p.submitted_at ? [{ label: 'Submitted', value: <span data-approval="submitted">{formatDateTime(p.submitted_at as Date)}{p.submitted_by ? ` by ${p.submitted_by}` : ''}</span> }] : []),
            ...(p.approved_at ? [{ label: 'Published', value: <span data-approval="published">{formatDateTime(p.approved_at as Date)}{p.approved_by ? ` by ${p.approved_by}` : ''}</span> }] : []),
          ]} />
          {write ? (
            <Drawer trigger="Change status…" triggerClass="btn ghost sm" name="status" scope="ord" title="Product status"
              description={canPublish ? 'Only a published product is visible in the store. Nothing is deleted by hiding it.' : 'A draft is submitted for approval; publishing in the store is done by an admin (products.publish).'}>
              <ActionForm action={setProductStatusAction} submitLabel="Save status" id="status-form" label="Product status"
                confirmText={p.status === 'active' ? 'Deactivating hides this product from the store. Continue?' : undefined}>
                <Hidden name="productId" value={p.id} />
                <Select name="status" label="Status" defaultValue={p.status}
                  options={[...(canPublish || p.status === 'active' ? [{ value: 'active', label: 'Published (in the store)' }] : []), { value: 'review', label: 'Submitted for approval (hidden)' },
                    { value: 'draft', label: 'Draft (hidden)' }, { value: 'archived', label: 'Archived (hidden)' }]} />
              </ActionForm>
            </Drawer>
          ) : <p className="note" data-readonly="status">Changing the status needs the products.write permission.</p>}
        </Section>

        <Section id="sum-h" title="At a glance" name="summary" hint="Each line opens the tab that holds it.">
          <Facts attr="data-product-summary" items={[
            { label: 'Price', attr: 'sum-price', value: <NavLink href={tabHref('pricing')}>₹{paiseToRupees(p.price_paise)}</NavLink> },
            { label: 'Variants & stock', attr: 'sum-stock', value: variants
              ? <><NavLink href={tabHref('variants')}>{sellable.length} of {variants.length} sizes offered · {formatNumber(units)} unit{units === 1 ? '' : 's'}</NavLink>{short.length > 0 && <> <span className="badge low_stock">{short.length} low</span></>}</>
              : <span className="note">Needs the inventory.read permission.</span> },
            { label: 'Merchandising', attr: 'sum-merch', value: <><NavLink href={tabHref('merchandising')}>{p.category_label}{p.subcategory_label ? ` / ${p.subcategory_label}` : ''}</NavLink>
              <span className="note"> · {inCollections.length === 0 ? 'in no collection' : inNames.length ? inNames.join(', ') : `${inCollections.length} collection${inCollections.length === 1 ? '' : 's'}`}{p.is_featured ? ' · featured' : ''}{newArrival?.member ? ' · New Arrivals' : ''}</span></> },
            ...(sales ? [{ label: 'Sales', attr: 'sum-sales', value: sales.totals.orders === 0 ? <NavLink href={tabHref('sales')}>Nothing sold yet</NavLink>
              : <><NavLink href={tabHref('sales')}>{formatNumber(sales.totals.units)} unit{sales.totals.units === 1 ? '' : 's'} sold · {formatPaise(sales.totals.revenue)}</NavLink><span className="note"> · {formatNumber(sales.totals.orders)} paid order{sales.totals.orders === 1 ? '' : 's'} · {formatNumber(sales.totals.units30)} in the last 30 days</span></> }] : []),
            ...(reviews ? [{ label: 'Reviews', attr: 'sum-reviews', value: reviews.rows.length === 0 ? <NavLink href={tabHref('reviews')}>No reviews yet</NavLink>
              : <><NavLink href={tabHref('reviews')}>{reviews.average === null ? 'No approved review' : `${reviews.average} / 5 from ${reviews.counts.approved} approved`}</NavLink>{reviews.counts.pending > 0 && <span className="note"> · {reviews.counts.pending} waiting</span>}</> }] : []),
            ...(production ? [{ label: 'Production', attr: 'sum-production', value: <NavLink href={tabHref('production')}>{production.length === 0 ? 'No production order' : `${making.length} planned or in progress of ${production.length}`}</NavLink> }] : []),
          ]} />
        </Section>

        {activity && (
          <Section id="recent-h" title="Recent activity" name="recent" wide hint={<NavLink href={tabHref('activity')}>All activity</NavLink>}>
            {activity.length === 0 ? <p className="empty" data-empty="product-activity">No changes recorded yet.</p> : timeline(activity.slice(0, 5))}
          </Section>
        )}
      </>
    );
  }

  // ---------------------------------------------------------------- Variants & Stock: sizes, what is in stock, the ledger
  else if (tab === 'variants') {
    const [reasons, colours, byLocation, barcodes] = await Promise.all([
      adjust ? listAdjustmentReasons(db(), actor) : Promise.resolve([]), listColours(db()),
      variants ? stockByLocation(db(), variants.map(v => v.variant_id)) : Promise.resolve([]),
      write ? db().selectFrom('product_variants').select(['id', 'barcode']).where('product_id', '=', id).execute() : Promise.resolve([]),
    ]);
    const colourName = (slug: string | null) => (slug ? colours.find(c => c.slug === slug)?.label ?? slug : null);
    const colourOptions = [{ value: '', label: 'No colour' }, ...colours.filter(c => c.is_active).map(c => ({ value: c.slug, label: c.label }))];
    const coloured = !!variants?.some(v => v.colour_slug);
    const sizeName = (v: { size: string; colour_slug: string | null }) => (v.colour_slug ? `${colourName(v.colour_slug)} / ${v.size}` : v.size);
    body = !variants ? <Section id="stock-h" title="Sizes and stock" name="stock"><p className="note">Viewing stock needs the inventory.read permission.</p></Section> : (
      <>
        <Section id="stock-h" title="Sizes and stock" name="stock" wide meta={`${formatNumber(units)} units · ${sellable.length} of ${variants.length} sizes offered`}
          hint={<>The quantities are the Inventory stock ledger&apos;s: the same figures as <Link href={`/inventory?q=${encodeURIComponent(p.id)}`} data-link="inventory">Inventory → Stock</Link>.</>}>
          {variants.length === 0 ? <p className="empty">This product has no sizes yet. Add the first one below.</p> : (
            <div className="table-wrap"><table data-variants-table>
              <thead><tr><th>Size</th><th>SKU</th><th className="num">In stock</th><th>By location</th><th className="num">Reorder at</th><th>Status</th><th>Price</th><th>Last movement</th></tr></thead>
              <tbody>{variants.map(v => (
                <tr key={v.variant_id} data-variant={v.variant_sku} data-level={v.is_active ? v.stock_status : 'off'}>
                  <td className="size-cell">{sizeName(v)}</td><td className="mono">{v.variant_sku}</td>
                  <td className="num qty" data-qty>{v.stock_qty}</td>
                  <td className="note" data-by-location>{byLocation.filter(s => s.variant_id === v.variant_id && !s.is_online).map(s => `${s.name} ${s.qty}`).join(' · ') || '—'}</td>
                  <td className="num">{v.reorder_level}</td>
                  <td>{v.is_active ? <StatusBadge status={v.stock_status} /> : <span className="badge">size not offered</span>}</td>
                  <td>{v.price_paise === null ? <span className="note">product price</span> : `₹${paiseToRupees(v.price_paise)}`}</td>
                  <td className="nowrap">{formatDateTime(v.last_movement_at)}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </Section>

        {variants.length > 0 && (
          <Section id="adjust-h" title="Adjust stock" name="adjust" wide
            hint={<>Each change is recorded in the stock ledger with a reason. This is the online store&apos;s stock; other locations are managed under <Link href="/locations">Locations</Link>.</>}>
            {adjust ? (
              <div className="ent-rows" data-stock-forms>
                {variants.map(v => (
                  <details className="ent-row" key={v.variant_id} data-adjust-row={v.variant_sku}>
                    <summary><b>{sizeName(v)}</b><span className="mono">{v.variant_sku}</span><span className="ent-row-fact">{v.stock_qty} in stock</span><span className="btn ghost sm">Adjust</span></summary>
                    <StockAdjustForm action={adjustStockAction} productId={p.id} reasons={reasons}
                      variant={{ id: v.variant_id, sku: v.variant_sku, size: sizeName(v), stockQty: v.stock_qty }} />
                  </details>
                ))}
              </div>
            ) : <p className="note" data-readonly="stock">Adjusting stock needs the inventory.adjust permission.</p>}
          </Section>
        )}

        {write && (
          <Section id="sizes-h" title="Size settings" name="sizes" wide
            hint="A size's SKU never changes (orders keep it) and sizes are not deleted: turn “Offered” off instead. New sizes start at 0 units; add stock with an adjustment above.">
            <div className="ent-rows" data-size-forms>
              {variants.map((v, n) => (
                <details className="ent-row" key={v.variant_id} data-size={v.variant_sku}>
                  <summary><b>{sizeName(v)}</b><span className="mono">{v.variant_sku}</span>
                    <span className="ent-row-fact">{v.is_active ? 'offered' : 'not offered'} · {v.price_paise === null ? 'product price' : `₹${paiseToRupees(v.price_paise)}`} · reorder at {v.reorder_level}</span>
                    <span className="btn ghost sm">Edit</span></summary>
                  <div className="ent-row-forms">
                  {colours.length > 0 && <ActionForm action={setVariantColourAction} submitLabel="Save colour" variant="ghost" className="form compact" id={`colour-${v.variant_sku}`} label={`Colour of size ${v.size}`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} />
                    <Select name="colour" label="Colour" options={colourOptions} defaultValue={v.colour_slug ?? ''} />
                  </ActionForm>}
                  <ActionForm action={updateVariantAction} submitLabel="Save size" variant="ghost" className="form compact" id={`size-${v.variant_sku}`} label={`Settings for size ${v.size}`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="expectedVersion" value={v.version} />
                    <Checkbox name="isActive" label="Offered in the store" defaultChecked={v.is_active} />
                    <Field name="price" label="Price override (₹)" defaultValue={v.price_paise === null ? '' : paiseToRupees(v.price_paise).replace(/,/g, '')} hint="Blank = product price." />
                    <Field name="reorderLevel" label="Reorder level" defaultValue={v.own_reorder_level === null ? '' : String(v.own_reorder_level)} hint={`Blank = default (${v.reorder_level}).`} />
                  </ActionForm>
                  <ActionForm action={setBarcodeAction} submitLabel="Save barcode" variant="ghost" className="form compact" id={`barcode-${v.variant_id}`} label={`Barcode of ${v.variant_sku}`}>
                    <Hidden name="variantId" value={v.variant_id} /><Hidden name="productId" value={p.id} />
                    <Field name="barcode" label="Barcode (POS)" defaultValue={barcodes.find(b => b.id === v.variant_id)?.barcode ?? ''} hint="Optional. Scanned at the counter." />
                  </ActionForm>
                  <div className="actions">
                    {n > 0 && <ActionForm action={moveVariantAction} submitLabel="↑ Earlier" variant="ghost" className="inline-form" label={`Move size ${v.size} earlier`}>
                      <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="direction" value="up" /></ActionForm>}
                    {n < variants.length - 1 && <ActionForm action={moveVariantAction} submitLabel="↓ Later" variant="ghost" className="inline-form" label={`Move size ${v.size} later`}>
                      <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.variant_id} /><Hidden name="direction" value="down" /></ActionForm>}
                  </div>
                  </div>
                </details>
              ))}
            </div>
            {coloured ? (
              <ActionForm action={addColourVariantAction} submitLabel="Add size" id="add-size-form" label="Add a size" className="form add-size" resetOnSuccess>
                <Hidden name="productId" value={p.id} />
                <Select name="colour" label="Colour" required options={colourOptions.slice(1)} />
                <Field name="size" label="New size" autoComplete="off" hint={`e.g. XXL, 32, FREE. The SKU becomes ${p.sku}-<COLOUR>-<SIZE>.`} />
              </ActionForm>
            ) : (
              <ActionForm action={addVariantAction} submitLabel="Add size" id="add-size-form" label="Add a size" className="form add-size" resetOnSuccess>
                <Hidden name="productId" value={p.id} />
                <Field name="size" label="New size" autoComplete="off" hint={`e.g. XXL, 32, FREE. The SKU becomes ${p.sku}-<SIZE>.`} />
              </ActionForm>
            )}
            {colours.length > 0 && <p className="note">Colours: to sell this product in several colours, give each existing size its colour above, then add the sizes of the other colours. Colours are managed under Attributes → Colour.</p>}
          </Section>
        )}

        {movements && (
          <Section id="mv-h" title="Stock movements" name="movements" wide meta={movements.length ? `latest ${movements.length}` : undefined}
            hint="Rows of the Inventory stock ledger for this product's sizes, newest first. Sales, returns, counts, transfers and adjustments all write here.">
            {movements.length === 0 ? <p className="empty">No stock movements yet.</p> : (
              <div className="table-wrap"><table data-movements-table>
                <thead><tr><th>When</th><th>SKU</th><th className="num">Change</th><th className="num">Balance after</th><th>Reason</th><th>By</th><th>Note</th></tr></thead>
                <tbody>{movements.map(m => (
                  <tr key={m.id} data-movement={m.sku}>
                    <td className="nowrap">{formatDateTime(m.created_at)}</td><td className="mono">{m.sku}</td>
                    <td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td><td className="num">{m.balance_after ?? '—'}</td>
                    <td>{m.reason}</td><td>{m.staff_email ?? <span className="note">system</span>}</td><td>{m.note === SEED_NOTE ? '' : m.note ?? ''}</td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
          </Section>
        )}
      </>
    );
  }

  // ---------------------------------------------------------------- Pricing: the product's whole price record
  else if (tab === 'pricing') {
    const readPricing = can(actor, 'pricing.read'), manage = can(actor, 'pricing.manage');
    const [pr, discounts, inCollections] = await Promise.all([readPricing ? getProductPricing(db(), actor, id) : Promise.resolve(null),
      readPricing ? listDiscounts(db(), actor) : Promise.resolve([]), getProductCollections(db(), actor, id)]);
    const money = (v: number | null) => (v === null ? '—' : formatPaise(v));
    /* Which discounts name this product, its category or one of its collections: asked of the checkout's own rule
       (discountAmount) with one unit of the product, so this list can never disagree with what the store applies.
       Whole-order discounts are not about one product and stay under Pricing & discounts. */
    const info = new Map([[p.id, { categories: [p.category_id, ...(p.subcategory_id ? [p.subcategory_id] : [])], collections: inCollections }]]);
    const unit = [{ productId: p.id, variantId: '', qty: 1, unitPaise: p.price_paise, lineTotalPaise: p.price_paise }];
    const targeting = discounts.filter(d => d.scope !== 'order' && (d.state === 'active' || d.state === 'scheduled')
      && discountAmount({ ...d, min_order_paise: null }, unit, p.price_paise, info).amount > 0);
    const compareAt = pr?.product.compare_at_paise ?? null;
    body = (
      <>
        <Section id="price-h" title="Price" name="price" hint="Tax-inclusive. A change applies to carts priced from now on; placed orders keep their price.">
          <p className="price-now" data-current-price>₹{paiseToRupees(p.price_paise)}{compareAt ? <small className="ent-was"> was {formatPaise(compareAt)}</small> : null}</p>
          {write ? <PriceForm action={updatePriceAction} productId={p.id} currentPaise={p.price_paise} />
            : manage ? (
              <ActionForm action={setPricingAction} submitLabel="Save price" id="product-price-form" label="Product price">
                <Hidden name="productId" value={p.id} />
                <div className="cols">
                  <Field name="price" label="Price (₹)" defaultValue={rupeesField(p.price_paise)} required />
                  <Field name="compareAt" label="Compare-at price (₹)" defaultValue={rupeesField(compareAt)} hint="Optional “was” price; must be above the price." />
                </div>
              </ActionForm>
            ) : <p className="note" data-readonly="price">Changing the price needs the products.write permission.</p>}
          {write && manage && (
            <ActionForm action={setPricingAction} submitLabel="Save compare-at price" variant="ghost" id="product-price-form" label="Compare-at price">
              <Hidden name="productId" value={p.id} /><Hidden name="price" value={rupeesField(p.price_paise)} />
              <Field name="compareAt" label="Compare-at (“was”) price, ₹" defaultValue={rupeesField(compareAt)} hint="Optional. Shown struck through next to the price; must be above it. Empty removes it." />
            </ActionForm>
          )}
        </Section>

        <Section id="min-h" title="Minimum price" name="min-price" hint="The floor for staff discounts on draft orders and at the counter.">
          <p data-min-price>Minimum price after a staff discount: <b>{p.min_price_paise ? `₹${paiseToRupees(p.min_price_paise)}` : 'none'}</b></p>
          {write && (
            <ActionForm action={setMinPriceAction} submitLabel="Save minimum price" variant="ghost" id="min-price-form" label="Minimum price">
              <Hidden name="productId" value={p.id} />
              <Field name="minPrice" label="Minimum price, ₹ (optional)" defaultValue={p.min_price_paise ? paiseToRupees(p.min_price_paise).replace(/,/g, '') : ''} hint="Staff discounts can never take this product below it. Empty: no minimum." />
            </ActionForm>
          )}
        </Section>

        {pr && (<>
          <Section id="sale-h" title="Sale price" name="sale-price"
            hint="The price stays as it is; while a sale runs, customers pay the sale price and see the price as the “was” price.">
            <p data-current-sale>{pr.product.sale_price_paise ? <>Current sale: <b>{formatPaise(pr.product.sale_price_paise)}</b>{pr.product.sale_starts_at ? ` from ${formatDateTime(pr.product.sale_starts_at as Date)}` : ''}{pr.product.sale_ends_at ? ` until ${formatDateTime(pr.product.sale_ends_at as Date)}` : ''}.</> : 'No sale is set.'}</p>
            {manage && (
              <ActionForm action={setSaleAction} submitLabel="Save sale" id="product-sale-form" label="Sale price">
                <Hidden name="productId" value={p.id} />
                <Field name="salePrice" label="Sale price (₹)" defaultValue={rupeesField(pr.product.sale_price_paise)} hint="Empty ends the sale. Must be below the price." />
                <div className="cols">
                  <Field name="startsAt" label="Starts (India time, optional)" type="datetime-local" defaultValue={istLocal(pr.product.sale_starts_at as Date | null)} />
                  <Field name="endsAt" label="Ends (India time, optional)" type="datetime-local" defaultValue={istLocal(pr.product.sale_ends_at as Date | null)} />
                </div>
              </ActionForm>
            )}
          </Section>

          <Section id="sz-h" title="Size prices" name="size-prices" wide hint="A size with no price of its own sells at the product price.">
            <div className="table-wrap"><table data-size-prices>
              <thead><tr><th>Size</th><th>SKU</th><th className="num">Own price</th><th className="num">Compare-at</th><th className="num">Sale</th>{manage && <th>Edit</th>}</tr></thead>
              <tbody>{pr.variants.map(v => (
                <tr key={v.id} data-size={v.size}>
                  <td>{v.size}{!v.is_active && <span className="badge inactive">inactive</span>}</td><td className="mono">{v.sku}</td>
                  <td className="num money">{v.price_paise === null ? <span className="muted">product price</span> : formatPaise(v.price_paise)}</td>
                  <td className="num money">{money(v.compare_at_paise)}</td>
                  <td className="num money">{v.price_paise === null ? <span className="muted">product sale</span> : money(v.sale_price_paise)}</td>
                  {manage && <td><details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                    <ActionForm action={setPricingAction} submitLabel="Save" className="form compact row-edit-form" id={`size-price-${v.id}`} label={`Price of size ${v.size}`}>
                      <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.id} />
                      <Field name="price" label="Own price (₹)" defaultValue={rupeesField(v.price_paise)} hint="Empty = the product price." />
                      <Field name="compareAt" label="Compare-at (₹)" defaultValue={rupeesField(v.compare_at_paise)} />
                    </ActionForm>
                    {v.price_paise !== null && <ActionForm action={setSaleAction} submitLabel="Save sale" className="form compact row-edit-form" id={`size-sale-${v.id}`} label={`Sale price of size ${v.size}`}>
                      <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.id} />
                      <Field name="salePrice" label="Sale price for this size (₹)" defaultValue={rupeesField(v.sale_price_paise)} hint="Applies while the product's sale runs. Empty = none." />
                    </ActionForm>}</details></td>}
                </tr>
              ))}</tbody>
            </table></div>
          </Section>

          <Section id="sc-h" title="Scheduled changes" name="scheduled" wide meta={pr.changes.length ? `${pr.changes.length}` : undefined}>
            {pr.changes.length === 0 ? <p className="empty" data-empty="scheduled">No scheduled changes.</p> : (
              <div className="table-wrap"><table data-scheduled-table>
                <thead><tr><th>From</th><th>For</th><th className="num">Price</th><th className="num">Compare-at</th><th>Status</th><th>By</th>{manage && <th />}</tr></thead>
                <tbody>{pr.changes.map(c => (
                  <tr key={c.id}>
                    <td className="nowrap">{formatDateTime(c.effective_at as Date)}</td><td>{c.size ? `Size ${c.size}` : 'Product'}</td>
                    <td className="num">{money(c.new_price_paise)}</td><td className="num">{c.clear_compare_at ? 'remove' : money(c.new_compare_at_paise)}</td>
                    <td><StatusBadge status={c.status} />{c.failure_reason && <div className="note">{c.failure_reason}</div>}</td><td>{c.created_by_email ?? '—'}</td>
                    {manage && <td>{c.status === 'scheduled' && <ActionForm action={cancelPriceChangeAction} submitLabel="Cancel" variant="danger" className="inline-form" id={`cancel-${c.id}`} label="Cancel scheduled change">
                      <Hidden name="changeId" value={c.id} /></ActionForm>}</td>}
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {manage ? (
              <details className="ent-disclose" data-schedule>
                <summary className="btn ghost sm">Schedule a price change</summary>
                <ActionForm action={schedulePriceAction} submitLabel="Schedule" id="schedule-price-form" label="Schedule a price change" resetOnSuccess>
                  <Hidden name="productId" value={p.id} />
                  <Select name="variantId" label="For" options={[{ value: '', label: 'The product (all sizes without their own price)' }, ...pr.variants.map(v => ({ value: v.id, label: `Size ${v.size}` }))]} />
                  <div className="cols">
                    <Field name="price" label="New price (₹)" hint="Leave empty to keep the price." />
                    <Field name="compareAt" label="New compare-at (₹)" />
                  </div>
                  <Checkbox name="clearCompareAt" label="Remove the compare-at price (end a sale)" />
                  <Field name="effectiveAt" label="From (India time)" type="datetime-local" required />
                  <TextArea name="note" label="Note (staff only)" rows={2} />
                </ActionForm>
              </details>
            ) : <p className="note">Scheduling a change needs the pricing.manage permission.</p>}
          </Section>

          <Section id="disc-h" title="Discounts" name="discounts" wide meta={targeting.length ? `${targeting.length}` : undefined}
            hint={<>Discounts and coupon codes that name this product, its category or one of its collections. They are created and changed under <Link href="/pricing/discounts" data-link="discounts">Pricing &amp; discounts</Link>, not here.</>}>
            {targeting.length === 0 ? <p className="empty" data-empty="product-discounts">No active or scheduled discount targets this product.</p> : (
              <div className="table-wrap"><table data-product-discounts>
                <thead><tr><th>Discount</th><th>Value</th><th>Through</th><th>Dates</th><th>Status</th></tr></thead>
                <tbody>{targeting.map(d => (
                  <tr key={d.id} data-discount={d.code ?? d.name}>
                    <td><Link className="row-link" href="/pricing/discounts"><b>{d.name}</b></Link><div className="note mono">{d.code ?? 'automatic'}</div>{d.campaign_name && <div className="note">Campaign: {d.campaign_name}</div>}</td>
                    <td>{d.kind === 'percent' ? `${d.value / 100}%` : formatPaise(d.value)}{d.min_order_paise ? <div className="note">min order {formatPaise(d.min_order_paise)}</div> : null}</td>
                    <td>{d.scope === 'products' ? 'This product' : d.scope === 'categories' ? 'Its category' : 'A collection'}</td>
                    <td className="note">{d.starts_at ? formatDateTime(d.starts_at as Date) : 'now'} → {d.ends_at ? formatDateTime(d.ends_at as Date) : 'no end'}</td>
                    <td><span className={`badge ${d.state === 'active' ? 'active' : 'scheduled'}`}>{d.state}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Section>

          <Section id="ph-h" title="Price history" name="history" wide>
            {pr.history.length === 0 ? <p className="empty" data-empty="price-history">No price changes recorded yet.</p> : (
              <div className="table-wrap"><table data-history-table>
                <thead><tr><th>When</th><th>What</th><th className="num">From</th><th className="num">To</th><th>How</th><th>By</th></tr></thead>
                <tbody>{pr.history.map(h => (
                  <tr key={h.id}><td className="nowrap">{formatDateTime(h.created_at as Date)}</td><td>{h.field === 'price' ? 'Price' : 'Compare-at'}{h.size ? `, size ${h.size}` : ''}</td>
                    <td className="num">{money(h.old_paise)}</td><td className="num">{money(h.new_paise)}</td><td>{h.source}</td><td>{h.staff_email ?? '—'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Section>
        </>)}
      </>
    );
  }

  // ---------------------------------------------------------------- Media
  else if (tab === 'media') {
    const colours = await listColours(db());
    const colourName = (slug: string | null) => (slug ? colours.find(c => c.slug === slug)?.label ?? slug : null);
    const colourChoices = colours.filter(c => c.is_active).map(c => ({ value: c.slug, label: c.label }));
    const coloured = !!variants?.some(v => v.colour_slug);
    body = (
      <>
        <Section id="img-h" title="Images" name="images" wide meta={`${images.length} image${images.length === 1 ? '' : 's'}`} hint="The first image is the one shown in listings. Order them as they should appear on the product page.">
          {images.length === 0 ? <Empty title="No images yet" kind="images" compact>Upload at least one image before publishing the product.</Empty> : (
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
                      <span className="media-dim">{i.width ? `${i.width} × ${i.height}` : 'size unknown'}{i.colour_slug ? ` · ${colourName(i.colour_slug)}` : ''}</span>
                    </figcaption>
                    {write && (
                      <div className="image-tools" data-image-tools={i.id}>
                        {coloured && <ActionForm action={setImageColourAction} submitLabel="Save colour" variant="ghost" className="form compact" label={`Colour of image ${n + 1}`}>
                          <Hidden name="productId" value={p.id} /><Hidden name="imageId" value={i.id} />
                          <Select name="colour" label="Shows colour" options={[{ value: '', label: 'All colours' }, ...colourChoices]} defaultValue={i.colour_slug ?? ''} />
                        </ActionForm>}
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
        </Section>
        <Section id="upload-h" title="Add an image" name="upload" hint="JPEG, PNG or WebP up to 5 MB. It is converted to WebP; the first image becomes the primary one.">
          {write ? (
            <ActionForm action={uploadImageAction} submitLabel="Upload image" pendingLabel="Uploading…" id="upload-image-form" label="Upload an image" className="form upload-form" resetOnSuccess>
              <Hidden name="productId" value={p.id} />
              <DropzoneField name="file" title="Add product image" accept="image/jpeg,image/png,image/webp" formats="JPEG / PNG / WEBP · MAX 5 MB" />
              <Field name="alt" label="Alt text" hint="Describe the image for people who cannot see it." />
            </ActionForm>
          ) : <p className="note" data-readonly="images">Changing images needs the products.write permission.</p>}
        </Section>
      </>
    );
  }

  // ---------------------------------------------------------------- Merchandising: where and how the store shows it
  else if (tab === 'merchandising') {
    const catRead = can(actor, 'categories.read');
    const [attributes, tagged, collections, inCollections, looks, categories, chart] = await Promise.all([
      listAttributes(db(), actor), getProductAttributes(db(), actor, id),
      catRead ? listCollections(db(), actor) : Promise.resolve([]), getProductCollections(db(), actor, id), listRelated(db(), actor, id),
      write ? listCategories(db(), actor) : Promise.resolve([]), sizeChartForProduct(db(), id),
    ]);
    const hasTag = new Set(tagged);
    // Catalogue setup owns categories, collections, attributes and size charts; a link to it is shown to those who may open it.
    const setup = (href: string, label: string, allowedTo = catRead) => (allowedTo ? <Link href={href} data-link="catalogue-setup">{label}</Link> : label);
    body = (
      <>
        <Section id="cat-h" title="Category" name="category" hint={<>Where the product sits in the store menu. Categories are managed under {setup('/categories', 'Catalogue setup → Categories')}.</>}>
          <Facts attr="data-product-category" items={[
            { label: 'Category', value: p.category_label },
            { label: 'Subcategory', value: p.subcategory_label ?? '—' },
            { label: 'Featured', value: p.is_featured ? 'Yes, featured in the store' : 'No' },
          ]} />
          {write && detailsDrawer('Change category', categories)}
        </Section>

        <Section id="col-h" title="Collections" name="collections" hint={<>Men, Women, Sale and other curated lists, managed under {setup('/collections', 'Catalogue setup → Collections')}. The Sale collection is separate from the sale price.</>}>
          {catWrite && collections.length ? (
            <ActionForm action={setProductCollectionsAction} submitLabel="Save collections" id="product-collections-form" label="Collections">
              <Hidden name="productId" value={p.id} />
              <TagPicker name="collectionIds[]" label="In collections" addLabel="+ Add collection" selected={inCollections}
                options={collections.map(c => ({ value: c.id, label: c.isActive ? c.label : `${c.label} (hidden)` }))} />
            </ActionForm>
          ) : (
            <p data-product-collections>{inCollections.length ? collections.filter(c => inCollections.includes(c.id)).map(c => c.label).join(', ') || inCollections.join(', ') : 'In no collection.'}
              {!catWrite && <span className="note"> Changing collections needs the categories.write permission.</span>}</p>
          )}
        </Section>

        {newArrival && (
          <Section id="na-h" title="New Arrivals" name="new-arrivals" hint="The New Arrivals row on the store's home page, in order.">
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
          </Section>
        )}

        <Section id="attr-h" title="Store filters" name="attributes" hint={<>What customers can filter by in the shop (fabric, sleeve length, occasion…). The filters and their values are managed under {setup('/attributes', 'Catalogue setup → Attributes')}.</>}>
          {!attributes.length ? (
            <p className="note">No attributes yet. {catWrite
              ? <>Add them under <Link href="/attributes">Attributes</Link>, then tick them here.</>
              : 'Staff with the categories.write permission can add them under Attributes.'}</p>
          ) : write ? (
            <ActionForm action={setProductAttributesAction} submitLabel="Save store filters" id="attributes-form" label="Store filters" className="form ent-form-flat">
              <Hidden name="productId" value={p.id} />
              {attributes.map(a => (
                <div className="attr-pick" key={a.id} data-attribute={a.id}>
                  {a.values.length ? (
                    <TagPicker name="values[]" label={`${a.label}${a.isActive ? '' : ' (hidden from the store)'}`} single={a.selection === 'single'} addLabel={`+ Add ${a.label.toLowerCase()}`}
                      selected={a.values.filter(v => hasTag.has(`${a.id}:${v.slug}`)).map(v => `${a.id}:${v.slug}`)}
                      options={a.values.map(v => ({ value: `${a.id}:${v.slug}`, label: v.label, swatch: v.swatch, inactive: !v.isActive }))} />
                  ) : <p className="note"><b>{a.label}</b>: no values yet{catWrite && <> — add them under <Link href="/attributes">Attributes</Link></>}.</p>}
                </div>
              ))}
            </ActionForm>
          ) : (
            <dl className="attr-read">{attributes.map(a => (
              <div key={a.id}><dt>{a.label}</dt><dd>{a.values.filter(v => hasTag.has(`${a.id}:${v.slug}`)).map(v => v.label).join(', ') || '—'}</dd></div>
            ))}</dl>
          )}
        </Section>

        <Section id="chart-h" title="Size chart" name="size-chart" hint={<>The measurement table on the product page: the product&apos;s own chart, else its subcategory&apos;s, else its category&apos;s. Charts are assigned under {setup('/size-charts', 'Catalogue setup → Size charts', true)}.</>}>
          {chart ? (
            <Facts attr="data-product-size-chart" items={[
              { label: 'Chart', value: <b>{chart.name}</b> },
              { label: 'Measurements', value: `${chart.headers.join(', ')} (${chart.unit})` },
              { label: 'Sizes', value: chart.rows.map(r => r.size).join(', ') || '—' },
            ]} />
          ) : <p className="note" data-empty="product-size-chart">No size chart is shown for this product.</p>}
        </Section>

        <Section id="look-h" title="Complete the look" name="related" hint={`Shown on the product page in the store, in this order (up to ${looks.max}).`}>
          {looks.related.length ? <div className="table-wrap"><table data-related-table>
            <tbody>{looks.related.map((r, i) => (
              <tr key={r.id} data-related={r.sku}>
                <td><NavLink href={`/products/${r.id}`}>{r.name}</NavLink><div className="note mono">{r.sku}</div></td>
                <td><ProductStatusPill status={r.status} /></td>
                {write && <td><div className="actions row-actions">
                  {i > 0 && <ActionForm action={moveRelatedAction} submitLabel="↑" variant="ghost" className="inline-form" id={`rel-up-${r.id}`} label={`Move ${r.name} up`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="relatedId" value={r.id} /><Hidden name="direction" value="up" /></ActionForm>}
                  {i < looks.related.length - 1 && <ActionForm action={moveRelatedAction} submitLabel="↓" variant="ghost" className="inline-form" id={`rel-down-${r.id}`} label={`Move ${r.name} down`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="relatedId" value={r.id} /><Hidden name="direction" value="down" /></ActionForm>}
                  <ActionForm action={removeRelatedAction} submitLabel="Remove" variant="danger" className="inline-form" id={`rel-rm-${r.id}`} label={`Remove ${r.name}`}>
                    <Hidden name="productId" value={p.id} /><Hidden name="relatedId" value={r.id} /></ActionForm>
                </div></td>}
              </tr>
            ))}</tbody>
          </table></div> : <p className="note" data-empty="related">No linked products.</p>}
          {write && looks.related.length < looks.max && looks.candidates.length > 0 && (
            <ActionForm action={addRelatedAction} submitLabel="Link product" className="form compact" id="add-related-form" label="Link a product" resetOnSuccess>
              <Hidden name="productId" value={p.id} />
              <Select name="relatedId" label="Product" options={looks.candidates.map(c => ({ value: c.id, label: `${c.sku} · ${c.name}` }))} />
            </ActionForm>
          )}
        </Section>
      </>
    );
  }

  // ---------------------------------------------------------------- Sales
  else if (tab === 'sales') {
    const s = await productSales(db(), actor, id);
    body = (
      <>
        <Section id="sales-h" title="Sales" name="sales" wide hint="Paid orders only (paid, being packed, shipped, delivered), as in Reports.">
          <Figures items={[
            { label: 'Units sold', value: formatNumber(s.totals.units) },
            { label: 'Revenue', value: formatPaise(s.totals.revenue) },
            { label: 'Orders', value: formatNumber(s.totals.orders) },
            { label: 'Last 30 days', value: `${formatNumber(s.totals.units30)} unit${s.totals.units30 === 1 ? '' : 's'}`, note: formatPaise(s.totals.revenue30) },
            { label: 'Last sale', value: s.totals.last_at ? formatDateTime(s.totals.last_at) : '—' },
          ]} />
        </Section>
        <Section id="sales-size-h" title="By size" name="sales-by-size" wide>
          {s.bySize.length === 0 ? <p className="empty" data-empty="sales">Nothing sold yet.</p> : (
            <div className="table-wrap"><table data-sales-by-size>
              <thead><tr><th>Size</th><th>SKU</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
              <tbody>{s.bySize.map(x => <tr key={x.sku}><td>{x.colour ? `${x.colour} / ${x.size}` : x.size}</td><td className="mono">{x.sku}</td><td className="num">{formatNumber(x.units)}</td><td className="num money">{formatPaise(x.revenue)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Section>
        <Section id="sales-orders-h" title="Recent orders" name="sales-orders" wide hint="The latest orders that contain this product, whatever their state. A row opens the order on its Items tab; the order is managed in Orders.">
          {s.recent.length === 0 ? <p className="empty">No orders contain this product yet.</p> : (
            <div className="table-wrap"><table data-product-orders>
              <thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Size</th><th className="num">Qty</th><th className="num">Amount</th><th>Stage</th><th>Payment</th></tr></thead>
              <tbody>{s.recent.map((r, i) => (
                <tr key={`${r.order_id}-${i}`}>
                  <td className="mono"><NavLink className="row-link" href={`/orders/${r.order_id}?tab=items`} aria-label={`Order ${r.order_number}: items`}>{r.order_number}</NavLink></td>
                  <td className="nowrap">{formatDateTime(r.created_at)}</td><td>{r.customer ?? '—'}</td><td>{r.size}</td>
                  <td className="num">{r.qty}</td><td className="num money">{formatPaise(r.line_total_paise)}</td>
                  <td><StagePill status={r.status} /></td>
                  <td><PaymentPill method={r.payment_method} paymentStatus={r.payment_status} codStatus={r.cod_status} orderStatus={r.status} note={false} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
      </>
    );
  }

  // ---------------------------------------------------------------- Reviews: this product's rows of the Reviews queue
  else if (tab === 'reviews') {
    const r = await productReviews(db(), actor, id);
    const moderate = can(actor, 'reviews.moderate');
    const photos = r.rows.length ? await db().selectFrom('review_photos').select(['id', 'review_id', 'width', 'height']).where('review_id', 'in', r.rows.map(x => x.id)).orderBy('position').execute() : [];
    body = (
      <Section id="rev-h" title="Customer reviews" name="reviews" wide
        hint={<>Reviews come from customers who bought this product; only approved ones show in the store. This is the product&apos;s part of the <Link href={`/reviews?status=${r.counts.pending > 0 ? 'pending' : 'approved'}`} data-link="reviews">Reviews</Link> queue: a decision made here is the same decision, recorded once.</>}>
        <Figures items={[
          { label: 'Rating', value: r.average === null ? '—' : `${r.average} / 5`, note: `${r.counts.approved} approved` },
          { label: 'Waiting', value: formatNumber(r.counts.pending) },
          { label: 'Rejected', value: formatNumber(r.counts.rejected) },
        ]} />
        {r.rows.length === 0 ? <StateBlock title="No reviews yet" name="product-reviews">A review appears here when a customer who bought this product writes one.</StateBlock> : (
          <div className="table-wrap"><table data-product-reviews>
            <thead><tr><th>Rating</th><th>Review</th><th>By</th><th>Status</th><th>Date</th>{moderate && <th>Moderation</th>}</tr></thead>
            <tbody>{r.rows.map(x => {
              const own = photos.filter(ph => ph.review_id === x.id);
              return (
                <tr key={x.id} data-review={x.status} data-review-id={x.id}>
                  <td className="nowrap"><b>{x.rating}</b> / 5</td>
                  <td className="review-cell">{x.title && <b>{x.title}</b>}<div>{x.body}</div>{x.variant_label && <div className="note">{x.variant_label}</div>}
                    {own.length > 0 && <div className="review-photos">{own.map(ph => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a key={ph.id} href={`/api/review-photos/${ph.id}`} target="_blank" rel="noopener"><img src={`/api/review-photos/${ph.id}`} alt="Customer photo" width={ph.width} height={ph.height} loading="lazy" /></a>
                    ))}</div>}
                    {x.moderation_note && <div className="note">Note: {x.moderation_note}</div>}</td>
                  <td>{x.display_name}<div className="note">{x.customer_email}</div></td>
                  <td><StatusBadge status={x.status} /></td>
                  <td className="nowrap">{formatDateTime(x.created_at as Date)}</td>
                  {moderate && <td><div className="actions row-actions">
                    {x.status !== 'approved' && (
                      <ActionForm action={moderateReviewAction} submitLabel="Approve" className="inline-form" id={`rv-ok-${x.id}`} label="Approve review">
                        <Hidden name="reviewId" value={x.id} /><Hidden name="decision" value="approved" /><Hidden name="expectedStatus" value={x.status} />
                      </ActionForm>
                    )}
                    {x.status !== 'rejected' && (
                      <details className="row-edit">
                        <summary className="btn ghost sm">{x.status === 'approved' ? 'Take down' : 'Reject'}</summary>
                        <ActionForm action={moderateReviewAction} submitLabel="Reject" variant="danger" className="form compact row-edit-form" id={`rv-no-${x.id}`} label="Reject review">
                          <Hidden name="reviewId" value={x.id} /><Hidden name="decision" value="rejected" /><Hidden name="expectedStatus" value={x.status} />
                          <Field name="note" label="Reason (staff only)" required />
                        </ActionForm>
                      </details>
                    )}
                  </div></td>}
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {!moderate && r.rows.length > 0 && <p className="note" data-readonly="reviews">Approving or rejecting a review needs the reviews.moderate permission.</p>}
      </Section>
    );
  }

  // ---------------------------------------------------------------- Production
  else if (tab === 'production') {
    const rows = await productProduction(db(), actor, id);
    body = (
      <Section id="prod-h" title="Production orders" name="production" wide meta={rows.length ? `${rows.length}` : undefined}
        hint={<>Planned and finished production of this product&apos;s sizes. New production is planned under <Link href="/production">Production</Link>.</>}>
        {rows.length === 0 ? <p className="empty" data-empty="product-production">No production order for this product yet.</p> : (
          <div className="table-wrap"><table data-product-production>
            <thead><tr><th>Order</th><th>Size</th><th className="num">Planned</th><th className="num">Passed / rejected</th><th>Purchase orders</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>{rows.map(o => (
              <tr key={o.id}>
                <td className="mono"><Link className="row-link" href={`/production/${o.id}`}>{o.number}</Link>{o.batch_ref && <div className="note">batch {o.batch_ref}</div>}</td>
                <td>{o.size}<div className="note mono">{o.variant_sku}</div></td>
                <td className="num">{formatNumber(o.qty_planned)}</td>
                <td className="num">{o.qty_passed === null ? '—' : `${o.qty_passed} / ${o.qty_rejected ?? 0}`}</td>
                <td className="note">{o.purchase_orders ?? '—'}</td><td className="nowrap">{o.due_on ?? '—'}</td>
                <td><StatusBadge status={o.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>
    );
  }

  // ---------------------------------------------------------------- Activity
  else {
    const rows = await loadActivity();
    body = (
      <Section id="act-h" title="Activity" name="activity" wide
        hint="What was recorded about this product, newest first: edits, status and price changes, sizes and stock adjustments, images, collections, review decisions and production. Every stock movement (sales and returns too) is in the ledger under Variants & Stock.">
        {rows.length === 0 ? <StateBlock title="No activity yet" name="product-activity">Changes to this product are listed here as they are made.</StateBlock> : timeline(rows)}
      </Section>
    );
  }

  return (
    <Entity module={{ href: '/products', label: 'Products' }} name="product" title={p.name}
      /* eslint-disable-next-line @next/next/no-img-element */
      media={thumb ? <img src={thumb} alt="" width={44} height={56} /> : undefined}
      status={<ProductStatusPill status={p.status} />} factsAttr="data-product-facts"
      facts={[
        { label: 'SKU', value: <span className="mono">{p.sku}</span>, attr: 'sku' },
        { label: 'Category', value: `${p.category_label}${p.subcategory_label ? ` / ${p.subcategory_label}` : ''}`, attr: 'category' },
        { label: 'Price', value: <b className="price">₹{paiseToRupees(p.price_paise)}</b>, attr: 'price' },
        { label: 'Stock', attr: 'stock', value: variants ? <>{formatNumber(units)} units in {sellable.length} sizes{attention > 0 && <> · <span className="badge low_stock">{attention} low</span></>}</> : <span className="note">needs inventory.read</span> },
      ]}
      /* One main action for the product's status (the existing approval steps); everything else is under More. */
      actions={<div className="ord-head-actions" data-product-actions={p.status}>
        {write && p.status === 'draft' && !canPublish && quick('review', 'Submit for approval', 'Submitting…')}
        {write && canPublish && (p.status === 'draft' || p.status === 'review') && quick('active', 'Publish', 'Publishing…')}
        {p.status === 'active' && store && <a className="btn ghost sm" href={`${store}/product/${encodeURIComponent(p.slug)}`} target="_blank" rel="noreferrer" data-link="store">View in store</a>}
        <MoreMenu items={more} />
      </div>}
      tabs={tabs} current={tab} tabHref={tabHref}
      notice={one(sp.notice) === 'created' ? <p className="msg ok" role="status" data-notice="created">Draft product created. Add sizes and stock under Variants &amp; Stock and an image under Media, then publish it.</p> : undefined}>
      {body}
    </Entity>
  );
}
