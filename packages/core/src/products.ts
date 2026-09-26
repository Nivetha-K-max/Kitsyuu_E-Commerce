/* Product administration: list, detail, edit details, status, price. Product ids are never changed or regenerated,
   and products are never deleted here (deactivating = status draft/archived, which hides them from the storefront).
   Every mutation: permission check → row lock → change + audit record in ONE transaction. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, slugify, type CreateProductInput, type ProductListQuery, type SetProductStatusInput, type UpdatePriceInput, type UpdateProductInput } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export async function listCategories(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'products.read');
  return db.selectFrom('categories').select(['id', 'label', 'parent_id', 'sort_order', 'is_active']).orderBy('sort_order').orderBy('id').execute();
}

export interface ProductListRow {
  id: string; sku: string; name: string; status: 'active' | 'draft' | 'archived'; categoryId: string; subcategoryId: string | null;
  categoryLabel: string; subcategoryLabel: string | null; pricePaise: number; isFeatured: boolean; primaryImage: string | null;
  variants: number; sellableVariants: number; stockUnits: number; attentionVariants: number;
}

export async function listProducts(db: Db, actor: StaffPrincipal, query: ProductListQuery): Promise<ProductListRow[]> {
  requirePermission(actor, 'products.read');
  let q = db.selectFrom('products as p')
    .innerJoin('categories as c', 'c.id', 'p.category_id')
    .leftJoin('categories as sc', 'sc.id', 'p.subcategory_id')
    .select(['p.id', 'p.sku', 'p.name', 'p.status', 'p.category_id', 'p.subcategory_id', 'c.label as category_label', 'sc.label as subcategory_label', 'p.price_paise', 'p.is_featured',
      sql<string | null>`(select i.storage_path from public.product_images i where i.product_id = p.id order by i.is_primary desc, i.sort_order limit 1)`.as('primary_image'),
      sql<number>`(select count(*)::int from public.product_variants v where v.product_id = p.id)`.as('variants'),
      sql<number>`(select count(*)::int from public.product_variants v where v.product_id = p.id and v.is_active)`.as('sellable'),
      sql<number>`(select coalesce(sum(v.stock_qty), 0)::int from public.product_variants v where v.product_id = p.id and v.is_active)`.as('units'),
      sql<number>`(select count(*)::int from public.v_inventory_status s where s.product_id = p.id and s.is_active and s.stock_status <> 'in_stock')`.as('attention')]);
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    q = q.where(eb => eb.or([eb('p.name', 'ilike', like), eb('p.sku', 'ilike', like), eb('p.id', 'ilike', like),
      eb.exists(eb.selectFrom('product_variants as v').select('v.id').whereRef('v.product_id', '=', 'p.id').where('v.sku', 'ilike', like))]));
  }
  if (query.category) q = q.where(eb => eb.or([eb('p.category_id', '=', query.category!), eb('p.subcategory_id', '=', query.category!)]));
  if (query.status === 'active') q = q.where('p.status', '=', 'active');
  if (query.status === 'inactive') q = q.where('p.status', '!=', 'active');
  const rows = await q.orderBy('p.sku').execute();
  return rows.map(r => ({
    id: r.id, sku: r.sku, name: r.name, status: r.status, categoryId: r.category_id, subcategoryId: r.subcategory_id,
    categoryLabel: r.category_label, subcategoryLabel: r.subcategory_label, pricePaise: r.price_paise, isFeatured: r.is_featured,
    primaryImage: r.primary_image, variants: r.variants, sellableVariants: r.sellable, stockUnits: r.units, attentionVariants: r.attention,
  }));
}

export async function getProduct(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'products.read');
  const p = await db.selectFrom('products as p')
    .innerJoin('categories as c', 'c.id', 'p.category_id')
    .leftJoin('categories as sc', 'sc.id', 'p.subcategory_id')
    .select(['p.id', 'p.sku', 'p.slug', 'p.name', 'p.description', 'p.category_id', 'p.subcategory_id', 'c.label as category_label', 'sc.label as subcategory_label',
      'p.price_paise', 'p.colour_label', 'p.colour_swatch', 'p.features', 'p.is_featured', 'p.status', 'p.data_status', 'p.material', 'p.care', 'p.origin', 'p.updated_at'])
    .where('p.id', '=', productId).executeTakeFirst();
  if (!p) throw new NotFoundError('Product not found.');
  const images = await db.selectFrom('product_images').select(['id', 'storage_path', 'alt', 'width', 'height', 'is_primary', 'sort_order'])
    .where('product_id', '=', productId).orderBy('sort_order').orderBy('id').execute();
  const variants = can(actor, 'inventory.read')
    ? await db.selectFrom('v_inventory_status as s').innerJoin('product_variants as v', 'v.id', 's.variant_id')
        .select(['s.variant_id', 's.variant_sku', 's.size', 's.is_active', 's.stock_qty', 's.reorder_level', 's.stock_status', 's.last_movement_at', 'v.price_paise', 'v.sort_order',
          sql<number | null>`v.reorder_level`.as('own_reorder_level'), sql<string>`${VERSION}`.as('version')])
        .where('s.product_id', '=', productId).orderBy('v.sort_order').execute()
    : null;
  const newArrival = can(actor, 'categories.read')
    ? await db.selectFrom('collection_products').select(['position', sql<number>`(select count(*)::int from public.collection_products x where x.collection_id = ${NEW_ARRIVALS})`.as('count'),
        sql<number>`(select count(*)::int from public.collection_products x where x.collection_id = ${NEW_ARRIVALS} and x.position < collection_products.position)`.as('rank')])
        .where('collection_id', '=', NEW_ARRIVALS).where('product_id', '=', productId).executeTakeFirst().then(r => ({ member: !!r, rank: r ? r.rank + 1 : null, count: r?.count ?? null }))
    : null;
  const movements = can(actor, 'inventory.read')
    ? await db.selectFrom('inventory_movements as m').innerJoin('product_variants as v', 'v.id', 'm.variant_id')
        .innerJoin('inventory_reasons as r', 'r.code', 'm.reason').leftJoin('staff_users as s', 's.id', 'm.staff_id')
        .select(['m.id', 'm.created_at', 'v.sku', 'v.size', 'm.delta', 'm.balance_after', 'r.label as reason', 'm.note', 's.email as staff_email'])
        .where('v.product_id', '=', productId).orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(20).execute()
    : null;
  return { product: p, images, variants, movements, newArrival };
}

/** The New Arrivals list is the existing 'new-arrivals' collection (as the approved design: new-arrival = membership). */
export const NEW_ARRIVALS = 'new-arrivals';
/** Row version for stale-write checks: the size row's updated_at in microseconds (a JS Date would lose precision). */
const VERSION = sql.raw(`(extract(epoch from v.updated_at) * 1000000)::bigint::text`);


/** Category must be top-level, the subcategory (if any) must belong to it; for an ACTIVE product both must be active.
    FOR SHARE on the category rows serialises with setCategoryActive (which takes FOR UPDATE). */
async function assertCategoryPair(tx: Tx, categoryId: string, subcategoryId: string | undefined, requireActive: boolean) {
  const cat = await tx.selectFrom('categories').select(['id', 'parent_id', 'is_active']).where('id', '=', categoryId).forShare().executeTakeFirst();
  if (!cat || cat.parent_id !== null) throw new DomainError('invalid', 'Choose a top-level category.');
  if (requireActive && !cat.is_active) throw new ConflictError('That category is inactive. Activate it first, or choose another.');
  if (subcategoryId) {
    const sub = await tx.selectFrom('categories').select(['parent_id', 'is_active']).where('id', '=', subcategoryId).forShare().executeTakeFirst();
    if (!sub || sub.parent_id !== categoryId) throw new DomainError('invalid', 'The subcategory does not belong to the chosen category.');
    if (requireActive && !sub.is_active) throw new ConflictError('That subcategory is inactive. Activate it first, or choose another.');
  }
}

/** A product may only be visible in the store when it can be shown and bought: active categories, at least one
    offered size and a primary image. */
async function assertCanBeActive(tx: Tx, productId: string, categoryId: string, subcategoryId: string | undefined) {
  await assertCategoryPair(tx, categoryId, subcategoryId, true);
  const sizes = await tx.selectFrom('product_variants').select(sql<number>`count(*)::int`.as('n')).where('product_id', '=', productId).where('is_active', '=', true).executeTakeFirstOrThrow();
  if (sizes.n === 0) throw new ConflictError('Add at least one offered size before activating this product.');
  const img = await tx.selectFrom('product_images').select(sql<number>`count(*)::int`.as('n')).where('product_id', '=', productId).where('is_primary', '=', true).executeTakeFirstOrThrow();
  if (img.n === 0) throw new ConflictError('Upload an image (it becomes the primary image) before activating this product.');
}

/** Creates a product as a DRAFT (hidden from the store). The id is generated by the database (kts-xxxxxxxx). */
export async function createProduct(db: Db, actor: StaffPrincipal, input: CreateProductInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  const slug = input.slug ?? slugify(input.name);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 2) throw new DomainError('invalid', 'Enter a store URL slug (the name does not produce one).');
  return db.transaction().execute(async tx => {
    await assertCategoryPair(tx, input.categoryId, input.subcategoryId, false);
    if (await tx.selectFrom('products').select('id').where('sku', '=', input.sku).executeTakeFirst()) throw new ConflictError(`SKU ${input.sku} is already used by another product.`);
    if (await tx.selectFrom('product_variants').select('id').where('sku', '=', input.sku).executeTakeFirst()) throw new ConflictError(`SKU ${input.sku} is already used by a size.`);
    if (await tx.selectFrom('products').select('id').where('slug', '=', slug).executeTakeFirst()) throw new ConflictError(`The store URL /product/${slug} is already used. Choose another slug.`);
    const row = { sku: input.sku, slug, name: input.name, description: input.description, category_id: input.categoryId, subcategory_id: input.subcategoryId ?? null,
      price_paise: input.price, colour_label: input.colourLabel, status: 'draft' as const };
    const created = await tx.insertInto('products').values(row).returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.create', entityType: 'products', entityId: created.id, after: row, ...auditCtx(ctx) });
    return { productId: created.id, slug };
  });
}

export async function setNewArrival(db: Db, actor: StaffPrincipal, input: { productId: string; member: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const col = await tx.selectFrom('collections').select('id').where('id', '=', NEW_ARRIVALS).forUpdate().executeTakeFirst();
    if (!col) throw new NotFoundError('The New Arrivals collection does not exist.');
    if (!(await tx.selectFrom('products').select('id').where('id', '=', input.productId).executeTakeFirst())) throw new NotFoundError('Product not found.');
    const cur = await tx.selectFrom('collection_products').select('position').where('collection_id', '=', NEW_ARRIVALS).where('product_id', '=', input.productId).executeTakeFirst();
    if (!!cur === input.member) return { changed: false };
    if (input.member) {
      const { max } = await tx.selectFrom('collection_products').select(sql<number>`coalesce(max(position), -1)::int`.as('max')).where('collection_id', '=', NEW_ARRIVALS).executeTakeFirstOrThrow();
      await tx.insertInto('collection_products').values({ collection_id: NEW_ARRIVALS, product_id: input.productId, position: max + 1 }).execute();
    } else {
      await tx.deleteFrom('collection_products').where('collection_id', '=', NEW_ARRIVALS).where('product_id', '=', input.productId).execute();
    }
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: input.member ? 'collection.add' : 'collection.remove', entityType: 'collections', entityId: NEW_ARRIVALS,
      before: { member: !!cur, position: cur?.position ?? null }, after: { member: input.member }, metadata: { product_id: input.productId }, ...auditCtx(ctx) });
    return { changed: true };
  });
}

/** Swaps the product with its neighbour in the New Arrivals order. */
export async function moveNewArrival(db: Db, actor: StaffPrincipal, input: { productId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const rows = await tx.selectFrom('collection_products').select(['product_id', 'position']).where('collection_id', '=', NEW_ARRIVALS).orderBy('position').forUpdate().execute();
    const i = rows.findIndex(r => r.product_id === input.productId), j = input.direction === 'up' ? i - 1 : i + 1;
    if (i < 0) throw new NotFoundError('This product is not in New Arrivals.');
    if (j < 0 || j >= rows.length) return { moved: false };
    const [a, b] = [rows[i], rows[j]];
    // Two-step swap through a free position (the primary key does not include position, but keep it collision-free).
    await tx.updateTable('collection_products').set({ position: b.position }).where('collection_id', '=', NEW_ARRIVALS).where('product_id', '=', a.product_id).execute();
    await tx.updateTable('collection_products').set({ position: a.position }).where('collection_id', '=', NEW_ARRIVALS).where('product_id', '=', b.product_id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'collection.reorder', entityType: 'collections', entityId: NEW_ARRIVALS,
      before: { position: a.position }, after: { position: b.position }, metadata: { product_id: a.product_id, swapped_with: b.product_id }, ...auditCtx(ctx) });
    return { moved: true };
  });
}

export async function updateProduct(db: Db, actor: StaffPrincipal, input: UpdateProductInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const before = await tx.selectFrom('products').select(['name', 'description', 'category_id', 'subcategory_id', 'colour_label', 'material', 'care', 'origin', 'features', 'is_featured', 'status'])
      .where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Product not found.');
    await assertCategoryPair(tx, input.categoryId, input.subcategoryId, before.status === 'active');
    const after = {
      name: input.name, description: input.description, category_id: input.categoryId, subcategory_id: input.subcategoryId ?? null,
      colour_label: input.colourLabel, material: input.material, care: input.care, origin: input.origin, features: input.features, is_featured: input.isFeatured,
    };
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!changed.length) return { changed: 0 };
    await tx.updateTable('products').set(after).where('id', '=', input.productId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.update', entityType: 'products', entityId: input.productId,
      before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])), ...auditCtx(ctx) });
    return { changed: changed.length };
  });
}

export async function setProductStatus(db: Db, actor: StaffPrincipal, input: SetProductStatusInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  await db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['status', 'category_id', 'subcategory_id']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    if (p.status === input.status) return;
    if (input.status === 'active') await assertCanBeActive(tx, input.productId, p.category_id, p.subcategory_id ?? undefined);
    await tx.updateTable('products').set({ status: input.status }).where('id', '=', input.productId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.status_update', entityType: 'products', entityId: input.productId,
      before: { status: p.status }, after: { status: input.status }, ...auditCtx(ctx) });
  });
}

/** Changes the product's base price (integer paise). Refused if the price changed since the form was opened. */
export async function updateProductPrice(db: Db, actor: StaffPrincipal, input: UpdatePriceInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['price_paise']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    if (p.price_paise !== input.expectedPricePaise) throw new ConflictError('The price was changed by someone else since you opened this page. Reload and try again.');
    if (p.price_paise === input.price) return { beforePaise: p.price_paise, afterPaise: p.price_paise, changed: false };
    await tx.updateTable('products').set({ price_paise: input.price }).where('id', '=', input.productId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.price_update', entityType: 'products', entityId: input.productId,
      before: { price_paise: p.price_paise }, after: { price_paise: input.price }, ...auditCtx(ctx) });
    return { beforePaise: p.price_paise, afterPaise: input.price, changed: true };
  });
}
