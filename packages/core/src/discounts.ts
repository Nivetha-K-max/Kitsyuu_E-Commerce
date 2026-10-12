/* ERP module 1: discounts and coupon codes.
   Data, not code: every discount is a row the business creates under Pricing (percent or fixed; whole order or chosen
   products / categories / collections; dates, minimum order, cap, usage limits). Nothing exists by default, and the
   master switch (settings discounts.enabled) is OFF until the business turns it on ("no discounts at launch"): with it
   off, checkout prices exactly as before. When several discounts apply, settings discounts.stacking decides: only the
   largest (the default when nothing is chosen, so the store never gives more than one discount by accident) or all.
   Usage limits count redemptions of orders that were not cancelled or failed; they are re-checked under a lock when the
   order is placed, so two customers cannot both take the last use. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type CustomerPrincipal, type StaffPrincipal } from '@kitsyuu/auth';
import { lockActiveCart } from './cart.ts';
import type { CouponState, DiscountLine, DiscountSource, PriceableLine } from './pricing.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** Orders in these states do not use up a discount (a replaced, expired or failed checkout gives the use back). */
const NOT_COUNTED = ['cancelled', 'payment_failed'] as const;

export async function discountSettings(q: Queryable): Promise<{ enabled: boolean; stacking: 'best' | 'all' }> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['discounts.enabled', 'discounts.stacking']).execute();
  const v = (k: string) => rows.find(r => r.key === k)?.value;
  return { enabled: v('discounts.enabled') === 'on', stacking: v('discounts.stacking') === 'all' ? 'all' : 'best' };
}

type DiscountRow = {
  id: string; name: string; code: string | null; kind: 'percent' | 'fixed'; value: number; scope: 'order' | 'products' | 'categories' | 'collections';
  product_ids: string[]; category_ids: string[]; collection_ids: string[]; min_order_paise: number | null; max_discount_paise: number | null;
  starts_at: Date | null; ends_at: Date | null; is_active: boolean; usage_limit: number | null; per_customer_limit: number | null;
  /** 2026-10-12: a personal coupon (a referral reward) belongs to this customer; null for every ordinary coupon. */
  customer_id: string | null;
};
const COLS = ['id', 'name', 'code', 'kind', 'value', 'scope', 'product_ids', 'category_ids', 'collection_ids', 'min_order_paise', 'max_discount_paise',
  'starts_at', 'ends_at', 'is_active', 'usage_limit', 'per_customer_limit', 'customer_id'] as const;

async function usage(q: Queryable, discountId: string, customerId: string | null) {
  const r = await q.selectFrom('discount_redemptions as r').innerJoin('orders as o', 'o.id', 'r.order_id')
    .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) filter (where r.customer_id = ${customerId})::int`.as('mine')])
    .where('r.discount_id', '=', discountId).where('o.status', 'not in', [...NOT_COUNTED]).executeTakeFirstOrThrow();
  return r;
}

/** Why a discount does not apply now, or null when it does (dates, activity and limits; not the cart contents). */
async function unavailable(q: Queryable, d: DiscountRow, customerId: string | null, now = new Date()): Promise<string | null> {
  if (!d.is_active) return 'This coupon code is not valid.';
  if (d.customer_id && d.customer_id !== customerId) return 'This coupon belongs to another account.';
  if (d.starts_at && new Date(d.starts_at) > now) return 'This coupon is not valid yet.';
  if (d.ends_at && new Date(d.ends_at) <= now) return 'This coupon has expired.';
  if (d.usage_limit !== null || d.per_customer_limit !== null) {
    const u = await usage(q, d.id, customerId);
    if (d.usage_limit !== null && u.total >= d.usage_limit) return 'This coupon has been fully used.';
    if (d.per_customer_limit !== null && customerId && u.mine >= d.per_customer_limit) return 'You have already used this coupon the maximum number of times.';
  }
  return null;
}

/** The amount a discount takes off these lines, or a reason it does not apply to them. Pure. */
export function discountAmount(d: Pick<DiscountRow, 'kind' | 'value' | 'scope' | 'product_ids' | 'category_ids' | 'collection_ids' | 'min_order_paise' | 'max_discount_paise'>,
  lines: PriceableLine[], subtotalPaise: number, productInfo: Map<string, { categories: string[]; collections: string[] }>): { amount: number; reason: string | null } {
  if (d.min_order_paise !== null && subtotalPaise < d.min_order_paise) return { amount: 0, reason: `Spend ${rupees(d.min_order_paise)} or more to use this coupon.` };
  const eligible = lines.filter(l => {
    if (d.scope === 'order') return true;
    if (d.scope === 'products') return d.product_ids.includes(l.productId);
    const info = productInfo.get(l.productId);
    if (d.scope === 'categories') return !!info?.categories.some(c => d.category_ids.includes(c));
    return !!info?.collections.some(c => d.collection_ids.includes(c));
  }).reduce((n, l) => n + l.lineTotalPaise, 0);
  if (eligible <= 0) return { amount: 0, reason: 'This coupon does not apply to the items in your cart.' };
  let amount = d.kind === 'percent' ? Math.floor(eligible * d.value / 10_000) : Math.min(d.value, eligible);
  if (d.max_discount_paise !== null) amount = Math.min(amount, d.max_discount_paise);
  return { amount: Math.max(0, amount), reason: amount > 0 ? null : 'This coupon does not apply to the items in your cart.' };
}

async function productInfoFor(q: Queryable, productIds: string[]) {
  const ids = [...new Set(productIds)];
  const map = new Map<string, { categories: string[]; collections: string[] }>();
  if (!ids.length) return map;
  const prods = await q.selectFrom('products').select(['id', 'category_id', 'subcategory_id']).where('id', 'in', ids).execute();
  const cols = await q.selectFrom('collection_products').select(['product_id', 'collection_id']).where('product_id', 'in', ids).execute();
  for (const p of prods) map.set(p.id, { categories: [p.category_id, ...(p.subcategory_id ? [p.subcategory_id] : [])], collections: [] });
  for (const c of cols) map.get(c.product_id)?.collections.push(c.collection_id);
  return map;
}

/** Which discounts apply to these lines, for a coupon code (or none): the one evaluation behind the store checkout and the
    POS counter. `automatic` includes the discounts that need no code; `others` are discounts worked out elsewhere that
    compete with these under the business's stacking setting (the staff discount at the counter). */
async function evaluateDiscounts(q: Queryable, input: { lines: PriceableLine[]; subtotalPaise: number; customerId: string | null },
  opts: { code: string | null; automatic: boolean; others?: DiscountLine[]; /** a bill may name no customer (the counter) */ anonymous?: boolean }): Promise<{ discounts: DiscountLine[]; coupon: CouponState | null }> {
  const code = opts.code, others = (opts.others ?? []).filter(o => o.amountPaise > 0);
  const s = await discountSettings(q);
  if (!s.enabled) return { discounts: others, coupon: code ? { code, applied: false, message: 'Coupons are not available right now.' } : null };
  if (!input.lines.length) return { discounts: others, coupon: code ? { code, applied: false, message: null } : null };
  const now = new Date();
  const firstCode = await firstOrderOfferCode(q);
  const rows = !opts.automatic && !code ? [] : await q.selectFrom('discounts').select([...COLS]).where('is_active', '=', true)
    .where(eb => eb.or([...(opts.automatic ? [eb('code', 'is', null)] : []), ...(code ? [eb('code', '=', code)] : [])])).execute() as unknown as DiscountRow[];
  const info = await productInfoFor(q, input.lines.map(l => l.productId));
  const candidates: DiscountLine[] = [...others];
  let coupon: CouponState | null = code ? { code, applied: false, message: 'This coupon code is not valid.' } : null;
  for (const d of rows) {
    // A coupon limited per customer cannot be counted for a bill that names no customer (a walk-in sale at the counter).
    const why = opts.anonymous && d.per_customer_limit !== null && !input.customerId ? 'This coupon is limited per customer: add the customer to the bill to use it.'
      : (await unavailable(q, d, input.customerId, now)) ?? (await firstOrderBlock(q, d, firstCode, input.customerId));
    const r = why ? { amount: 0, reason: why } : discountAmount(d, input.lines, input.subtotalPaise, info);
    if (d.code && d.code === code) coupon = { code, applied: r.amount > 0, message: r.reason };
    if (r.amount > 0) candidates.push({ code: d.code ?? `auto:${d.id.slice(0, 8)}`, label: d.code ? `Coupon ${d.code}` : d.name, amountPaise: r.amount, discountId: d.id });
  }
  let chosen = candidates;
  if (s.stacking === 'best' && candidates.length > 1) {
    const best = candidates.reduce((a, b) => (b.amountPaise > a.amountPaise ? b : a));
    chosen = [best];
  }
  // Never more than the goods are worth.
  let left = input.subtotalPaise;
  chosen = chosen.map(c => { const a = Math.min(c.amountPaise, left); left -= a; return { ...c, amountPaise: a }; }).filter(c => c.amountPaise > 0);
  if (coupon?.applied && !chosen.some(c => c.code === coupon!.code))
    coupon = { ...coupon, applied: false, message: 'A bigger discount already applies to this order; coupons do not combine.' };
  return { discounts: chosen, coupon };
}

/** The discount source the store plugs into pricing (CommerceConfig.discountSource): the coupon kept on the customer's cart
    and the discounts that need no code. */
export const databaseDiscounts: DiscountSource = {
  async evaluate(q, input) {
    const cart = input.cartId ? await q.selectFrom('carts').select('coupon_code').where('id', '=', input.cartId).executeTakeFirst() : undefined;
    return evaluateDiscounts(q, input, { code: cart?.coupon_code ?? null, automatic: true });
  },
};

/** A coupon code as typed at the counter: trimmed and upper-cased, or null when empty. A code that cannot be a coupon code
    stays as typed, so the bill says it is not valid instead of ignoring it. */
export const couponCodeOf = (v: unknown): string | null => { const c = typeof v === 'string' ? v.trim().toUpperCase().slice(0, 40) : ''; return c || null; };

/** The discount source of a POS bill (2026-10-12): the coupon the cashier typed (the store's own coupons, by the same rules:
    dates, minimum order, items, limits) and the staff discount, combined as the business's stacking setting says, exactly
    as the store combines discounts. A bill has no cart, so the code comes with it; discounts that need no code are the
    store's own promotions and are not applied at the counter. */
export const counterDiscounts = (code: string | null, staff: DiscountLine | null): DiscountSource => ({
  evaluate: (q, input) => evaluateDiscounts(q, input, { code, automatic: false, others: staff ? [staff] : [], anonymous: true }),
});

/** Store: the customer types a coupon code (or removes it). Only an active code that exists is kept on the cart; whether
    it applies to the cart (minimum order, items, limits) is shown with the cart totals. */
export async function setCartCoupon(db: Db, p: CustomerPrincipal, code: string | null): Promise<void> {
  if (code) {
    if (!(await discountSettings(db)).enabled) throw new DomainError('invalid', 'Coupons are not available right now.');
    const d = await db.selectFrom('discounts').select([...COLS]).where('code', '=', code).where('is_active', '=', true).executeTakeFirst() as unknown as DiscountRow | undefined;
    if (!d) throw new DomainError('invalid', 'This coupon code is not valid.');
    const why = await unavailable(db, d, p.customerId);
    if (why) throw new DomainError('invalid', why);
  }
  await db.transaction().execute(async tx => {
    const cartId = await lockActiveCart(tx, p.customerId);
    await tx.updateTable('carts').set({ coupon_code: code }).where('id', '=', cartId).execute();
  });
}

/** Inside placeOrder's transaction: records which discounts the order used, re-checking usage limits under a lock. */
export async function recordDiscountRedemptions(tx: Tx, orderId: string, customerId: string | null, discounts: DiscountLine[]): Promise<void> {
  for (const d of discounts) {
    if (!d.discountId || d.amountPaise <= 0) continue;
    await sql`select pg_advisory_xact_lock(hashtext(${'discount:' + d.discountId}))`.execute(tx);
    const row = await tx.selectFrom('discounts').select([...COLS]).where('id', '=', d.discountId).executeTakeFirst() as unknown as DiscountRow | undefined;
    const why = row ? (await unavailable(tx, row, customerId)) ?? (await firstOrderBlock(tx, row, await firstOrderOfferCode(tx), customerId, orderId)) : 'This discount is no longer available.';
    if (why) throw new ConflictError(`${d.label}: ${why} Review your order and try again.`);
    await tx.insertInto('discount_redemptions').values({ discount_id: d.discountId, order_id: orderId, customer_id: customerId,
      code: d.code.startsWith('auto:') ? null : d.code, amount_paise: d.amountPaise }).execute();
  }
}

// ---------------------------------------------------------------- the first-order offer (2026-10-12)
/* One of the business's own coupons can be named as the offer for a customer's FIRST order (Configuration → Discounts →
   "First-order offer coupon": the coupon's code). Everything about the offer is that coupon's row (what it takes off, the
   minimum order, the cap, the dates, the limits), set under Pricing → Discounts; nothing about it is written in code.
   What naming it adds is ONE rule, enforced wherever discounts are evaluated and again under the lock when the order is
   saved: the coupon applies only to a signed-in customer who has no earlier successful order. A successful order is one
   that was paid for or confirmed (paid, processing, shipped, delivered); an order still waiting for payment, one whose
   payment failed and a cancelled one do not count. Nobody is "issued" anything: the offer is shown, and it is the server
   that decides at the cart and at the order whether this customer may use it. Browser state is never asked. */
export const FIRST_ORDER_OFFER_KEY = 'discounts.first_customer_code';
const SUCCESSFUL = ['paid', 'processing', 'shipped', 'delivered'] as const;
export const FIRST_ORDER_SIGN_IN = 'Sign in to use this first-order offer.';
export const FIRST_ORDER_USED = 'This offer is for a first order only, and this account already has an order.';
export const FIRST_ORDER_ON_ANOTHER = 'This offer can be used once, and it is already on another order of yours.';

/** The code of the coupon named as the first-order offer, or null when none is named. */
export async function firstOrderOfferCode(q: Queryable): Promise<string | null> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', FIRST_ORDER_OFFER_KEY).executeTakeFirst();
  return couponCodeOf(r?.value);
}

/** Whether the customer already has a successful order (other than `exceptOrderId`, the one being saved), counting the
    orders from before customer accounts that name only their old user id. */
export async function hasSuccessfulOrder(q: Queryable, customerId: string, exceptOrderId?: string | null): Promise<boolean> {
  const r = await q.selectFrom('orders as o').select('o.id')
    .where(sql<boolean>`(o.customer_id = ${customerId} or (o.customer_id is null and o.user_id = (select c.legacy_auth_user_id from public.customers c where c.id = ${customerId})))`)
    .where('o.status', 'in', [...SUCCESSFUL]).$if(!!exceptOrderId, qb => qb.where('o.id', '<>', exceptOrderId!)).limit(1).executeTakeFirst();
  return !!r;
}

/** Why this customer may not use the first-order offer coupon, or null when they may (or the coupon is not that offer).
    2026-10-12: an order that is still waiting for payment is not a "successful order", so the offer could be put on
    several unpaid orders in a row unless the coupon happened to have a per-customer limit. The offer is therefore also
    refused while it is on another order of this customer that is neither cancelled nor failed (the same orders the
    coupon's own usage counts use). When the order is saved this runs under the coupon's lock. */
async function firstOrderBlock(q: Queryable, d: Pick<DiscountRow, 'id' | 'code'>, firstCode: string | null, customerId: string | null, exceptOrderId?: string | null): Promise<string | null> {
  if (!firstCode || !d.code || d.code !== firstCode) return null;
  if (!customerId) return FIRST_ORDER_SIGN_IN;
  if (await hasSuccessfulOrder(q, customerId, exceptOrderId)) return FIRST_ORDER_USED;
  const onAnother = await q.selectFrom('discount_redemptions as r').innerJoin('orders as o', 'o.id', 'r.order_id').select('r.id')
    .where('r.discount_id', '=', d.id).where('r.customer_id', '=', customerId).where('o.status', 'not in', ['cancelled', 'payment_failed'])
    .$if(!!exceptOrderId, qb => qb.where('o.id', '<>', exceptOrderId!)).limit(1).executeTakeFirst();
  return onAnother ? FIRST_ORDER_ON_ANOTHER : null;
}

export interface FirstOrderOffer {
  code: string; name: string; kind: 'percent' | 'fixed'; /** percent: basis points; fixed: paise */ value: number;
  minOrderPaise: number | null; maxDiscountPaise: number | null; endsAt: Date | null;
}

/** The first-order offer as the store may show it now, or null when there is nothing to offer this visitor: no coupon is
    named, discounts are off, the coupon is inactive, not started, expired or used up, or the signed-in customer is not
    eligible (they already have an order, or have used it). For a guest (customerId null) the offer is shown, never
    promised: whether they may use it is decided when they are signed in. Any doubt answers null. */
export async function firstOrderOffer(q: Queryable, customerId: string | null): Promise<FirstOrderOffer | null> {
  const [s, code] = await Promise.all([discountSettings(q), firstOrderOfferCode(q)]);
  if (!s.enabled || !code) return null;
  const d = await q.selectFrom('discounts').select([...COLS]).where('code', '=', code).where('is_active', '=', true).executeTakeFirst() as unknown as DiscountRow | undefined;
  if (!d) return null;
  if (await unavailable(q, d, customerId)) return null;
  if (customerId && await firstOrderBlock(q, d, code, customerId)) return null;
  return { code: d.code!, name: d.name, kind: d.kind, value: d.value, minOrderPaise: d.min_order_paise, maxDiscountPaise: d.max_discount_paise, endsAt: d.ends_at ? new Date(d.ends_at) : null };
}

/** A signed-in customer takes the first-order offer: the server checks that the offer exists and that THIS customer may
    use it, then puts its coupon on their cart (the same step as typing the code at checkout; doing it twice changes
    nothing). The discount itself is worked out and limited with the cart and when the order is placed. A refusal says why
    in words that reveal nothing about anyone else. The claim is audited as the customer. */
export async function claimFirstOrderOffer(db: Db, p: CustomerPrincipal, ctx: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {}): Promise<{ code: string; already: boolean }> {
  const [s, code] = await Promise.all([discountSettings(db), firstOrderOfferCode(db)]);
  if (!s.enabled || !code) throw new DomainError('invalid', 'This offer is not available right now.');
  const d = await db.selectFrom('discounts').select([...COLS]).where('code', '=', code).where('is_active', '=', true).executeTakeFirst() as unknown as DiscountRow | undefined;
  if (!d) throw new DomainError('invalid', 'This offer is not available right now.');
  const why = (await unavailable(db, d, p.customerId)) ?? (await firstOrderBlock(db, d, code, p.customerId));
  if (why) throw new DomainError('invalid', why);
  return db.transaction().execute(async tx => {
    const cartId = await lockActiveCart(tx, p.customerId);              // one claim at a time per customer
    const cart = await tx.selectFrom('carts').select('coupon_code').where('id', '=', cartId).executeTakeFirstOrThrow();
    if (cart.coupon_code === code) return { code, already: true };
    await tx.updateTable('carts').set({ coupon_code: code }).where('id', '=', cartId).execute();
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'offer.first_order_claim', entityType: 'discounts', entityId: d.id,
      metadata: { code }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { code, already: false };
  });
}

// ---------------------------------------------------------------- admin
export async function listDiscounts(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'pricing.read');
  const rows = await db.selectFrom('discounts as d').leftJoin('campaigns as c', 'c.id', 'd.campaign_id')
    .select([...COLS.map(c => `d.${c}` as const), 'd.campaign_id', 'c.name as campaign_name', 'd.created_at', 'd.updated_at',
      sql<number>`(select count(*)::int from public.discount_redemptions r join public.orders o on o.id = r.order_id where r.discount_id = d.id and o.status not in ('cancelled', 'payment_failed'))`.as('uses'),
      sql<number>`(select coalesce(sum(r.amount_paise), 0)::int from public.discount_redemptions r join public.orders o on o.id = r.order_id where r.discount_id = d.id and o.status not in ('cancelled', 'payment_failed'))`.as('given_paise')])
    .where('d.customer_id', 'is', null).orderBy('d.is_active', 'desc').orderBy('d.created_at', 'desc').execute();
  const now = Date.now();
  return rows.map(r => ({ ...r, state: !r.is_active ? 'inactive' : r.starts_at && new Date(r.starts_at as Date).getTime() > now ? 'scheduled'
    : r.ends_at && new Date(r.ends_at as Date).getTime() <= now ? 'expired' : r.usage_limit !== null && r.uses >= r.usage_limit ? 'used up' : 'active' }));
}

export type DiscountInput = {
  discountId?: string; name: string; code: string | null; kind: 'percent' | 'fixed'; value: number; scope: DiscountRow['scope'];
  productIds: string[]; categoryIds: string[]; collectionIds: string[]; minOrder: number | null; maxDiscount: number | null;
  startsAt: Date | null; endsAt: Date | null; active: boolean; usageLimit: number | null; perCustomerLimit: number | null; campaignId?: string;
};

export async function saveDiscount(db: Db, actor: StaffPrincipal, input: DiscountInput, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  const targets = { products: input.productIds, categories: input.categoryIds, collections: input.collectionIds };
  const row = {
    name: input.name, code: input.code, kind: input.kind, value: input.value, scope: input.scope,
    product_ids: input.scope === 'products' ? targets.products : [], category_ids: input.scope === 'categories' ? targets.categories : [],
    collection_ids: input.scope === 'collections' ? targets.collections : [],
    min_order_paise: input.minOrder, max_discount_paise: input.kind === 'percent' ? input.maxDiscount : null,
    starts_at: input.startsAt, ends_at: input.endsAt, is_active: input.active, usage_limit: input.usageLimit, per_customer_limit: input.perCustomerLimit,
    campaign_id: input.campaignId ?? null, updated_by: actor.staffId,
  };
  return db.transaction().execute(async tx => {
    if (input.code) {
      const clash = await tx.selectFrom('discounts').select('id').where('code', '=', input.code).executeTakeFirst();
      if (clash && clash.id !== input.discountId) throw new ConflictError(`The code ${input.code} is already used by another discount.`);
    }
    const check = async (table: 'products' | 'categories' | 'collections', ids: string[]) => {
      if (!ids.length) return;
      const found = await tx.selectFrom(table).select('id').where('id', 'in', ids).execute();
      if (found.length !== new Set(ids).size) throw new DomainError('invalid', `One of the chosen ${table} no longer exists.`);
    };
    await check('products', row.product_ids); await check('categories', row.category_ids); await check('collections', row.collection_ids);
    if (row.campaign_id && !(await tx.selectFrom('campaigns').select('id').where('id', '=', row.campaign_id).executeTakeFirst())) throw new NotFoundError('Campaign not found.');
    if (!input.discountId) {
      const d = await tx.insertInto('discounts').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'discount.create', entityType: 'discounts', entityId: d.id, after: { ...row, updated_by: undefined } });
      return { id: d.id, created: true };
    }
    const before = await tx.selectFrom('discounts').select([...COLS, 'campaign_id']).where('id', '=', input.discountId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Discount not found.');
    await tx.updateTable('discounts').set(row).where('id', '=', input.discountId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'discount.update', entityType: 'discounts', entityId: input.discountId, before, after: { ...row, updated_by: undefined } });
    return { id: input.discountId, created: false };
  });
}

export async function setDiscountActive(db: Db, actor: StaffPrincipal, input: { discountId: string; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'pricing.manage');
  await db.transaction().execute(async tx => {
    const d = await tx.selectFrom('discounts').select('is_active').where('id', '=', input.discountId).forUpdate().executeTakeFirst();
    if (!d) throw new NotFoundError('Discount not found.');
    if (d.is_active === input.active) return;
    await tx.updateTable('discounts').set({ is_active: input.active, updated_by: actor.staffId }).where('id', '=', input.discountId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.active ? 'discount.activate' : 'discount.deactivate', entityType: 'discounts', entityId: input.discountId,
      before: { is_active: d.is_active }, after: { is_active: input.active } });
  });
}

/** Coupon / discount performance from recorded redemptions (orders not cancelled or failed). */
export async function discountRedemptions(db: Db, actor: StaffPrincipal, discountId?: string, limit = 100) {
  requirePermission(actor, 'pricing.read');
  let q = db.selectFrom('discount_redemptions as r').innerJoin('orders as o', 'o.id', 'r.order_id').innerJoin('discounts as d', 'd.id', 'r.discount_id')
    .select(['r.id', 'r.code', 'r.amount_paise', 'r.created_at', 'o.id as order_id', 'o.order_number', 'o.status as order_status', 'o.total_paise', 'd.name as discount_name']);
  if (discountId) q = q.where('r.discount_id', '=', discountId);
  return (await q.orderBy('r.created_at', 'desc').limit(limit).execute()).map(r => ({ ...r, id: String(r.id) }));
}

/** What a discount, campaign or banner can point at (for the admin forms). */
export async function promotionTargets(db: Db, actor: StaffPrincipal) {
  if (!['pricing.read', 'marketing.read'].some(p => actor.permissions.has(p))) requirePermission(actor, 'pricing.read');
  const [products, categories, collections, campaigns] = await Promise.all([
    db.selectFrom('products').select(['id', 'name', 'sku']).where('status', '!=', 'archived').orderBy('name').execute(),
    db.selectFrom('categories').select(['id', 'label', 'parent_id']).where('is_active', '=', true).orderBy('sort_order').execute(),
    db.selectFrom('collections').select(['id', 'label']).orderBy('sort_order').execute(),
    db.selectFrom('campaigns').select(['id', 'name']).orderBy('created_at', 'desc').execute(),
  ]);
  return { products, categories, collections, campaigns };
}
