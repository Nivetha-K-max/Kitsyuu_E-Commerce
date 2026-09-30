/* Client change request: a SALE PRICE separate from the base price. The base price (products.price_paise, or a size's own
   price) is never overwritten by a sale. A sale price is set on the product (it applies to every size that uses the product
   price) and optionally on a size that has its own price, with optional start and end dates on the product.
   The price a customer pays is worked out here, on the server, the same way for the cart, checkout and the order:
     effective = the sale price while the sale is running and it is below the base price; otherwise the base price.
   Staff may not set a sale deeper than Settings → Pricing → "Maximum sale discount" (when a value is set) unless they hold
   pricing.sale_override. No limit is set until the business chooses one. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { DomainError, ForbiddenError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

/** Whether the product's sale is running now (SQL, for a query with products aliased `p`). */
export const saleRunningSql = sql<boolean>`(p.sale_price_paise is not null and (p.sale_starts_at is null or p.sale_starts_at <= now()) and (p.sale_ends_at is null or p.sale_ends_at > now()))`;
/** The base price of a size (its own price, else the product's), for a query with `v` and `p`. */
export const basePriceSql = sql<number>`coalesce(v.price_paise, p.price_paise)`;
/** The price a customer pays for a size now (for a query with `v` and `p`). Never above the base price. */
export const effectivePriceSql = sql<number>`(case when ${saleRunningSql}
  then least(coalesce(case when v.price_paise is null then p.sale_price_paise else v.sale_price_paise end, coalesce(v.price_paise, p.price_paise)), coalesce(v.price_paise, p.price_paise))
  else coalesce(v.price_paise, p.price_paise) end)`;

/** Pure version of the same rule (display code and tests). */
export function effectivePrice(i: { basePaise: number; salePaise: number | null; startsAt?: Date | string | null; endsAt?: Date | string | null }, now = new Date()): number {
  const running = i.salePaise !== null && (!i.startsAt || new Date(i.startsAt) <= now) && (!i.endsAt || new Date(i.endsAt) > now);
  return running ? Math.min(i.salePaise!, i.basePaise) : i.basePaise;
}

export async function maxSaleDiscountPercent(q: Queryable): Promise<number | null> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'pricing.max_sale_discount_percent').executeTakeFirst();
  const n = Number(r?.value);
  return Number.isInteger(n) && n > 0 && n < 100 ? n : null;
}

/** Refuses a sale that is not below the base price, or deeper than the staff limit without pricing.sale_override. */
export async function checkSale(q: Queryable, actor: StaffPrincipal, basePaise: number, salePaise: number, what: string) {
  if (salePaise >= basePaise) throw new DomainError('invalid', `${what}: the sale price must be below the price (${(basePaise / 100).toFixed(2)}).`);
  const limit = await maxSaleDiscountPercent(q);
  const off = (basePaise - salePaise) * 100 / basePaise;
  if (limit !== null && off > limit + 1e-9 && !can(actor, 'pricing.sale_override'))
    throw new ForbiddenError(`${what}: that is ${off.toFixed(1)}% off; the maximum sale discount is ${limit}%. A manager with the sale override permission can set it.`);
}

export type SaleInput = { productId: string; variantId?: string; salePrice: number | null; startsAt: Date | null; endsAt: Date | null };

/** Sets or clears the sale price of a product (with dates) or of one size that has its own price. Audited; the price-history
    trigger records it too. */
export async function setProductSale(db: Db, actor: StaffPrincipal, input: SaleInput, ctx: MutationContext, source: 'manual' | 'bulk' = 'manual') {
  requirePermission(actor, 'pricing.manage');
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw new DomainError('invalid', 'The sale must end after it starts.');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['name', 'price_paise', 'sale_price_paise', 'sale_starts_at', 'sale_ends_at']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    await sql`select set_config('kitsyuu.price_source', ${source}, true), set_config('kitsyuu.staff_id', ${actor.staffId}, true), set_config('kitsyuu.price_change', '', true)`.execute(tx);
    if (!input.variantId) {
      if (input.salePrice !== null) await checkSale(tx, actor, p.price_paise, input.salePrice, p.name);
      const after = { sale_price_paise: input.salePrice, sale_starts_at: input.salePrice === null ? null : input.startsAt, sale_ends_at: input.salePrice === null ? null : input.endsAt };
      const same = p.sale_price_paise === after.sale_price_paise && String(p.sale_starts_at ?? '') === String(after.sale_starts_at ?? '') && String(p.sale_ends_at ?? '') === String(after.sale_ends_at ?? '');
      if (same) return { changed: false };
      await tx.updateTable('products').set(after).where('id', '=', input.productId).execute();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'pricing.sale_update', entityType: 'products', entityId: input.productId,
        before: { sale_price_paise: p.sale_price_paise, sale_starts_at: p.sale_starts_at, sale_ends_at: p.sale_ends_at }, after, metadata: { source }, ...auditCtx(ctx) });
      return { changed: true };
    }
    const v = await tx.selectFrom('product_variants').select(['size', 'price_paise', 'sale_price_paise']).where('id', '=', input.variantId).where('product_id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    if (v.price_paise === null && input.salePrice !== null)
      throw new DomainError('invalid', `Size ${v.size} uses the product price, so it takes the product's sale price. Set the sale on the product.`);
    if (input.salePrice !== null) await checkSale(tx, actor, v.price_paise!, input.salePrice, `${p.name}, size ${v.size}`);
    if (v.sale_price_paise === input.salePrice) return { changed: false };
    await tx.updateTable('product_variants').set({ sale_price_paise: input.salePrice }).where('id', '=', input.variantId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'pricing.sale_update', entityType: 'product_variants', entityId: input.variantId,
      before: { sale_price_paise: v.sale_price_paise }, after: { sale_price_paise: input.salePrice }, metadata: { product_id: input.productId, source }, ...auditCtx(ctx) });
    return { changed: true };
  });
}
