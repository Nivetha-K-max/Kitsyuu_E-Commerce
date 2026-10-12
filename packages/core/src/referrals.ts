/* Referrals (2026-10-12). OFF until the business switches it on (Configuration → Referrals).

     a customer shares their code  →  someone creates an account with it (attributed once, at sign-up)
     →  that new customer's first eligible order is delivered and the return period passes
     →  BOTH receive a reward: a personal, single-use coupon

   Nothing here is a second coupon engine. A reward is a row in the existing discounts table that belongs to one customer
   (discounts.customer_id), so it is checked, limited, combined with other discounts and shown on bills by the same code
   as every other coupon (discounts.ts, pricing.ts, bill.ts). What the reward is (amount, validity, minimum order) is the
   business's settings, read when the reward is issued; nothing is written in code.

   Rules, all enforced on the server:
   - attribution only at sign-up: the referred account must be the one just created (never an existing account), must not
     be the referrer, and can be referred once (a unique row);
   - a reward is never given because a code was entered: only for the referred customer's first eligible order, i.e.
     placed after the attribution, delivered, with no return or refund on it, and with the return period over;
   - a customer who had already ordered before being attributed, or who shares contact details with the referrer, is
     rejected with the reason;
   - each party gets at most one reward per referral: the referral row is locked while it is decided and the rewards table
     allows one row per party (unique), so a repeated or simultaneous run changes nothing;
   - every decision is in the audit log. */
import { randomInt } from 'node:crypto';
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, uuid } from '@kitsyuu/contracts';
import { can, requirePermission, type CustomerPrincipal, type StaffPrincipal } from '@kitsyuu/auth';
import { returnSettings } from './returns.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: { ip?: string | null; userAgent?: string | null; requestId?: string | null }) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
export const REFERRAL_PAGE_SIZE = 50;
/** How long after an account is created a referral code can still be attached to it (the sign-up request itself). */
const ATTRIBUTION_WINDOW_MINUTES = 30;
const SUCCESSFUL = ['paid', 'processing', 'shipped', 'delivered'] as const;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';          // no 0/O or 1/I: codes are read aloud and typed
const randomCode = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export interface ReferralSettings { enabled: boolean; rewardPaise: number | null; validDays: number | null; minOrderPaise: number | null }
export async function referralSettings(q: Queryable): Promise<ReferralSettings> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['referrals.enabled', 'referrals.reward_paise', 'referrals.coupon_valid_days', 'referrals.min_order_paise']).execute();
  const v = (k: string) => rows.find(r => r.key === k)?.value;
  const pos = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : null);
  return { enabled: v('referrals.enabled') === 'on', rewardPaise: pos(v('referrals.reward_paise')), validDays: pos(v('referrals.coupon_valid_days')), minOrderPaise: pos(v('referrals.min_order_paise')) };
}
/** A referral code as typed or carried in a link: trimmed and upper-cased, or null when it cannot be one. */
export const referralCodeOf = (v: unknown): string | null => { const c = typeof v === 'string' ? v.trim().toUpperCase() : ''; return /^[A-Z0-9]{6,12}$/.test(c) ? c : null; };

// ---------------------------------------------------------------- the customer's side (store)
/** The signed-in customer's referral page: their code (made the first time, while referrals are on), the people they
    referred (no names or emails: when, and where each stands) and the rewards they hold. */
export async function getMyReferral(db: Db, p: CustomerPrincipal) {
  const s = await referralSettings(db);
  let code = (await db.selectFrom('referral_codes').select('code').where('customer_id', '=', p.customerId).executeTakeFirst())?.code ?? null;
  if (!code && s.enabled) {
    for (let i = 0; i < 5 && !code; i++) {
      await db.insertInto('referral_codes').values({ customer_id: p.customerId, code: randomCode(8) }).onConflict(oc => oc.doNothing()).execute();
      code = (await db.selectFrom('referral_codes').select('code').where('customer_id', '=', p.customerId).executeTakeFirst())?.code ?? null;
    }
  }
  const [referrals, rewards] = await Promise.all([
    db.selectFrom('referrals').select(['id', 'status', 'attributed_at', 'rewarded_at']).where('referrer_id', '=', p.customerId).orderBy('attributed_at', 'desc').limit(100).execute(),
    db.selectFrom('referral_rewards as w').innerJoin('discounts as d', 'd.id', 'w.discount_id')
      .select(['w.id', 'w.role', 'w.created_at', 'd.code', 'd.value', 'd.min_order_paise', 'd.ends_at', 'd.is_active',
        sql<boolean>`exists (select 1 from public.discount_redemptions r join public.orders o on o.id = r.order_id where r.discount_id = d.id and o.status not in ('cancelled', 'payment_failed'))`.as('used')])
      .where('w.customer_id', '=', p.customerId).orderBy('w.created_at', 'desc').limit(100).execute(),
  ]);
  const now = Date.now();
  return { settings: s, code, referrals,
    rewards: rewards.map(r => ({ id: r.id, role: r.role, code: r.code!, valuePaise: r.value, minOrderPaise: r.min_order_paise, endsAt: r.ends_at as Date | null, createdAt: r.created_at as Date,
      state: r.used ? 'used' as const : !r.is_active || (r.ends_at && new Date(r.ends_at).getTime() <= now) ? 'expired' as const : 'available' as const })) };
}

/** Attaches a referral code to the account that has JUST been created with this email. Never throws for a bad code or an
    ineligible account: sign-up goes ahead either way and the answer says only whether the code was attached. */
export async function attributeReferral(db: Db, input: { email: string; code: unknown }, ctx: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {}): Promise<{ attributed: boolean; reason?: string }> {
  const code = referralCodeOf(input.code);
  if (!code) return { attributed: false, reason: 'no_code' };
  if (!(await referralSettings(db)).enabled) return { attributed: false, reason: 'off' };
  return db.transaction().execute(async tx => {
    const owner = await tx.selectFrom('referral_codes as rc').innerJoin('customers as c', 'c.id', 'rc.customer_id').select(['c.id', 'c.status']).where('rc.code', '=', code).executeTakeFirst();
    if (!owner || owner.status !== 'active') return { attributed: false, reason: 'unknown_code' };
    const me = await tx.selectFrom('customers').select(['id', 'created_at', 'email_verified_at']).where('email', '=', input.email.trim().toLowerCase()).forUpdate().executeTakeFirst();
    if (!me) return { attributed: false, reason: 'no_account' };
    if (me.id === owner.id) return { attributed: false, reason: 'self' };
    // Only the account that was just created: never an existing account or an existing customer.
    const fresh = !me.email_verified_at && Date.now() - new Date(me.created_at as Date).getTime() <= ATTRIBUTION_WINDOW_MINUTES * 60_000;
    if (!fresh) return { attributed: false, reason: 'existing_account' };
    if (await tx.selectFrom('orders').select('id').where('customer_id', '=', me.id).limit(1).executeTakeFirst()) return { attributed: false, reason: 'existing_customer' };
    const row = await tx.insertInto('referrals').values({ referrer_id: owner.id, referred_id: me.id, code }).onConflict(oc => oc.column('referred_id').doNothing()).returning('id').executeTakeFirst();
    if (!row) return { attributed: false, reason: 'already_referred' };
    await recordAudit(tx, { actorType: 'customer', customerId: me.id, action: 'referral.attributed', entityType: 'referrals', entityId: row.id, metadata: { code }, ...auditCtx(ctx) });
    return { attributed: true };
  });
}

// ---------------------------------------------------------------- deciding and rewarding
export interface ReferralRun { checked: number; rewarded: number; rejected: number; waiting: number; off?: true }
const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '').slice(-10) : '');

/** Why a pending referral cannot be rewarded yet ('wait'), must be rejected ('reject' with the reason), or the order that
    qualifies it. Reads only; called with the referral row locked. */
async function decide(tx: Tx, r: { id: string; referrer_id: string; referred_id: string; attributed_at: Date }, now: Date): Promise<{ kind: 'wait' } | { kind: 'reject'; reason: string } | { kind: 'reward'; orderId: string }> {
  const [referrer, referred] = await Promise.all([r.referrer_id, r.referred_id].map(id => tx.selectFrom('customers').select(['id', 'status', 'phone', 'email_verified_at']).where('id', '=', id).executeTakeFirst()));
  if (!referrer || !referred) return { kind: 'reject', reason: 'An account of this referral no longer exists.' };
  if (referrer.status !== 'active') return { kind: 'reject', reason: 'The referrer\'s account is disabled.' };
  if (referred.status !== 'active' || !referred.email_verified_at) return { kind: 'wait' };
  const orders = await tx.selectFrom('orders as o').select(['o.id', 'o.status', 'o.payment_status', 'o.created_at', sql<string | null>`o.contact->>'phone'`.as('phone'),
    sql<Date | null>`(select max(h.created_at) from public.order_status_history h where h.order_id = o.id and h.to_status = 'delivered')`.as('delivered_at'),
    sql<boolean>`exists (select 1 from public.refunds f where f.order_id = o.id and f.status <> 'failed')`.as('refunded'),
    sql<boolean>`exists (select 1 from public.return_requests q where q.order_id = o.id and q.status not in ('rejected', 'cancelled'))`.as('returned')])
    .where('o.customer_id', '=', referred.id).where('o.status', 'in', [...SUCCESSFUL]).orderBy('o.created_at').orderBy('o.id').execute();
  if (orders.some(o => new Date(o.created_at as Date).getTime() < new Date(r.attributed_at).getTime())) return { kind: 'reject', reason: 'The referred customer had already ordered before the referral.' };
  const phones = new Set([digits(referrer.phone)].filter(Boolean));
  if (phones.size && (phones.has(digits(referred.phone)) || orders.some(o => phones.has(digits(o.phone))))) return { kind: 'reject', reason: 'The referred customer uses the same phone number as the referrer.' };
  const rs = await returnSettings(tx);
  const waitMs = (rs.enabled && rs.windowDays ? rs.windowDays : 0) * 86_400_000;
  // The first order that counts: delivered, nothing returned or refunded on it, and the return period over.
  for (const o of orders) {
    if (o.status !== 'delivered' || o.refunded || o.returned || o.payment_status === 'refunded' || o.payment_status === 'partially_refunded') continue;
    if (!o.delivered_at || new Date(o.delivered_at).getTime() + waitMs > now.getTime()) return { kind: 'wait' };
    return { kind: 'reward', orderId: o.id };
  }
  return { kind: 'wait' };
}

/** Looks at every pending referral and rewards the ones that now qualify (a scheduled job, and staff from the admin).
    Safe to run as often as wanted and from several places at once. With referrals off or no reward amount set it does nothing. */
export async function processReferralRewards(db: Db, opts: { now?: Date; limit?: number } = {}): Promise<ReferralRun> {
  const run: ReferralRun = { checked: 0, rewarded: 0, rejected: 0, waiting: 0 };
  const s = await referralSettings(db);
  if (!s.enabled || !s.rewardPaise) return { ...run, off: true };
  const now = opts.now ?? new Date();
  const ids = await db.selectFrom('referrals').select('id').where('status', '=', 'pending').orderBy('attributed_at').limit(opts.limit ?? 200).execute();
  for (const { id } of ids) {
    const outcome = await db.transaction().execute(async tx => {
      // One decision at a time per referral: a second run waits here, then finds it is no longer pending.
      const r = await tx.selectFrom('referrals').select(['id', 'referrer_id', 'referred_id', 'attributed_at', 'status', 'code']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r || r.status !== 'pending') return 'skip' as const;
      const d = await decide(tx, { ...r, attributed_at: r.attributed_at as Date }, now);
      if (d.kind === 'wait') return 'waiting' as const;
      if (d.kind === 'reject') {
        await tx.updateTable('referrals').set({ status: 'rejected', reject_reason: d.reason, rejected_at: sql<Date>`now()` }).where('id', '=', r.id).execute();
        await recordAudit(tx, { actorType: 'system', action: 'referral.rejected', entityType: 'referrals', entityId: r.id, metadata: { reason: d.reason } });
        return 'rejected' as const;
      }
      const ends = s.validDays ? new Date(now.getTime() + s.validDays * 86_400_000) : null;
      const issued: Record<string, string> = {};
      for (const [role, customerId] of [['referrer', r.referrer_id], ['referred', r.referred_id]] as const) {
        const coupon = await tx.insertInto('discounts').values({ name: `Referral reward (${role === 'referrer' ? 'you referred a friend' : 'welcome'})`, code: `REF-${randomCode(10)}`, kind: 'fixed', value: s.rewardPaise!,
          scope: 'order', min_order_paise: s.minOrderPaise, max_discount_paise: null, starts_at: null, ends_at: ends, is_active: true, usage_limit: 1, per_customer_limit: 1, customer_id: customerId } as never)
          .returning(['id', 'code']).executeTakeFirstOrThrow() as { id: string; code: string };
        await tx.insertInto('referral_rewards').values({ referral_id: r.id, customer_id: customerId, role, discount_id: coupon.id }).execute();
        issued[role] = coupon.id;
      }
      await tx.updateTable('referrals').set({ status: 'rewarded', rewarded_at: sql<Date>`now()`, qualifying_order_id: d.orderId }).where('id', '=', r.id).execute();
      await recordAudit(tx, { actorType: 'system', action: 'referral.rewarded', entityType: 'referrals', entityId: r.id,
        after: { reward_paise: s.rewardPaise, valid_days: s.validDays, min_order_paise: s.minOrderPaise }, metadata: { order_id: d.orderId, discounts: issued } });
      return 'rewarded' as const;
    });
    if (outcome === 'skip') continue;
    run.checked++; run[outcome]++;
  }
  return run;
}

// ---------------------------------------------------------------- staff
/** Referral activity for staff (Marketing → Referrals). Who the customers are is shown only to staff who may read customers. */
export async function listReferrals(db: Db, actor: StaffPrincipal, query: { status: 'all' | 'pending' | 'rewarded' | 'rejected'; page: number }) {
  requirePermission(actor, 'marketing.read');
  const names = can(actor, 'customers.read');
  const page = Number.isInteger(query.page) && query.page >= 1 ? Math.min(query.page, 10_000) : 1;
  let q = db.selectFrom('referrals as r').innerJoin('customers as a', 'a.id', 'r.referrer_id').innerJoin('customers as b', 'b.id', 'r.referred_id').leftJoin('orders as o', 'o.id', 'r.qualifying_order_id')
    .select(['r.id', 'r.code', 'r.status', 'r.reject_reason', 'r.attributed_at', 'r.rewarded_at', 'r.rejected_at', 'r.referrer_id', 'r.referred_id', 'a.email as referrer_email', 'b.email as referred_email',
      'o.id as order_id', 'o.order_number']);
  if (query.status !== 'all') q = q.where('r.status', '=', query.status);
  const rows = await q.orderBy('r.attributed_at', 'desc').orderBy('r.id').limit(REFERRAL_PAGE_SIZE + 1).offset((page - 1) * REFERRAL_PAGE_SIZE).execute();
  const [counts, settings, rewards] = await Promise.all([
    db.selectFrom('referrals').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute(),
    referralSettings(db),
    db.selectFrom('referral_rewards as w').innerJoin('discounts as d', 'd.id', 'w.discount_id').select([sql<number>`count(*)::int`.as('issued'), sql<number>`coalesce(sum(d.value), 0)::int`.as('paise'),
      sql<number>`(count(*) filter (where exists (select 1 from public.discount_redemptions x join public.orders o on o.id = x.order_id where x.discount_id = d.id and o.status not in ('cancelled', 'payment_failed'))))::int`.as('used')]).executeTakeFirstOrThrow(),
  ]);
  return { rows: rows.slice(0, REFERRAL_PAGE_SIZE).map(r => ({ ...r, referrer_email: names ? r.referrer_email : null, referred_email: names ? r.referred_email : null,
      referrer_id: names ? r.referrer_id : null, referred_id: names ? r.referred_id : null })),
    hasNext: rows.length > REFERRAL_PAGE_SIZE, page, counts: Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number>, settings, rewards, names };
}

/** Staff reject a pending referral (abuse, a mistake) with a reason. A rewarded referral cannot be rejected here. */
export async function rejectReferral(db: Db, actor: StaffPrincipal, input: { referralId: string; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'marketing.manage');
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3 || reason.length > 300) throw new DomainError('invalid', 'Give the reason in 3 to 300 characters; it is kept with the referral.');
  if (!uuid.safeParse(input.referralId).success) throw new NotFoundError('Referral not found.');
  await db.transaction().execute(async tx => {
    const r = await tx.selectFrom('referrals').select(['id', 'status']).where('id', '=', input.referralId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Referral not found.');
    if (r.status !== 'pending') throw new ConflictError(`This referral is already ${r.status}.`);
    await tx.updateTable('referrals').set({ status: 'rejected', reject_reason: reason, rejected_by: actor.staffId, rejected_at: sql<Date>`now()` }).where('id', '=', r.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'referral.reject', entityType: 'referrals', entityId: r.id, before: { status: 'pending' }, after: { status: 'rejected' },
      metadata: { reason }, ...auditCtx(ctx) });
  });
}

/** Staff run the reward check now (the same check the scheduled job runs). Audited with what it did. */
export async function runReferralRewards(db: Db, actor: StaffPrincipal, ctx: MutationContext): Promise<ReferralRun> {
  requirePermission(actor, 'marketing.manage');
  const run = await processReferralRewards(db);
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'referral.run', entityType: 'referrals', after: { ...run }, ...auditCtx(ctx) }));
  return run;
}
