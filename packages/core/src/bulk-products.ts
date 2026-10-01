/* Client change request: the bulk product editor. Staff select products and apply ONE change to all of them:
   publish / move to draft / archive, category, add to or remove from a collection, add or remove an attribute value,
   put on sale (percent off each product's own price) or end the sale.
   Each product goes through the same service, checks and audit as a one-by-one edit (so publishing still requires active
   categories, an offered size and a primary image; a sale still respects the maximum sale discount). A product that cannot
   take the change is reported with the reason, never forced. One summary audit record lists the whole operation.
   Permissions: status / category / attributes → products.write; collections → categories.write; sale → pricing.manage.
   2026-10-01: price (set a price, or change it by a %) and vendor (add / remove the supplier) too, and BULK EDIT DRAFTS:
   a bulk edit is first saved as a numbered draft change set (the products, the changes and, per product, the old → new
   values), reviewed, and only then applied — by the staff member or another one with the same permissions. Applying runs
   the same one-by-one services as above; a product whose value changed since the draft was made is refused (reported). */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { setProductCategory, setProductStatus, updateProductPrice } from './products.ts';
import { setCollectionMember } from './merchandising.ts';
import { setProductAttributes } from './attributes.ts';
import { setProductSale } from './sale.ts';

export type BulkAction =
  | { action: 'publish' | 'draft' | 'archive' }
  | { action: 'category'; categoryId: string; subcategoryId: string | null }
  | { action: 'collection_add' | 'collection_remove'; collectionIds: string[] }
  | { action: 'attribute_add' | 'attribute_remove'; values: { attributeId: string; slug: string }[] }
  | { action: 'sale_percent'; percent: number; startsAt: Date | null; endsAt: Date | null }
  | { action: 'sale_clear' }
  | { action: 'price_set'; price: number }
  | { action: 'price_percent'; percent: number }
  | { action: 'vendor_add' | 'vendor_remove'; vendorId: string };

const PERMISSION: Record<BulkAction['action'], string> = {
  publish: 'products.write', draft: 'products.write', archive: 'products.write', category: 'products.write',
  collection_add: 'categories.write', collection_remove: 'categories.write', attribute_add: 'products.write', attribute_remove: 'products.write',
  sale_percent: 'pricing.manage', sale_clear: 'pricing.manage',
  price_set: 'products.write', price_percent: 'products.write', vendor_add: 'procurement.manage', vendor_remove: 'procurement.manage',
};
/** Publishing also needs products.publish (product approval, 2026-10-01). */
const extraPermission = (a: BulkAction) => (a.action === 'publish' ? 'products.publish' : null);
export const BULK_MAX_PRODUCTS = 200;

export async function bulkEditProducts(db: Db, actor: StaffPrincipal, input: { productIds: string[] } & BulkAction, ctx: MutationContext,
  opts: { expected?: Record<string, number> } = {}) {
  requirePermission(actor, PERMISSION[input.action]);
  const extra = extraPermission(input); if (extra) requirePermission(actor, extra);
  const ids = [...new Set(input.productIds)];
  if (!ids.length) throw new DomainError('invalid', 'Select at least one product.');
  if (ids.length > BULK_MAX_PRODUCTS) throw new DomainError('invalid', `Select at most ${BULK_MAX_PRODUCTS} products at a time.`);
  const done: string[] = [], unchanged: string[] = [], failed: { productId: string; reason: string }[] = [];
  for (const productId of ids) {
    try {
      let changed = true;
      switch (input.action) {
        case 'publish': case 'draft': case 'archive': {
          const before = await db.selectFrom('products').select('status').where('id', '=', productId).executeTakeFirst();
          const status = input.action === 'publish' ? 'active' : input.action === 'draft' ? 'draft' : 'archived';
          changed = before?.status !== status;
          await setProductStatus(db, actor, { productId, status }, ctx);
          break;
        }
        case 'category':
          changed = (await setProductCategory(db, actor, { productId, categoryId: input.categoryId, subcategoryId: input.subcategoryId }, ctx)).changed;
          break;
        case 'collection_add': case 'collection_remove':
          for (const collectionId of input.collectionIds)
            if ((await setCollectionMember(db, actor, { collectionId, productId, member: input.action === 'collection_add' }, ctx)).changed) changed = true;
          break;
        case 'attribute_add': case 'attribute_remove': {
          const have = await db.selectFrom('product_attribute_values').select(['attribute_id', 'value_slug']).where('product_id', '=', productId).execute();
          const key = (a: string, s: string) => `${a}:${s}`, picked = new Set(input.values.map(v => key(v.attributeId, v.slug)));
          // Adding a value of a single-choice attribute replaces the product's current value of that attribute.
          const single = input.action === 'attribute_add' ? new Set((await db.selectFrom('attributes').select('id').where('selection', '=', 'single')
            .where('id', 'in', [...new Set(input.values.map(v => v.attributeId))]).execute()).map(r => r.id)) : new Set<string>();
          const values = have.map(v => ({ attributeId: v.attribute_id, slug: v.value_slug }))
            .filter(v => !picked.has(key(v.attributeId, v.slug)) && !(input.action === 'attribute_add' && single.has(v.attributeId)));
          if (input.action === 'attribute_add') values.push(...input.values);
          changed = (await setProductAttributes(db, actor, { productId, values }, ctx)).changed > 0;
          break;
        }
        case 'sale_percent': {
          const p = await db.selectFrom('products').select('price_paise').where('id', '=', productId).executeTakeFirst();
          if (!p) throw new DomainError('invalid', 'Product not found.');
          const sale = Math.round(p.price_paise * (100 - input.percent) / 100);
          changed = (await setProductSale(db, actor, { productId, salePrice: sale, startsAt: input.startsAt, endsAt: input.endsAt }, ctx, 'bulk')).changed;
          break;
        }
        case 'sale_clear':
          changed = (await setProductSale(db, actor, { productId, salePrice: null, startsAt: null, endsAt: null }, ctx, 'bulk')).changed;
          break;
        case 'price_set': case 'price_percent': {
          const p = await db.selectFrom('products').select('price_paise').where('id', '=', productId).executeTakeFirst();
          if (!p) throw new DomainError('invalid', 'Product not found.');
          // From a draft: the price it showed must still be the price (otherwise someone changed it since the review).
          const expected = opts.expected?.[productId] ?? p.price_paise;
          const price = input.action === 'price_set' ? input.price : newPrice(expected, input.percent);
          changed = (await updateProductPrice(db, actor, { productId, price, expectedPricePaise: expected }, ctx)).changed;
          break;
        }
        case 'vendor_add': case 'vendor_remove': {
          const v = await db.selectFrom('vendors').select('id').where('id', '=', input.vendorId).executeTakeFirst();
          if (!v) throw new DomainError('invalid', 'Vendor not found.');
          if (input.action === 'vendor_add') {
            const r = await db.insertInto('vendor_products').values({ vendor_id: v.id, product_id: productId, created_by: actor.staffId }).onConflict(oc => oc.columns(['vendor_id', 'product_id']).doNothing()).executeTakeFirst();
            changed = Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
          } else changed = Number((await db.deleteFrom('vendor_products').where('vendor_id', '=', v.id).where('product_id', '=', productId).executeTakeFirst()).numDeletedRows) > 0;
          break;
        }
      }
      (changed ? done : unchanged).push(productId);
    } catch (e) {
      if (e instanceof DomainError || e instanceof ForbiddenError || e instanceof ConflictError || e instanceof NotFoundError) failed.push({ productId, reason: e.message });
      else throw e;
    }
  }
  const { productIds: _ids, ...detail } = input;
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.bulk_edit', entityType: 'products', entityId: null,
    metadata: { ...detail, selected: ids.length, changed: done.length, unchanged: unchanged.length, failed: failed.length },
    ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null }));
  return { done, unchanged, failed };
}

/** A price changed by a % (e.g. -10 = 10% lower), in whole rupees. */
const newPrice = (paise: number, percent: number) => Math.max(100, Math.round(paise * (100 + percent) / 100 / 100) * 100);

// ---------------------------------------------------------------- bulk edit drafts (2026-10-01)
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const ACTION_LABEL: Record<BulkAction['action'], string> = {
  publish: 'Publish in the store', draft: 'Move to draft', archive: 'Archive', category: 'Category', collection_add: 'Add to collections', collection_remove: 'Remove from collections',
  attribute_add: 'Add tags / attribute values', attribute_remove: 'Remove tags / attribute values', sale_percent: 'Put on sale', sale_clear: 'End the sale',
  price_set: 'Set the price', price_percent: 'Change the price by %', vendor_add: 'Add the vendor', vendor_remove: 'Remove the vendor',
};
export type BulkPreviewRow = { productId: string; sku: string; name: string; changes: { field: string; before: string; after: string }[] };

/** Old → new for each product and change (what the draft will do; nothing is changed here). */
async function previewChanges(db: Db, ids: string[], changes: BulkAction[]): Promise<{ rows: BulkPreviewRow[]; prices: Record<string, number> }> {
  const products = await db.selectFrom('products as p').leftJoin('categories as c', 'c.id', 'p.category_id').leftJoin('categories as sc', 'sc.id', 'p.subcategory_id')
    .select(['p.id', 'p.sku', 'p.name', 'p.status', 'p.price_paise', 'p.sale_price_paise', 'c.label as category', 'sc.label as subcategory']).where('p.id', 'in', ids).execute();
  if (products.length !== ids.length) throw new NotFoundError('One of the selected products no longer exists. Reload and try again.');
  const byId = new Map(products.map(p => [p.id, p]));
  const colIds = changes.flatMap(c => 'collectionIds' in c ? c.collectionIds : []), catIds = changes.flatMap(c => c.action === 'category' ? [c.categoryId, ...(c.subcategoryId ? [c.subcategoryId] : [])] : []);
  const venIds = changes.flatMap(c => 'vendorId' in c ? [c.vendorId] : []);
  const [cols, cats, vens] = await Promise.all([
    colIds.length ? db.selectFrom('collections').select(['id', 'label']).where('id', 'in', colIds).execute() : [],
    catIds.length ? db.selectFrom('categories').select(['id', 'label']).where('id', 'in', catIds).execute() : [],
    venIds.length ? db.selectFrom('vendors').select(['id', 'name as label']).where('id', 'in', venIds).execute() : [],
  ]).then(all => all.map(rows => new Map(rows.map(r => [r.id, r.label]))));
  const members = colIds.length ? await db.selectFrom('collection_products').select(['collection_id', 'product_id']).where('product_id', 'in', ids).where('collection_id', 'in', colIds).execute() : [];
  const supplied = venIds.length ? await db.selectFrom('vendor_products').select(['vendor_id', 'product_id']).where('product_id', 'in', ids).where('vendor_id', 'in', venIds).execute() : [];
  const tags = await db.selectFrom('product_attribute_values as pv').innerJoin('attribute_values as av', join => join.onRef('av.attribute_id', '=', 'pv.attribute_id').onRef('av.slug', '=', 'pv.value_slug'))
    .select(['pv.product_id', 'pv.attribute_id', 'pv.value_slug', 'av.label']).where('pv.product_id', 'in', ids).execute();
  const status = (x: string) => ({ active: 'Published', draft: 'Draft', review: 'Awaiting approval', archived: 'Archived' } as Record<string, string>)[x] ?? x;
  const rows = ids.map(id => {
    const p = byId.get(id)!;
    const out: BulkPreviewRow['changes'] = [];
    let price = p.price_paise;
    for (const c of changes) {
      switch (c.action) {
        case 'publish': case 'draft': case 'archive':
          out.push({ field: 'Status', before: status(p.status), after: status(c.action === 'publish' ? 'active' : c.action === 'draft' ? 'draft' : 'archived') }); break;
        case 'category':
          out.push({ field: 'Category', before: [p.category, p.subcategory].filter(Boolean).join(' / '), after: [cats.get(c.categoryId), c.subcategoryId ? cats.get(c.subcategoryId) : null].filter(Boolean).join(' / ') }); break;
        case 'collection_add': case 'collection_remove':
          for (const col of c.collectionIds) out.push({ field: `Collection ${cols.get(col) ?? col}`, before: members.some(m => m.collection_id === col && m.product_id === id) ? 'In it' : 'Not in it', after: c.action === 'collection_add' ? 'In it' : 'Not in it' }); break;
        case 'attribute_add': case 'attribute_remove':
          for (const v of c.values) {
            const has = tags.some(t => t.product_id === id && t.attribute_id === v.attributeId && t.value_slug === v.slug);
            out.push({ field: `${v.attributeId}: ${tags.find(t => t.attribute_id === v.attributeId && t.value_slug === v.slug)?.label ?? v.slug}`, before: has ? 'Yes' : 'No', after: c.action === 'attribute_add' ? 'Yes' : 'No' });
          } break;
        case 'sale_percent': out.push({ field: 'Sale price', before: p.sale_price_paise ? inr(p.sale_price_paise) : 'No sale', after: inr(Math.round(price * (100 - c.percent) / 100)) }); break;
        case 'sale_clear': out.push({ field: 'Sale price', before: p.sale_price_paise ? inr(p.sale_price_paise) : 'No sale', after: 'No sale' }); break;
        case 'price_set': out.push({ field: 'Price', before: inr(price), after: inr(c.price) }); price = c.price; break;
        case 'price_percent': { const n = newPrice(price, c.percent); out.push({ field: 'Price', before: inr(price), after: inr(n) }); price = n; break; }
        case 'vendor_add': case 'vendor_remove':
          out.push({ field: `Vendor ${vens.get(c.vendorId) ?? ''}`, before: supplied.some(x => x.vendor_id === c.vendorId && x.product_id === id) ? 'Supplies it' : '—', after: c.action === 'vendor_add' ? 'Supplies it' : '—' }); break;
      }
    }
    return { productId: id, sku: p.sku, name: p.name, changes: out };
  });
  return { rows, prices: Object.fromEntries(products.map(p => [p.id, p.price_paise])) };
}

function checkChanges(actor: StaffPrincipal, changes: BulkAction[]) {
  if (!changes.length) throw new DomainError('invalid', 'Choose at least one change.');
  for (const c of changes) {
    requirePermission(actor, PERMISSION[c.action]);
    const extra = extraPermission(c); if (extra) requirePermission(actor, extra);
    if (c.action === 'price_set' && !(Number.isInteger(c.price) && c.price > 0)) throw new DomainError('invalid', 'Enter a price above ₹0.');
    if (c.action === 'price_percent' && !(c.percent >= -90 && c.percent <= 300 && c.percent !== 0)) throw new DomainError('invalid', 'Enter a % between -90 and 300 (not 0).');
  }
}

/** Saves a bulk edit as a draft change set (nothing is changed yet). */
export async function createBulkEditDraft(db: Db, actor: StaffPrincipal, input: { productIds: string[]; changes: BulkAction[]; note: string | null }, ctx: MutationContext) {
  const ids = [...new Set(input.productIds)];
  if (!ids.length) throw new DomainError('invalid', 'Select at least one product.');
  if (ids.length > BULK_MAX_PRODUCTS) throw new DomainError('invalid', `Select at most ${BULK_MAX_PRODUCTS} products at a time.`);
  checkChanges(actor, input.changes);
  const preview = await previewChanges(db, ids, input.changes);
  return db.transaction().execute(async tx => {
    const { n } = (await sql<{ n: string }>`select public.next_document_number('bulk_edit', 'BULK') as n`.execute(tx)).rows[0];
    const d = await tx.insertInto('bulk_edit_drafts').values({ number: n, product_ids: ids, changes: JSON.stringify(input.changes), preview: JSON.stringify(preview),
      note: input.note?.trim().slice(0, 500) || null, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.bulk_draft', entityType: 'bulk_edit_drafts', entityId: d.id,
      after: { number: n, products: ids.length, changes: input.changes }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { id: d.id, number: n };
  });
}

export async function listBulkEditDrafts(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'products.read');
  return db.selectFrom('bulk_edit_drafts as d').leftJoin('staff_users as c', 'c.id', 'd.created_by').leftJoin('staff_users as a', 'a.id', 'd.applied_by')
    .select(['d.id', 'd.number', 'd.status', 'd.changes', 'd.created_at', 'd.applied_at', 'c.email as created_by', 'a.email as applied_by', sql<number>`cardinality(d.product_ids)`.as('products')])
    .orderBy('d.created_at', 'desc').limit(100).execute();
}

export async function getBulkEditDraft(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'products.read');
  const d = await db.selectFrom('bulk_edit_drafts as d').leftJoin('staff_users as c', 'c.id', 'd.created_by').leftJoin('staff_users as a', 'a.id', 'd.applied_by')
    .selectAll('d').select(['c.email as created_by_email', 'a.email as applied_by_email']).where('d.id', '=', id).executeTakeFirst();
  if (!d) throw new NotFoundError('Bulk edit not found.');
  const changes = d.changes as BulkAction[];
  return { draft: d, changes, labels: changes.map(c => ACTION_LABEL[c.action]), preview: (d.preview as { rows: BulkPreviewRow[] } | null)?.rows ?? [],
    result: d.result as { applied: string[]; unchanged: string[]; failed: { productId: string; reason: string }[] } | null };
}

/** Applies a draft: each change, in order, through bulkEditProducts (same checks and audit as one-by-one edits). */
export async function applyBulkEditDraft(db: Db, actor: StaffPrincipal, input: { draftId: string }, ctx: MutationContext) {
  const claim = await db.updateTable('bulk_edit_drafts').set({ status: 'applied', applied_by: actor.staffId, applied_at: sql`now()` })
    .where('id', '=', input.draftId).where('status', '=', 'draft').returning(['id', 'number', 'product_ids', 'changes', 'preview']).executeTakeFirst();
  if (!claim) throw new ConflictError('This bulk edit was already applied or cancelled.');
  // Stored as JSON: sale dates come back as text.
  const changes = (claim.changes as BulkAction[]).map(c => c.action === 'sale_percent'
    ? { ...c, startsAt: c.startsAt ? new Date(c.startsAt) : null, endsAt: c.endsAt ? new Date(c.endsAt) : null } : c);
  try { checkChanges(actor, changes); } catch (e) {
    await db.updateTable('bulk_edit_drafts').set({ status: 'draft', applied_by: null, applied_at: null }).where('id', '=', claim.id).execute();
    throw e;
  }
  const prices = (claim.preview as { prices?: Record<string, number> } | null)?.prices ?? {};
  const failed = new Map<string, string>(), touched = new Set<string>(), unchanged = new Set<string>();
  for (const c of changes) {
    const ids = claim.product_ids.filter(id => !failed.has(id));
    if (!ids.length) break;
    const r = await bulkEditProducts(db, actor, { productIds: ids, ...c }, ctx, { expected: prices });
    r.done.forEach(id => touched.add(id)); r.unchanged.forEach(id => unchanged.add(id));
    r.failed.forEach(x => failed.set(x.productId, `${ACTION_LABEL[c.action]}: ${x.reason}`));
  }
  const result = { applied: [...touched].filter(id => !failed.has(id)), unchanged: [...unchanged].filter(id => !touched.has(id) && !failed.has(id)),
    failed: [...failed].map(([productId, reason]) => ({ productId, reason })) };
  await db.transaction().execute(async tx => {
    await tx.updateTable('bulk_edit_drafts').set({ result: JSON.stringify(result) }).where('id', '=', claim.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.bulk_apply', entityType: 'bulk_edit_drafts', entityId: claim.id,
      after: { number: claim.number, applied: result.applied.length, unchanged: result.unchanged.length, failed: result.failed.length }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
  });
  return result;
}

export async function cancelBulkEditDraft(db: Db, actor: StaffPrincipal, input: { draftId: string }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const r = await tx.updateTable('bulk_edit_drafts').set({ status: 'cancelled', cancelled_at: sql`now()` }).where('id', '=', input.draftId).where('status', '=', 'draft').returning('number').executeTakeFirst();
    if (!r) throw new ConflictError('Only a draft bulk edit can be cancelled.');
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.bulk_cancel', entityType: 'bulk_edit_drafts', entityId: input.draftId, after: { number: r.number },
      ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
  });
}
