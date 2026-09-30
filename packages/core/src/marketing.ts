/* ERP module 4: marketing and promotions — campaigns (a named promotion with dates, target products / collections and
   the discounts linked to it), store banners (published only while active and inside their dates; the store reads them
   through the public RLS policy), and customer segments (saved filters whose thresholds staff enter; members are worked
   out from orders and carts when the segment is opened, never stored). Campaign results come from recorded discount
   redemptions and the orders that used them; nothing is estimated. Sending campaign emails needs a marketing-email
   provider and customer consent, which are not set up: segments can be exported (CSV) instead. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, type SegmentRules } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const SOLD = ['paid', 'processing', 'shipped', 'delivered'] as const;

const liveState = (r: { is_active: boolean; starts_at: unknown; ends_at: unknown }) => {
  const now = Date.now();
  if (!r.is_active) return 'inactive';
  if (r.starts_at && new Date(r.starts_at as Date).getTime() > now) return 'scheduled';
  if (r.ends_at && new Date(r.ends_at as Date).getTime() <= now) return 'expired';
  return 'active';
};

// ---------------------------------------------------------------- campaigns
export async function listCampaigns(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'marketing.read');
  const rows = await db.selectFrom('campaigns as c').select(['c.id', 'c.name', 'c.description', 'c.starts_at', 'c.ends_at', 'c.is_active', 'c.product_ids', 'c.collection_ids', 'c.created_at',
    sql<number>`(select count(*)::int from public.discounts d where d.campaign_id = c.id)`.as('discounts'),
    sql<number>`(select count(*)::int from public.banners b where b.campaign_id = c.id)`.as('banners'),
    sql<number>`(select count(distinct r.order_id)::int from public.discount_redemptions r join public.discounts d on d.id = r.discount_id join public.orders o on o.id = r.order_id
      where d.campaign_id = c.id and o.status in ('paid', 'processing', 'shipped', 'delivered'))`.as('orders'),
    sql<number>`(select coalesce(sum(o.total_paise), 0)::bigint::int from public.orders o where o.id in (select r.order_id from public.discount_redemptions r join public.discounts d on d.id = r.discount_id
      where d.campaign_id = c.id) and o.status in ('paid', 'processing', 'shipped', 'delivered'))`.as('revenue_paise'),
    sql<number>`(select coalesce(sum(r.amount_paise), 0)::int from public.discount_redemptions r join public.discounts d on d.id = r.discount_id join public.orders o on o.id = r.order_id
      where d.campaign_id = c.id and o.status in ('paid', 'processing', 'shipped', 'delivered'))`.as('discount_paise')])
    .orderBy('c.created_at', 'desc').execute();
  return rows.map(r => ({ ...r, state: liveState(r) }));
}

export type CampaignInput = { campaignId?: string; name: string; description: string | null; startsAt: Date | null; endsAt: Date | null; active: boolean; productIds: string[]; collectionIds: string[] };
export async function saveCampaign(db: Db, actor: StaffPrincipal, input: CampaignInput, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  const row = { name: input.name, description: input.description, starts_at: input.startsAt, ends_at: input.endsAt, is_active: input.active,
    product_ids: input.productIds, collection_ids: input.collectionIds };
  return db.transaction().execute(async tx => {
    for (const [table, ids] of [['products', input.productIds], ['collections', input.collectionIds]] as const) {
      if (ids.length && (await tx.selectFrom(table).select('id').where('id', 'in', ids).execute()).length !== new Set(ids).size)
        throw new DomainError('invalid', `One of the chosen ${table} no longer exists.`);
    }
    const clash = await tx.selectFrom('campaigns').select('id').where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.campaignId) throw new ConflictError('A campaign with this name already exists.');
    if (!input.campaignId) {
      const c = await tx.insertInto('campaigns').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'campaign.create', entityType: 'campaigns', entityId: c.id, after: row });
      return { id: c.id };
    }
    const before = await tx.selectFrom('campaigns').select(['name', 'description', 'starts_at', 'ends_at', 'is_active', 'product_ids', 'collection_ids']).where('id', '=', input.campaignId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Campaign not found.');
    await tx.updateTable('campaigns').set(row).where('id', '=', input.campaignId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'campaign.update', entityType: 'campaigns', entityId: input.campaignId, before, after: row });
    return { id: input.campaignId };
  });
}

export async function setCampaignActive(db: Db, actor: StaffPrincipal, input: { campaignId: string; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  await db.transaction().execute(async tx => {
    const c = await tx.selectFrom('campaigns').select('is_active').where('id', '=', input.campaignId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Campaign not found.');
    if (c.is_active === input.active) return;
    await tx.updateTable('campaigns').set({ is_active: input.active }).where('id', '=', input.campaignId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.active ? 'campaign.activate' : 'campaign.deactivate', entityType: 'campaigns', entityId: input.campaignId });
  });
}

// ---------------------------------------------------------------- banners
export async function listBanners(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'marketing.read');
  const rows = await db.selectFrom('banners as b').leftJoin('campaigns as c', 'c.id', 'b.campaign_id')
    .select(['b.id', 'b.placement', 'b.heading', 'b.body', 'b.cta_label', 'b.link', 'b.starts_at', 'b.ends_at', 'b.is_active', 'b.sort_order', 'b.campaign_id', 'c.name as campaign_name', 'b.updated_at'])
    .orderBy('b.placement').orderBy('b.sort_order').orderBy('b.created_at', 'desc').execute();
  return rows.map(r => ({ ...r, state: liveState(r) }));
}

export type BannerInput = { bannerId?: string; placement: 'home' | 'shop'; heading: string; body: string | null; ctaLabel: string | null; link: string | null;
  startsAt: Date | null; endsAt: Date | null; active: boolean; sortOrder: number | null; campaignId?: string };
export async function saveBanner(db: Db, actor: StaffPrincipal, input: BannerInput, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  const row = { placement: input.placement, heading: input.heading, body: input.body, cta_label: input.ctaLabel, link: input.link, starts_at: input.startsAt,
    ends_at: input.endsAt, is_active: input.active, sort_order: input.sortOrder ?? 0, campaign_id: input.campaignId ?? null };
  return db.transaction().execute(async tx => {
    if (row.campaign_id && !(await tx.selectFrom('campaigns').select('id').where('id', '=', row.campaign_id).executeTakeFirst())) throw new NotFoundError('Campaign not found.');
    if (!input.bannerId) {
      const b = await tx.insertInto('banners').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'banner.create', entityType: 'banners', entityId: b.id, after: row });
      return { id: b.id };
    }
    const before = await tx.selectFrom('banners').select(['placement', 'heading', 'body', 'cta_label', 'link', 'starts_at', 'ends_at', 'is_active', 'sort_order', 'campaign_id'])
      .where('id', '=', input.bannerId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Banner not found.');
    await tx.updateTable('banners').set(row).where('id', '=', input.bannerId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'banner.update', entityType: 'banners', entityId: input.bannerId, before, after: row });
    return { id: input.bannerId };
  });
}

export async function setBannerActive(db: Db, actor: StaffPrincipal, input: { bannerId: string; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  await db.transaction().execute(async tx => {
    const b = await tx.selectFrom('banners').select('is_active').where('id', '=', input.bannerId).forUpdate().executeTakeFirst();
    if (!b) throw new NotFoundError('Banner not found.');
    if (b.is_active === input.active) return;
    await tx.updateTable('banners').set({ is_active: input.active }).where('id', '=', input.bannerId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.active ? 'banner.publish' : 'banner.unpublish', entityType: 'banners', entityId: input.bannerId });
  });
}

// ---------------------------------------------------------------- segments
export async function listSegments(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'marketing.read');
  const rows = await db.selectFrom('customer_segments').select(['id', 'name', 'description', 'rules', 'updated_at']).orderBy('name').execute();
  return Promise.all(rows.map(async r => ({ ...r, rules: r.rules as SegmentRules, members: (await segmentMembers(db, r.rules as SegmentRules, { countOnly: true })).count })));
}

export async function saveSegment(db: Db, actor: StaffPrincipal, input: { segmentId?: string; name: string; description: string | null; rules: SegmentRules }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  const row = { name: input.name, description: input.description, rules: JSON.stringify(input.rules) };
  return db.transaction().execute(async tx => {
    const clash = await tx.selectFrom('customer_segments').select('id').where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.segmentId) throw new ConflictError('A segment with this name already exists.');
    if (!input.segmentId) {
      const s = await tx.insertInto('customer_segments').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'segment.create', entityType: 'customer_segments', entityId: s.id, after: { name: input.name, rules: input.rules } });
      return { id: s.id };
    }
    const r = await tx.updateTable('customer_segments').set(row).where('id', '=', input.segmentId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw new NotFoundError('Segment not found.');
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'segment.update', entityType: 'customer_segments', entityId: input.segmentId, after: { name: input.name, rules: input.rules } });
    return { id: input.segmentId };
  });
}

export async function deleteSegment(db: Db, actor: StaffPrincipal, input: { segmentId: string }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  await db.transaction().execute(async tx => {
    const r = await tx.deleteFrom('customer_segments').where('id', '=', input.segmentId).returning('name').executeTakeFirst();
    if (!r) throw new NotFoundError('Segment not found.');
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'segment.delete', entityType: 'customer_segments', entityId: input.segmentId, before: { name: r.name } });
  });
}

/** Customers matching the rules (worked out now from orders and carts). Only active customers; no marketing consent is
    implied: this is a list for staff, not a mailing list. */
export async function segmentMembers(db: Db, rules: SegmentRules, opts: { countOnly?: boolean; limit?: number; abandonAfterHours?: number | null } = {}) {
  const sold = sql.join(SOLD.map(s => sql`${s}`));
  let q = db.selectFrom('customers as c')
    .select(['c.id', 'c.email', 'c.full_name', 'c.created_at',
      sql<number>`(select count(*)::int from public.orders o where o.customer_id = c.id and o.status in (${sold}))`.as('orders'),
      sql<number>`(select coalesce(sum(o.total_paise), 0)::bigint::int from public.orders o where o.customer_id = c.id and o.status in (${sold}))`.as('spent_paise'),
      sql<Date | null>`(select max(o.created_at) from public.orders o where o.customer_id = c.id and o.status in (${sold}))`.as('last_order_at')])
    .where('c.status', '=', 'active');
  const orders = sql<number>`(select count(*) from public.orders o where o.customer_id = c.id and o.status in (${sold}))`;
  const spent = sql<number>`(select coalesce(sum(o.total_paise), 0) from public.orders o where o.customer_id = c.id and o.status in (${sold}))`;
  const last = sql<Date | null>`(select max(o.created_at) from public.orders o where o.customer_id = c.id and o.status in (${sold}))`;
  if (rules.joinedWithinDays !== null) q = q.where(sql<boolean>`c.created_at > now() - make_interval(days => ${rules.joinedWithinDays})`);
  if (rules.minOrders !== null) q = q.where(sql<boolean>`${orders} >= ${rules.minOrders}`);
  if (rules.maxOrders !== null) q = q.where(sql<boolean>`${orders} <= ${rules.maxOrders}`);
  if (rules.minSpendPaise !== null) q = q.where(sql<boolean>`${spent} >= ${rules.minSpendPaise}`);
  if (rules.lastOrderOlderThanDays !== null) q = q.where(sql<boolean>`${last} < now() - make_interval(days => ${rules.lastOrderOlderThanDays})`);
  if (rules.lastOrderWithinDays !== null) q = q.where(sql<boolean>`${last} > now() - make_interval(days => ${rules.lastOrderWithinDays})`);
  if (rules.hasAbandonedCart) {
    const h = opts.abandonAfterHours ?? null;
    // Without the business's abandoned-cart threshold (carts.abandon_after_hours) no cart counts as abandoned.
    q = h ? q.where(sql<boolean>`exists (select 1 from public.carts k where k.customer_id = c.id and k.status = 'active'
      and exists (select 1 from public.cart_items i where i.cart_id = k.id) and k.updated_at < now() - make_interval(hours => ${h}))`) : q.where(sql<boolean>`false`);
  }
  if (opts.countOnly) {
    const r = await db.selectFrom(q.as('m')).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    return { count: r.n, rows: [] };
  }
  const rows = await q.orderBy('c.created_at', 'desc').limit(opts.limit ?? 500).execute();
  return { count: rows.length, rows };
}

export async function getSegment(db: Db, actor: StaffPrincipal, segmentId: string) {
  requirePermission(actor, 'marketing.read');
  const s = await db.selectFrom('customer_segments').select(['id', 'name', 'description', 'rules']).where('id', '=', segmentId).executeTakeFirst();
  if (!s) throw new NotFoundError('Segment not found.');
  const h = await db.selectFrom('settings').select('value').where('key', '=', 'carts.abandon_after_hours').executeTakeFirst();
  const hours = Number(h?.value);
  const members = await segmentMembers(db, s.rules as SegmentRules, { abandonAfterHours: Number.isInteger(hours) && hours > 0 ? hours : null });
  return { segment: { ...s, rules: s.rules as SegmentRules }, members };
}

/** Coupon and promotion report: each discount's uses, discount given and the revenue of the orders that used it. */
export async function promotionReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'marketing.read');
  return db.selectFrom('discount_redemptions as r').innerJoin('discounts as d', 'd.id', 'r.discount_id').innerJoin('orders as o', 'o.id', 'r.order_id')
    .leftJoin('campaigns as c', 'c.id', 'd.campaign_id')
    .select(['d.id', 'd.name', 'd.code', 'c.name as campaign_name', sql<number>`count(*)::int`.as('uses'), sql<number>`count(distinct o.customer_id)::int`.as('customers'),
      sql<number>`coalesce(sum(r.amount_paise), 0)::int`.as('discount_paise'), sql<number>`coalesce(sum(o.total_paise), 0)::bigint::int`.as('revenue_paise')])
    .where('o.status', 'in', [...SOLD])
    .where(sql<boolean>`(r.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`)
    .groupBy(['d.id', 'd.name', 'd.code', 'c.name']).orderBy(sql`count(*)`, 'desc').execute();
}
