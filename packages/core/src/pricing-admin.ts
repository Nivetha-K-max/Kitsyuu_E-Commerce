/* ERP module 1: product prices for staff — current and compare-at ("was") prices per product and size, price changes
   scheduled for later, bulk changes, and the price history (written by a database trigger for every change, whichever
   screen or job made it). Checkout keeps reading products.price_paise / product_variants.price_paise as before, so a
   price change applies to the next cart that is priced; orders already placed keep the price they were placed at. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
export const PRICING_PAGE_SIZE = 40;

/** Tells the price-history trigger how and by whom prices change in this transaction. */
async function priceSource(tx: Tx, source: 'manual' | 'bulk' | 'scheduled', staffId: string | null, changeId: string | null = null) {
  await sql`select set_config('kitsyuu.price_source', ${source}, true), set_config('kitsyuu.staff_id', ${staffId ?? ''}, true),
    set_config('kitsyuu.price_change', ${changeId ?? ''}, true)`.execute(tx);
}

/** A "was" price must be above the price it is shown next to. */
function checkCompare(price: number, compareAt: number | null, what: string) {
  if (compareAt !== null && compareAt <= price) throw new DomainError('invalid', `${what}: the compare-at price must be higher than the price (${(price / 100).toFixed(2)}).`);
}

export async function listProductPrices(db: Db, actor: StaffPrincipal, query: { q?: string; filter?: 'all' | 'sale' | 'scheduled' | 'overrides'; page: number }) {
  requirePermission(actor, 'pricing.read');
  let q = db.selectFrom('products as p').select(['p.id', 'p.sku', 'p.name', 'p.status', 'p.price_paise', 'p.compare_at_paise', 'p.sale_price_paise', 'p.sale_starts_at', 'p.sale_ends_at',
    sql<number>`(select count(*)::int from public.product_variants v where v.product_id = p.id)`.as('sizes'),
    sql<number>`(select count(*)::int from public.product_variants v where v.product_id = p.id and (v.price_paise is not null or v.compare_at_paise is not null))`.as('overrides'),
    sql<number>`(select count(*)::int from public.price_changes c where c.product_id = p.id and c.status = 'scheduled')`.as('scheduled')]);
  if (query.q) { const t = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('p.name', 'ilike', t), eb('p.sku', 'ilike', t)])); }
  if (query.filter === 'sale') q = q.where(sql<boolean>`(p.compare_at_paise > p.price_paise or (p.sale_price_paise is not null and (p.sale_ends_at is null or p.sale_ends_at > now())))`);
  if (query.filter === 'scheduled') q = q.where(sql<boolean>`exists (select 1 from public.price_changes c where c.product_id = p.id and c.status = 'scheduled')`);
  if (query.filter === 'overrides') q = q.where(sql<boolean>`exists (select 1 from public.product_variants v where v.product_id = p.id and (v.price_paise is not null or v.compare_at_paise is not null))`);
  const rows = await q.orderBy('p.name').limit(PRICING_PAGE_SIZE + 1).offset((query.page - 1) * PRICING_PAGE_SIZE).execute();
  return { rows: rows.slice(0, PRICING_PAGE_SIZE), hasNext: rows.length > PRICING_PAGE_SIZE };
}

export async function getProductPricing(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'pricing.read');
  const product = await db.selectFrom('products').select(['id', 'sku', 'name', 'status', 'price_paise', 'compare_at_paise', 'sale_price_paise', 'sale_starts_at', 'sale_ends_at']).where('id', '=', productId).executeTakeFirst();
  if (!product) throw new NotFoundError('Product not found.');
  const [variants, changes, history] = await Promise.all([
    db.selectFrom('product_variants').select(['id', 'size', 'sku', 'price_paise', 'compare_at_paise', 'sale_price_paise', 'is_active']).where('product_id', '=', productId).orderBy('sort_order').execute(),
    db.selectFrom('price_changes as c').leftJoin('product_variants as v', 'v.id', 'c.variant_id').leftJoin('staff_users as s', 's.id', 'c.created_by')
      .select(['c.id', 'c.variant_id', 'v.size', 'c.new_price_paise', 'c.new_compare_at_paise', 'c.clear_compare_at', 'c.effective_at', 'c.status', 'c.note',
        'c.failure_reason', 'c.applied_at', 's.email as created_by_email'])
      .where('c.product_id', '=', productId).orderBy('c.effective_at', 'desc').limit(50).execute(),
    priceHistory(db, actor, { productId, limit: 50 }),
  ]);
  return { product, variants, changes, history };
}

export async function priceHistory(db: Db, actor: StaffPrincipal, opts: { productId?: string; limit?: number } = {}) {
  requirePermission(actor, 'pricing.read');
  let q = db.selectFrom('price_history as h').innerJoin('products as p', 'p.id', 'h.product_id').leftJoin('product_variants as v', 'v.id', 'h.variant_id')
    .leftJoin('staff_users as s', 's.id', 'h.staff_user_id')
    .select(['h.id', 'h.product_id', 'p.name as product_name', 'p.sku', 'v.size', 'h.field', 'h.old_paise', 'h.new_paise', 'h.source', 'h.created_at', 's.email as staff_email']);
  if (opts.productId) q = q.where('h.product_id', '=', opts.productId);
  return (await q.orderBy('h.created_at', 'desc').orderBy('h.id', 'desc').limit(opts.limit ?? 100).execute()).map(r => ({ ...r, id: String(r.id) }));
}

/** Sets the price and compare-at price of a product, or of one size (a size with no price uses the product's). */
export async function setProductPricing(db: Db, actor: StaffPrincipal, input: { productId: string; variantId?: string; price: number | null; compareAt: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['price_paise', 'compare_at_paise', 'name']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    await priceSource(tx, 'manual', actor.staffId);
    if (!input.variantId) {
      if (input.price === null) throw new DomainError('invalid', 'Enter the product price.');
      checkCompare(input.price, input.compareAt, p.name);
      if (p.price_paise === input.price && p.compare_at_paise === input.compareAt) return { changed: false };
      await tx.updateTable('products').set({ price_paise: input.price, compare_at_paise: input.compareAt }).where('id', '=', input.productId).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pricing.update', entityType: 'products', entityId: input.productId,
        before: { price_paise: p.price_paise, compare_at_paise: p.compare_at_paise }, after: { price_paise: input.price, compare_at_paise: input.compareAt } });
      return { changed: true };
    }
    const v = await tx.selectFrom('product_variants').select(['price_paise', 'compare_at_paise', 'size']).where('id', '=', input.variantId).where('product_id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    checkCompare(input.price ?? p.price_paise, input.compareAt, `${p.name}, size ${v.size}`);
    if (v.price_paise === input.price && v.compare_at_paise === input.compareAt) return { changed: false };
    await tx.updateTable('product_variants').set({ price_paise: input.price, compare_at_paise: input.compareAt }).where('id', '=', input.variantId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pricing.update', entityType: 'product_variants', entityId: input.variantId,
      before: { price_paise: v.price_paise, compare_at_paise: v.compare_at_paise }, after: { price_paise: input.price, compare_at_paise: input.compareAt }, metadata: { product_id: input.productId } });
    return { changed: true };
  });
}

export async function schedulePriceChange(db: Db, actor: StaffPrincipal,
  input: { productId: string; variantId?: string; price: number | null; compareAt: number | null; clearCompareAt: boolean; effectiveAt: Date | null; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  if (!input.effectiveAt) throw new DomainError('invalid', 'Choose when the change takes effect.');
  const effectiveAt = input.effectiveAt;
  if (effectiveAt.getTime() <= Date.now() + 60_000) throw new DomainError('invalid', 'Choose a time in the future (to change a price now, edit it directly).');
  return db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('products').select('id').where('id', '=', input.productId).executeTakeFirst())) throw new NotFoundError('Product not found.');
    if (input.variantId && !(await tx.selectFrom('product_variants').select('id').where('id', '=', input.variantId).where('product_id', '=', input.productId).executeTakeFirst()))
      throw new NotFoundError('Size not found.');
    const c = await tx.insertInto('price_changes').values({ product_id: input.productId, variant_id: input.variantId ?? null, new_price_paise: input.price,
      new_compare_at_paise: input.compareAt, clear_compare_at: input.clearCompareAt, effective_at: effectiveAt, note: input.note, created_by: actor.staffId })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pricing.schedule', entityType: 'price_changes', entityId: c.id,
      after: { product_id: input.productId, variant_id: input.variantId ?? null, price: input.price, compare_at: input.compareAt, clear_compare_at: input.clearCompareAt, effective_at: effectiveAt } });
    return { id: c.id };
  });
}

export async function cancelPriceChange(db: Db, actor: StaffPrincipal, input: { changeId: string }, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  await db.transaction().execute(async tx => {
    const c = await tx.selectFrom('price_changes').select('status').where('id', '=', input.changeId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Scheduled change not found.');
    if (c.status !== 'scheduled') throw new ConflictError(`This change is already ${c.status}.`);
    await tx.updateTable('price_changes').set({ status: 'cancelled', cancelled_at: sql<Date>`now()` }).where('id', '=', input.changeId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pricing.schedule_cancel', entityType: 'price_changes', entityId: input.changeId, before: { status: 'scheduled' }, after: { status: 'cancelled' } });
  });
}

export async function listScheduledChanges(db: Db, actor: StaffPrincipal, status: 'scheduled' | 'all' = 'scheduled') {
  requirePermission(actor, 'pricing.read');
  let q = db.selectFrom('price_changes as c').innerJoin('products as p', 'p.id', 'c.product_id').leftJoin('product_variants as v', 'v.id', 'c.variant_id')
    .leftJoin('staff_users as s', 's.id', 'c.created_by')
    .select(['c.id', 'c.product_id', 'p.name as product_name', 'p.sku', 'v.size', 'c.new_price_paise', 'c.new_compare_at_paise', 'c.clear_compare_at',
      'c.effective_at', 'c.status', 'c.note', 'c.failure_reason', 'c.applied_at', 's.email as created_by_email']);
  if (status === 'scheduled') q = q.where('c.status', '=', 'scheduled');
  return q.orderBy('c.effective_at', status === 'scheduled' ? 'asc' : 'desc').limit(200).execute();
}

/** Applies scheduled price changes that are due (system job; also run when staff open Pricing). Each change is applied in
    its own transaction; one that would be invalid (e.g. compare-at not above the price) is marked failed with the reason. */
export async function applyDuePriceChanges(db: Db, limit = 200): Promise<{ applied: number; failed: number }> {
  const due = await db.selectFrom('price_changes').select('id').where('status', '=', 'scheduled').where('effective_at', '<=', sql<Date>`now()`)
    .orderBy('effective_at').limit(limit).execute();
  let applied = 0, failed = 0;
  for (const { id } of due) {
    const r = await db.transaction().execute(async tx => {
      const c = await tx.selectFrom('price_changes').selectAll().where('id', '=', id).where('status', '=', 'scheduled').forUpdate().skipLocked().executeTakeFirst();
      if (!c) return null;
      const target = c.variant_id
        ? await tx.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
            .select(['v.price_paise', 'v.compare_at_paise', 'p.price_paise as product_price']).where('v.id', '=', c.variant_id).forUpdate().executeTakeFirst()
        : await tx.selectFrom('products').select(['price_paise', 'compare_at_paise', 'price_paise as product_price']).where('id', '=', c.product_id).forUpdate().executeTakeFirst();
      const fail = async (reason: string) => {
        await tx.updateTable('price_changes').set({ status: 'failed', failure_reason: reason.slice(0, 300) }).where('id', '=', id).execute();
        await recordAudit(tx, { actorType: 'system', action: 'pricing.schedule_failed', entityType: 'price_changes', entityId: id, metadata: { reason } });
        return 'failed' as const;
      };
      if (!target) return fail('The product or size no longer exists.');
      const price = c.new_price_paise ?? target.price_paise;
      const compare = c.clear_compare_at ? null : c.new_compare_at_paise ?? target.compare_at_paise;
      const effective = price ?? target.product_price;
      if (compare !== null && effective !== null && compare <= effective) return fail('The compare-at price would not be above the price.');
      await priceSource(tx, 'scheduled', c.created_by, id);
      if (c.variant_id) await tx.updateTable('product_variants').set({ price_paise: price, compare_at_paise: compare }).where('id', '=', c.variant_id).execute();
      else await tx.updateTable('products').set({ price_paise: price!, compare_at_paise: compare }).where('id', '=', c.product_id).execute();
      await tx.updateTable('price_changes').set({ status: 'applied', applied_at: sql<Date>`now()` }).where('id', '=', id).execute();
      await recordAudit(tx, { actorType: 'system', action: 'pricing.schedule_apply', entityType: 'price_changes', entityId: id,
        before: { price_paise: target.price_paise, compare_at_paise: target.compare_at_paise }, after: { price_paise: price, compare_at_paise: compare } });
      return 'applied' as const;
    });
    if (r === 'applied') applied++; else if (r === 'failed') failed++;
  }
  return { applied, failed };
}

/** Changes the base price of many products at once (sizes with their own price are left as they are and counted). */
export async function bulkUpdatePrices(db: Db, actor: StaffPrincipal,
  input: { productIds: string[]; mode: 'increase_percent' | 'decrease_percent' | 'increase_amount' | 'decrease_amount' | 'set'; amount: number; keepCompareAt: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  return db.transaction().execute(async tx => {
    const rows = await tx.selectFrom('products').select(['id', 'name', 'price_paise', 'compare_at_paise']).where('id', 'in', input.productIds).orderBy('id').forUpdate().execute();
    if (rows.length !== new Set(input.productIds).size) throw new NotFoundError('One of the chosen products no longer exists.');
    const next = (p: number) => {
      switch (input.mode) {
        case 'increase_percent': return Math.round(p * (10_000 + input.amount) / 10_000);
        case 'decrease_percent': return Math.round(p * (10_000 - input.amount) / 10_000);
        case 'increase_amount': return p + input.amount;
        case 'decrease_amount': return p - input.amount;
        default: return input.amount;
      }
    };
    const plan = rows.map(r => {
      const price = next(r.price_paise);
      // A sale keeps the old price as the "was" price. Otherwise a "was" price that would no longer be above the new price is cleared.
      const compare = input.keepCompareAt && price < r.price_paise ? r.price_paise : r.compare_at_paise !== null && r.compare_at_paise <= price ? null : r.compare_at_paise;
      return { ...r, price, compare };
    });
    const bad = plan.filter(p => p.price <= 0 || p.price > 1_000_000_000);
    if (bad.length) throw new ConflictError(`The new price would be zero or less for: ${bad.slice(0, 5).map(b => b.name).join(', ')}${bad.length > 5 ? '…' : ''}. Nothing was changed.`);
    await priceSource(tx, 'bulk', actor.staffId);
    let changed = 0;
    for (const p of plan) {
      if (p.price === p.price_paise && p.compare === p.compare_at_paise) continue;
      await tx.updateTable('products').set({ price_paise: p.price, compare_at_paise: p.compare }).where('id', '=', p.id).execute();
      changed++;
    }
    const overrides = await tx.selectFrom('product_variants').select(sql<number>`count(*)::int`.as('n')).where('product_id', 'in', input.productIds).where('price_paise', 'is not', null).executeTakeFirstOrThrow();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pricing.bulk_update', entityType: 'products', entityId: null,
      metadata: { mode: input.mode, amount: input.amount, keep_compare_at: input.keepCompareAt, products: input.productIds.length, changed } });
    return { changed, sizeOverrides: overrides.n };
  });
}

export async function pricingOverview(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'pricing.read');
  const n = sql<number>`count(*)::int`;
  const [sale, scheduled, active, redeemed] = await Promise.all([
    db.selectFrom('products').select(n.as('n')).where(sql<boolean>`compare_at_paise > price_paise or (sale_price_paise is not null and (sale_ends_at is null or sale_ends_at > now()))`).executeTakeFirstOrThrow(),
    db.selectFrom('price_changes').select(n.as('n')).where('status', '=', 'scheduled').executeTakeFirstOrThrow(),
    db.selectFrom('discounts').select(n.as('n')).where('is_active', '=', true).where(eb => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', sql<Date>`now()`)])).executeTakeFirstOrThrow(),
    db.selectFrom('discount_redemptions as r').innerJoin('orders as o', 'o.id', 'r.order_id')
      .select([n.as('n'), sql<number>`coalesce(sum(r.amount_paise), 0)::int`.as('paise')])
      .where('o.status', 'not in', ['cancelled', 'payment_failed']).where('r.created_at', '>', sql<Date>`now() - interval '30 days'`).executeTakeFirstOrThrow(),
  ]);
  return { onSale: sale.n, scheduled: scheduled.n, activeDiscounts: active.n, redemptions30d: redeemed.n, discount30dPaise: redeemed.paise };
}
