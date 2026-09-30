/* ERP module 7: carts and wishlists for staff. READ-ONLY for customer data: staff can see what is in a cart or wishlist,
   but nothing here changes a customer's cart (the admin role has no write access to carts or cart items). What staff can
   change is the recovery record of an abandoned cart (open / emailed / recovered / dismissed, a note, a campaign) and, when
   the business has switched the reminder email on, send one reminder at a time.
   "Abandoned" is the business's threshold (carts.abandon_after_hours): an active cart with items not changed for that
   long. With no threshold set, no cart is called abandoned. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type Mailer, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { hello, sendCustomerEmail, storeLink, type EmailResult } from './customer-email.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
export const CART_PAGE_SIZE = 40;

export async function abandonAfterHours(q: Queryable): Promise<number | null> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'carts.abandon_after_hours').executeTakeFirst();
  const h = Number(r?.value);
  return Number.isInteger(h) && h > 0 ? h : null;
}

const cartValue = sql<number>`(select coalesce(sum(i.qty * coalesce(v.price_paise, p.price_paise)), 0)::int from public.cart_items i
  join public.product_variants v on v.id = i.variant_id join public.products p on p.id = v.product_id where i.cart_id = k.id)`;
const cartUnits = sql<number>`(select coalesce(sum(i.qty), 0)::int from public.cart_items i where i.cart_id = k.id)`;
const lastTouched = sql<Date>`greatest(k.updated_at, coalesce((select max(i.updated_at) from public.cart_items i where i.cart_id = k.id), k.updated_at))`;

export async function listCarts(db: Db, actor: StaffPrincipal, query: { view: 'active' | 'abandoned' | 'converted' | 'all'; q?: string; page: number }) {
  requirePermission(actor, 'carts.read');
  const hours = await abandonAfterHours(db);
  let q = db.selectFrom('carts as k').leftJoin('customers as c', 'c.id', 'k.customer_id').leftJoin('cart_recovery as r', 'r.cart_id', 'k.id')
    .select(['k.id', 'k.status', 'k.created_at', 'k.coupon_code', 'c.id as customer_id', 'c.email', 'c.full_name', 'r.status as recovery_status', 'r.emailed_at', 'r.email_count',
      cartValue.as('value_paise'), cartUnits.as('units'), lastTouched.as('last_activity')]);
  const hasItems = sql<boolean>`exists (select 1 from public.cart_items i where i.cart_id = k.id)`;
  const stale = hours ? sql<boolean>`${lastTouched} < now() - make_interval(hours => ${hours})` : sql<boolean>`false`;
  if (query.view === 'active') q = q.where('k.status', '=', 'active').where(hasItems).where(sql<boolean>`not (${stale})`);
  else if (query.view === 'abandoned') q = q.where('k.status', '=', 'active').where(hasItems).where(stale);
  else if (query.view === 'converted') q = q.where('k.status', '=', 'converted');
  if (query.q) { const l = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('c.email', 'ilike', l), eb('c.full_name', 'ilike', l)])); }
  const rows = await q.orderBy(lastTouched, 'desc').limit(CART_PAGE_SIZE + 1).offset((query.page - 1) * CART_PAGE_SIZE).execute();
  const [summary] = (await sql<{ active: number; abandoned: number; abandoned_value: number; converted: number; recovered: number }>`
    select count(*) filter (where k.status = 'active' and exists (select 1 from public.cart_items i where i.cart_id = k.id) and not (${stale}))::int as active,
      count(*) filter (where k.status = 'active' and exists (select 1 from public.cart_items i where i.cart_id = k.id) and ${stale})::int as abandoned,
      coalesce(sum(${cartValue}) filter (where k.status = 'active' and ${stale}), 0)::float8 as abandoned_value,
      count(*) filter (where k.status = 'converted')::int as converted,
      (select count(*)::int from public.cart_recovery r where r.status = 'recovered') as recovered
    from public.carts k`.execute(db)).rows;
  return { rows: rows.slice(0, CART_PAGE_SIZE), hasNext: rows.length > CART_PAGE_SIZE, hours, summary };
}

export async function getCart(db: Db, actor: StaffPrincipal, cartId: string) {
  requirePermission(actor, 'carts.read');
  const cart = await db.selectFrom('carts as k').leftJoin('customers as c', 'c.id', 'k.customer_id').leftJoin('cart_recovery as r', 'r.cart_id', 'k.id')
    .leftJoin('staff_users as s', 's.id', 'r.updated_by')
    .select(['k.id', 'k.status', 'k.created_at', 'k.updated_at', 'k.coupon_code', 'c.id as customer_id', 'c.email', 'c.full_name', 'r.status as recovery_status', 'r.note as recovery_note',
      'r.emailed_at', 'r.email_count', 'r.campaign_id', 's.email as recovery_by', cartValue.as('value_paise'), lastTouched.as('last_activity')])
    .where('k.id', '=', cartId).executeTakeFirst();
  if (!cart) throw new NotFoundError('Cart not found.');
  const items = await db.selectFrom('cart_items as i').innerJoin('product_variants as v', 'v.id', 'i.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['i.id', 'p.id as product_id', 'p.name', 'p.sku', 'v.size', 'i.qty', 'v.stock_qty', 'p.status as product_status', 'i.updated_at',
      sql<number>`coalesce(v.price_paise, p.price_paise)`.as('unit_paise')]).where('i.cart_id', '=', cartId).orderBy('i.created_at').execute();
  const hours = await abandonAfterHours(db);
  const abandoned = cart.status === 'active' && items.length > 0 && !!hours && new Date(cart.last_activity).getTime() < Date.now() - hours * 3_600_000;
  return { cart, items, abandoned, hours };
}

export async function setCartRecovery(db: Db, actor: StaffPrincipal, input: { cartId: string; status: 'open' | 'dismissed' | 'recovered'; note: string | null; campaignId?: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'carts.manage');
  await db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('carts').select('id').where('id', '=', input.cartId).executeTakeFirst())) throw new NotFoundError('Cart not found.');
    const before = await tx.selectFrom('cart_recovery').select(['status', 'note']).where('cart_id', '=', input.cartId).forUpdate().executeTakeFirst();
    await tx.insertInto('cart_recovery').values({ cart_id: input.cartId, status: input.status, note: input.note, updated_by: actor.staffId, campaign_id: input.campaignId ?? null })
      .onConflict(oc => oc.column('cart_id').doUpdateSet({ status: input.status, note: input.note, updated_by: actor.staffId, updated_at: sql<Date>`now()` as unknown as Date,
        ...(input.campaignId !== undefined ? { campaign_id: input.campaignId } : {}) })).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'cart.recovery_update', entityType: 'carts', entityId: input.cartId,
      before: before ?? null, after: { status: input.status, note: input.note }, ...auditCtx(ctx) });
  });
}

/** Sends one reminder email for an abandoned cart (only when the business switched the reminder email on). Never changes the cart. */
export async function sendCartReminder(db: Db, actor: StaffPrincipal, mailer: Mailer, input: { cartId: string }, ctx: MutationContext, opts: { storeUrl?: string | null } = {}): Promise<EmailResult> {
  requirePermission(actor, 'carts.manage');
  const { cart, items, abandoned } = await getCart(db, actor, input.cartId);
  if (!abandoned) throw new ConflictError('Only an abandoned cart can be sent a reminder.');
  if (cart.recovery_status === 'dismissed' || cart.recovery_status === 'recovered') throw new ConflictError(`This cart is marked ${cart.recovery_status}.`);
  const result = await sendCustomerEmail(db, mailer, 'cart.reminder', async () => {
    if (!cart.email) return null;
    const list = items.filter(i => i.product_status === 'active').map(i => `- ${i.name}, size ${i.size} × ${i.qty}`);
    if (!list.length) return null;
    return { to: cart.email, subject: 'You left something in your KITSYUU cart', text: [hello(cart.full_name), '', 'These are still in your cart:', ...list, '',
      'Stock is not held for carts, so sizes may sell out.', '', ...storeLink(opts.storeUrl, '/cart', 'Your cart')].join('\n') };
  });
  if (result.sent) {
    await db.transaction().execute(async tx => {
      await tx.insertInto('cart_recovery').values({ cart_id: input.cartId, status: 'emailed', emailed_at: sql<Date>`now()` as unknown as Date, email_count: 1, updated_by: actor.staffId })
        .onConflict(oc => oc.column('cart_id').doUpdateSet({ status: 'emailed', emailed_at: sql<Date>`now()` as unknown as Date, email_count: sql<number>`cart_recovery.email_count + 1`, updated_by: actor.staffId, updated_at: sql<Date>`now()` as unknown as Date })).execute();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'cart.reminder_sent', entityType: 'carts', entityId: input.cartId, ...auditCtx(ctx) });
    });
  }
  return result;
}

/** Most wanted products: in how many wishlists and carts each product is now. */
export async function wishlistReport(db: Db, actor: StaffPrincipal, limit = 50) {
  requirePermission(actor, 'carts.read');
  return db.selectFrom('products as p')
    .select(['p.id', 'p.name', 'p.sku', 'p.status',
      sql<number>`(select count(distinct w.id)::int from public.wishlist_items wi join public.wishlists w on w.id = wi.wishlist_id where wi.product_id = p.id)`.as('wishlists'),
      sql<number>`(select count(distinct k.id)::int from public.cart_items i join public.carts k on k.id = i.cart_id join public.product_variants v on v.id = i.variant_id
        where v.product_id = p.id and k.status = 'active')`.as('carts'),
      sql<number>`(select coalesce(sum(v.stock_qty), 0)::int from public.product_variants v where v.product_id = p.id and v.is_active)`.as('stock')])
    .where(sql<boolean>`exists (select 1 from public.wishlist_items wi where wi.product_id = p.id) or exists (select 1 from public.cart_items i join public.product_variants v on v.id = i.variant_id join public.carts k on k.id = i.cart_id where v.product_id = p.id and k.status = 'active')`)
    .orderBy(sql`5`, "desc").limit(limit).execute().then(rows => rows.sort((a, b) => b.wishlists - a.wishlists || b.carts - a.carts));
}

export async function listWishlists(db: Db, actor: StaffPrincipal, query: { q?: string; page: number }) {
  requirePermission(actor, 'carts.read');
  let q = db.selectFrom('wishlists as w').innerJoin('customers as c', 'c.id', 'w.customer_id')
    .select(['w.id', 'c.id as customer_id', 'c.email', 'c.full_name', 'w.updated_at', sql<number>`(select count(*)::int from public.wishlist_items i where i.wishlist_id = w.id)`.as('items')])
    .where(sql<boolean>`exists (select 1 from public.wishlist_items i where i.wishlist_id = w.id)`);
  if (query.q) { const l = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('c.email', 'ilike', l), eb('c.full_name', 'ilike', l)])); }
  const rows = await q.orderBy('w.updated_at', 'desc').limit(CART_PAGE_SIZE + 1).offset((query.page - 1) * CART_PAGE_SIZE).execute();
  return { rows: rows.slice(0, CART_PAGE_SIZE), hasNext: rows.length > CART_PAGE_SIZE };
}
