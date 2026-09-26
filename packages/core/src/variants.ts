/* Sizes (product_variants). A size's SKU is the product SKU + '-' + size and never changes (order lines keep it);
   sizes are never deleted (turn "offered" off instead). New sizes start with 0 units: stock only ever arrives through
   adjust_stock() and the inventory ledger. Edits carry a version token (updated_at in microseconds) and are refused
   if the row changed since the form was opened. Every change is audited in the same transaction. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, NotFoundError, type UpdateVariantInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const VERSION = sql<string>`(extract(epoch from updated_at) * 1000000)::bigint::text`;

export async function addVariant(db: Db, actor: StaffPrincipal, input: { productId: string; size: string }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['id', 'sku']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    const sku = `${p.sku}-${input.size}`;
    if (await tx.selectFrom('product_variants').select('id').where('product_id', '=', p.id).where(sql`upper(size)`, '=', input.size).executeTakeFirst())
      throw new ConflictError(`Size ${input.size} already exists for this product.`);
    if (await tx.selectFrom('product_variants').select('id').where('sku', '=', sku).executeTakeFirst()) throw new ConflictError(`SKU ${sku} is already used.`);
    if (await tx.selectFrom('products').select('id').where('sku', '=', sku).executeTakeFirst()) throw new ConflictError(`SKU ${sku} is already used by a product.`);
    const { max } = await tx.selectFrom('product_variants').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).where('product_id', '=', p.id).executeTakeFirstOrThrow();
    const row = { product_id: p.id, size: input.size, sku, sort_order: max + 1, stock_source: 'manual', is_active: true };
    const v = await tx.insertInto('product_variants').values(row).returning(['id', 'stock_qty']).executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.variant_create', entityType: 'product_variants', entityId: v.id,
      after: { ...row, stock_qty: v.stock_qty }, ...auditCtx(ctx) });
    return { variantId: v.id, sku };
  });
}

export async function updateVariant(db: Db, actor: StaffPrincipal, input: UpdateVariantInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('product_variants').select(['id', 'product_id', 'sku', 'is_active', 'price_paise', 'reorder_level', VERSION.as('version')])
      .where('id', '=', input.variantId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    if (v.version !== input.expectedVersion) throw new ConflictError(`Size ${v.sku} was changed by someone else since you opened this page. Reload and try again.`);
    const after = { is_active: input.isActive, price_paise: input.price, reorder_level: input.reorderLevel };
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(k => v[k] !== after[k]);
    if (!changed.length) return { changed: 0, sku: v.sku };
    if (v.is_active && !input.isActive) {
      const p = await tx.selectFrom('products').select('status').where('id', '=', v.product_id).forUpdate().executeTakeFirstOrThrow();
      const others = await tx.selectFrom('product_variants').select(sql<number>`count(*)::int`.as('n'))
        .where('product_id', '=', v.product_id).where('is_active', '=', true).where('id', '!=', v.id).executeTakeFirstOrThrow();
      if (p.status === 'active' && others.n === 0) throw new ConflictError('An active product needs at least one offered size. Deactivate the product first.');
    }
    await tx.updateTable('product_variants').set(after).where('id', '=', v.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.variant_update', entityType: 'product_variants', entityId: v.id,
      before: Object.fromEntries(changed.map(k => [k, v[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])), metadata: { sku: v.sku, product_id: v.product_id }, ...auditCtx(ctx) });
    return { changed: changed.length, sku: v.sku };
  });
}

/** Swaps the size with its neighbour in the product's size order. */
export async function moveVariant(db: Db, actor: StaffPrincipal, input: { variantId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('product_variants').select(['product_id']).where('id', '=', input.variantId).executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    const sizes = await tx.selectFrom('product_variants').select(['id', 'sku', 'sort_order']).where('product_id', '=', v.product_id).orderBy('sort_order').orderBy('sku').forUpdate().execute();
    const i = sizes.findIndex(s => s.id === input.variantId), j = input.direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sizes.length) return { moved: false };
    const [a, b] = [sizes[i], sizes[j]];
    await tx.updateTable('product_variants').set({ sort_order: b.sort_order }).where('id', '=', a.id).execute();
    await tx.updateTable('product_variants').set({ sort_order: a.sort_order }).where('id', '=', b.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.variant_reorder', entityType: 'product_variants', entityId: a.id,
      before: { sort_order: a.sort_order }, after: { sort_order: b.sort_order }, metadata: { sku: a.sku, swapped_with: b.sku }, ...auditCtx(ctx) });
    return { moved: true };
  });
}
