/* Client change request: the bulk product editor. Staff select products and apply ONE change to all of them:
   publish / move to draft / archive, category, add to or remove from a collection, add or remove an attribute value,
   put on sale (percent off each product's own price) or end the sale.
   Each product goes through the same service, checks and audit as a one-by-one edit (so publishing still requires active
   categories, an offered size and a primary image; a sale still respects the maximum sale discount). A product that cannot
   take the change is reported with the reason, never forced. One summary audit record lists the whole operation.
   Permissions: status / category / attributes → products.write; collections → categories.write; sale → pricing.manage. */
import { recordAudit, type Db } from '@kitsyuu/db';
import { DomainError, ForbiddenError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { setProductCategory, setProductStatus } from './products.ts';
import { setCollectionMember } from './merchandising.ts';
import { setProductAttributes } from './attributes.ts';
import { setProductSale } from './sale.ts';

export type BulkAction =
  | { action: 'publish' | 'draft' | 'archive' }
  | { action: 'category'; categoryId: string; subcategoryId: string | null }
  | { action: 'collection_add' | 'collection_remove'; collectionIds: string[] }
  | { action: 'attribute_add' | 'attribute_remove'; values: { attributeId: string; slug: string }[] }
  | { action: 'sale_percent'; percent: number; startsAt: Date | null; endsAt: Date | null }
  | { action: 'sale_clear' };

const PERMISSION: Record<BulkAction['action'], string> = {
  publish: 'products.write', draft: 'products.write', archive: 'products.write', category: 'products.write',
  collection_add: 'categories.write', collection_remove: 'categories.write', attribute_add: 'products.write', attribute_remove: 'products.write',
  sale_percent: 'pricing.manage', sale_clear: 'pricing.manage',
};
export const BULK_MAX_PRODUCTS = 200;

export async function bulkEditProducts(db: Db, actor: StaffPrincipal, input: { productIds: string[] } & BulkAction, ctx: MutationContext) {
  requirePermission(actor, PERMISSION[input.action]);
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
      }
      (changed ? done : unchanged).push(productId);
    } catch (e) {
      if (e instanceof DomainError || e instanceof ForbiddenError) failed.push({ productId, reason: e.message });
      else throw e;
    }
  }
  const { productIds: _ids, ...detail } = input;
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.bulk_edit', entityType: 'products', entityId: null,
    metadata: { ...detail, selected: ids.length, changed: done.length, unchanged: unchanged.length, failed: failed.length },
    ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null }));
  return { done, unchanged, failed };
}
