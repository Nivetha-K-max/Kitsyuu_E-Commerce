/* Client change request, second pass: loyalty points.

   The rules are the business's, and none is invented here. Every value is a setting (Settings → Loyalty) and nothing
   happens until it is set:
   - loyalty.enabled                on/off (off: nobody earns or redeems; balances and staff adjustments still work)
   - loyalty.earn_points_per_100    points earned per ₹100 of goods paid for (after discounts; not delivery or fees)
   - loyalty.earn_when              when points are earned: once the order is paid, or once it is delivered
   - loyalty.point_value_paise      what one point takes off an order (no value: points cannot be redeemed)
   - loyalty.min_redeem_points      the fewest points a customer may use on an order (optional)
   - loyalty.max_redeem_points      the most points a customer may use on one order (optional)
   - loyalty.expiry_months          points expire this long after they were added (no value: they never expire)

   Security: every change is made here, on the server, inside the transaction that causes it (placing, paying, delivering
   or cancelling an order; a staff adjustment with its reason), with the customer's balance row locked. The browser only
   says "use my points"; how many and what they are worth is worked out here. Every change is a ledger row
   (loyalty_transactions) and staff changes are also in the audit log.

   Points are spent soonest-expiring first; only points still unused expire. A cancelled order gives back the points it used
   and takes back the points it earned (as many as the customer still has). */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type CustomerPrincipal, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export interface LoyaltySettings {
  enabled: boolean; earnPer100: number | null; earnWhen: 'paid' | 'delivered' | null;
  pointValuePaise: number | null; minRedeem: number | null; maxRedeem: number | null; expiryMonths: number | null;
}
export const LOYALTY_KEYS = ['loyalty.enabled', 'loyalty.earn_points_per_100', 'loyalty.earn_when', 'loyalty.point_value_paise',
  'loyalty.min_redeem_points', 'loyalty.max_redeem_points', 'loyalty.expiry_months'] as const;

const posInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

export async function readLoyaltySettings(q: Queryable): Promise<LoyaltySettings> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', [...LOYALTY_KEYS]).execute();
  const v = new Map(rows.map(r => [r.key, r.value]));
  const when = v.get('loyalty.earn_when');
  return {
    enabled: v.get('loyalty.enabled') === 'on', earnPer100: posInt(v.get('loyalty.earn_points_per_100')),
    earnWhen: when === 'paid' || when === 'delivered' ? when : null, pointValuePaise: posInt(v.get('loyalty.point_value_paise')),
    minRedeem: posInt(v.get('loyalty.min_redeem_points')), maxRedeem: posInt(v.get('loyalty.max_redeem_points')), expiryMonths: posInt(v.get('loyalty.expiry_months')),
  };
}

/** Points earned for an amount of goods paid for (pure). */
export const pointsForAmount = (goodsPaise: number, earnPer100: number) => Math.max(0, Math.floor(goodsPaise * earnPer100 / 10_000));

export interface LoyaltyQuote {
  /** Redemption is possible at all (switched on and a point value is set). */
  redeemable: boolean;
  balance: number; pointValuePaise: number | null;
  /** The most points this order can use now, and what they would take off. */
  usablePoints: number; usableValuePaise: number;
  /** Points actually applied (the customer asked to use them and they are usable). */
  usedPoints: number; discountPaise: number;
  /** Why points cannot be used on this order (shown at checkout), or null. */
  message: string | null;
}

/** What the customer's points can do for an order worth goodsPaise (goods after other discounts). Pure. */
export function quoteLoyalty(s: LoyaltySettings, balance: number, goodsPaise: number, use: boolean): LoyaltyQuote {
  const none = (message: string | null): LoyaltyQuote => ({ redeemable: false, balance, pointValuePaise: s.pointValuePaise, usablePoints: 0, usableValuePaise: 0, usedPoints: 0, discountPaise: 0, message });
  if (!s.enabled || !s.pointValuePaise) return none(null);
  let usable = Math.min(balance, Math.floor(Math.max(0, goodsPaise) / s.pointValuePaise));
  if (s.maxRedeem !== null) usable = Math.min(usable, s.maxRedeem);
  const min = s.minRedeem ?? 1;
  if (balance < min) return { ...none(balance > 0 ? `At least ${min} points are needed to use them on an order.` : null), redeemable: true };
  if (usable < min) return { ...none(`This order is too small to use ${min} points.`), redeemable: true };
  const value = usable * s.pointValuePaise;
  return { redeemable: true, balance, pointValuePaise: s.pointValuePaise, usablePoints: usable, usableValuePaise: value,
    usedPoints: use ? usable : 0, discountPaise: use ? value : 0, message: null };
}

export async function loyaltyBalance(q: Queryable, customerId: string): Promise<number> {
  const r = await q.selectFrom('loyalty_accounts').select('balance').where('customer_id', '=', customerId).executeTakeFirst();
  return r?.balance ?? 0;
}

/** Creates the customer's balance row if needed and locks it for the rest of the transaction. */
export async function lockLoyaltyAccount(tx: Tx, customerId: string): Promise<number> {
  await tx.insertInto('loyalty_accounts').values({ customer_id: customerId }).onConflict(oc => oc.column('customer_id').doNothing()).execute();
  return (await tx.selectFrom('loyalty_accounts').select('balance').where('customer_id', '=', customerId).forUpdate().executeTakeFirstOrThrow()).balance;
}

type Entry = { customerId: string; points: number; kind: 'earn' | 'redeem' | 'adjust' | 'import' | 'restore' | 'reverse' | 'expire';
  orderId?: string | null; reversesId?: string | null; reason?: string | null; staffId?: string | null };

const expiryFor = (months: number | null) => (months ? sql<Date>`now() + make_interval(months => ${months})` : null);

/** Adds points (a positive ledger row that can later be spent or expire). The balance row must be locked. */
async function addPoints(tx: Tx, e: Entry, expiryMonths: number | null) {
  const row = await tx.insertInto('loyalty_transactions').values({ customer_id: e.customerId, points: e.points, kind: e.kind, order_id: e.orderId ?? null,
    reverses_id: e.reversesId ?? null, reason: e.reason ?? null, staff_id: e.staffId ?? null, remaining: e.points,
    expires_at: expiryFor(expiryMonths) as unknown as Date | null }).returning('id').executeTakeFirstOrThrow();
  await tx.updateTable('loyalty_accounts').set({ balance: sql<number>`balance + ${e.points}`, updated_at: sql<Date>`now()` }).where('customer_id', '=', e.customerId).execute();
  return row.id;
}

/** Takes points (soonest-expiring first). Refused when the customer does not have them. The balance row must be locked. */
async function takePoints(tx: Tx, e: Entry) {
  const need = -e.points;
  const open = await tx.selectFrom('loyalty_transactions').select(['id', 'remaining']).where('customer_id', '=', e.customerId).where('remaining', '>', 0)
    .where(eb => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .orderBy(sql`expires_at asc nulls last`).orderBy('created_at').orderBy('id').forUpdate().execute();
  const available = open.reduce((n, r) => n + (r.remaining ?? 0), 0);
  if (available < need) throw new ConflictError(`Only ${available} points are available.`);
  let left = need;
  for (const r of open) {
    if (!left) break;
    const take = Math.min(left, r.remaining!);
    await tx.updateTable('loyalty_transactions').set({ remaining: r.remaining! - take }).where('id', '=', r.id).execute();
    left -= take;
  }
  const row = await tx.insertInto('loyalty_transactions').values({ customer_id: e.customerId, points: e.points, kind: e.kind, order_id: e.orderId ?? null,
    reverses_id: e.reversesId ?? null, reason: e.reason ?? null, staff_id: e.staffId ?? null }).returning('id').executeTakeFirstOrThrow();
  await tx.updateTable('loyalty_accounts').set({ balance: sql<number>`balance - ${need}`, updated_at: sql<Date>`now()` }).where('customer_id', '=', e.customerId).execute();
  return row.id;
}

// ---------------------------------------------------------------- order hooks (called inside the order's transaction)

/** Placing an order that uses points: takes them (the checkout already priced them with the balance row locked). */
export async function redeemForOrder(tx: Tx, customerId: string, orderId: string, points: number, orderNumber: string) {
  if (points <= 0) return;
  await lockLoyaltyAccount(tx, customerId);
  await takePoints(tx, { customerId, points: -points, kind: 'redeem', orderId, reason: `Used on order ${orderNumber}` });
}

/** Earns the order's points when it reaches the moment the business chose (paid or delivered). Once per order. */
export async function earnForOrder(tx: Tx, orderId: string, moment: 'paid' | 'delivered'): Promise<number> {
  const s = await readLoyaltySettings(tx);
  if (!s.enabled || !s.earnPer100 || s.earnWhen !== moment) return 0;
  const o = await tx.selectFrom('orders').select(['id', 'order_number', 'customer_id', 'status', 'subtotal_paise', 'discount_paise']).where('id', '=', orderId).executeTakeFirst();
  if (!o?.customer_id || o.status === 'cancelled' || o.status === 'refunded') return 0;
  if (await tx.selectFrom('loyalty_transactions').select('id').where('order_id', '=', orderId).where('kind', '=', 'earn').executeTakeFirst()) return 0;
  const points = pointsForAmount(o.subtotal_paise - o.discount_paise, s.earnPer100);
  if (points <= 0) return 0;
  await lockLoyaltyAccount(tx, o.customer_id);
  await addPoints(tx, { customerId: o.customer_id, points, kind: 'earn', orderId, reason: `Order ${o.order_number}` }, s.expiryMonths);
  return points;
}

/** A cancelled order: gives back the points it used and takes back the points it earned (as many as are left). Once each. */
export async function reverseOrderPoints(tx: Tx, orderId: string, note: string): Promise<{ restored: number; reversed: number }> {
  const rows = await tx.selectFrom('loyalty_transactions').select(['id', 'customer_id', 'points', 'kind']).where('order_id', '=', orderId)
    .where('kind', 'in', ['earn', 'redeem']).execute();
  let restored = 0, reversed = 0;
  for (const r of rows) {
    if (await tx.selectFrom('loyalty_transactions').select('id').where('reverses_id', '=', r.id).executeTakeFirst()) continue;
    const balance = await lockLoyaltyAccount(tx, r.customer_id);
    if (r.kind === 'redeem') {
      const s = await readLoyaltySettings(tx);
      await addPoints(tx, { customerId: r.customer_id, points: -r.points, kind: 'restore', orderId, reversesId: r.id, reason: note }, s.expiryMonths);
      restored += -r.points;
    } else {
      const take = Math.min(r.points, balance);                       // points already spent elsewhere cannot be taken back
      if (take > 0) {
        await takePoints(tx, { customerId: r.customer_id, points: -take, kind: 'reverse', orderId, reversesId: r.id,
          reason: take < r.points ? `${note} (${r.points - take} of the earned points were already used)` : note });
        reversed += take;
      }
    }
  }
  return { restored, reversed };
}

// ---------------------------------------------------------------- staff

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

/** Staff add (positive) or remove (negative) points with a reason. Needs loyalty.adjust. */
export async function adjustLoyaltyPoints(db: Db, actor: StaffPrincipal, input: { customerId: string; points: number; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'loyalty.adjust');
  if (!Number.isInteger(input.points) || input.points === 0 || Math.abs(input.points) > 1_000_000) throw new DomainError('invalid', 'Enter a whole number of points (not 0).');
  if (!input.reason.trim()) throw new DomainError('invalid', 'Give a reason; it is kept in the points history.');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('customers').select(['id', 'email']).where('id', '=', input.customerId).executeTakeFirst();
    if (!c) throw new NotFoundError('Customer not found.');
    const before = await lockLoyaltyAccount(tx, c.id);
    const s = await readLoyaltySettings(tx);
    const e: Entry = { customerId: c.id, points: input.points, kind: 'adjust', reason: input.reason.trim(), staffId: actor.staffId };
    const id = input.points > 0 ? await addPoints(tx, e, s.expiryMonths) : await takePoints(tx, e);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'loyalty.adjust', entityType: 'customers', entityId: c.id,
      before: { balance: before }, after: { balance: before + input.points }, metadata: { points: input.points, reason: input.reason.trim(), transaction_id: id }, ...auditCtx(ctx) });
    return { balance: before + input.points };
  });
}

export const LOYALTY_IMPORT_MAX_LINES = 2000;

/** Parses an import file: one line per customer, "email,points" or "email,points,reason" (a header line is allowed). Pure. */
export function parseLoyaltyImport(text: string): { rows: { line: number; email: string; points: number; reason: string | null }[]; errors: string[] } {
  const rows: { line: number; email: string; points: number; reason: string | null }[] = [], errors: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const [email, pts, ...rest] = line.split(/[,\t]/).map(x => x.trim());
    if (i === 0 && /^e-?mail$/i.test(email ?? '')) return;                         // header
    const points = Number(pts);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`Line ${i + 1}: "${email ?? ''}" is not an email address.`);
    else if (!Number.isInteger(points) || points <= 0 || points > 1_000_000) errors.push(`Line ${i + 1}: points must be a whole number above 0.`);
    else rows.push({ line: i + 1, email: email.toLowerCase(), points, reason: rest.join(', ').slice(0, 300) || null });
  });
  if (rows.length > LOYALTY_IMPORT_MAX_LINES) errors.push(`At most ${LOYALTY_IMPORT_MAX_LINES} lines per file.`);
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.email)) errors.push(`Line ${r.line}: ${r.email} appears more than once.`); seen.add(r.email); }
  return { rows, errors };
}

/** Imports opening balances from a file: every line must match a customer account, otherwise nothing is imported. */
export async function importLoyaltyPoints(db: Db, actor: StaffPrincipal, input: { text: string; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'loyalty.adjust');
  const { rows, errors } = parseLoyaltyImport(input.text);
  if (!rows.length && !errors.length) throw new DomainError('invalid', 'The file has no lines to import.');
  if (errors.length) throw new DomainError('invalid', `Nothing was imported. ${errors.slice(0, 10).join(' ')}${errors.length > 10 ? ` (and ${errors.length - 10} more)` : ''}`);
  if (!input.reason.trim()) throw new DomainError('invalid', 'Give a reason for the import; it is kept in each customer\'s points history.');
  return db.transaction().execute(async tx => {
    const found = await tx.selectFrom('customers').select(['id', 'email']).where(sql<string>`lower(email)`, 'in', rows.map(r => r.email)).execute();
    const byEmail = new Map(found.map(c => [c.email.toLowerCase(), c.id]));
    const missing = rows.filter(r => !byEmail.has(r.email));
    if (missing.length) throw new DomainError('invalid', `Nothing was imported. No customer account for: ${missing.slice(0, 10).map(r => `${r.email} (line ${r.line})`).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}.`);
    const s = await readLoyaltySettings(tx);
    for (const r of rows) {
      const customerId = byEmail.get(r.email)!;
      await lockLoyaltyAccount(tx, customerId);
      await addPoints(tx, { customerId, points: r.points, kind: 'import', reason: r.reason ?? input.reason.trim(), staffId: actor.staffId }, s.expiryMonths);
    }
    const total = rows.reduce((n, r) => n + r.points, 0);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'loyalty.import', entityType: 'loyalty_transactions',
      after: { customers: rows.length, points: total }, metadata: { reason: input.reason.trim() }, ...auditCtx(ctx) });
    return { customers: rows.length, points: total };
  });
}

/** Expires unused points whose time has passed (job). Each customer's balance row is locked while their points expire. */
export async function expireLoyaltyPoints(db: Db, opts: { limit?: number } = {}): Promise<{ customers: number; points: number }> {
  const due = await db.selectFrom('loyalty_transactions').select('customer_id').distinct().where('remaining', '>', 0)
    .where('expires_at', '<=', sql<Date>`now()`).limit(opts.limit ?? 500).execute();
  let points = 0;
  for (const { customer_id } of due) {
    points += await db.transaction().execute(async tx => {
      await lockLoyaltyAccount(tx, customer_id);
      const rows = await tx.selectFrom('loyalty_transactions').select(['id', 'remaining']).where('customer_id', '=', customer_id).where('remaining', '>', 0)
        .where('expires_at', '<=', sql<Date>`now()`).forUpdate().execute();
      const n = rows.reduce((t, r) => t + (r.remaining ?? 0), 0);
      if (!n) return 0;
      for (const r of rows) await tx.updateTable('loyalty_transactions').set({ remaining: 0 }).where('id', '=', r.id).execute();
      await tx.insertInto('loyalty_transactions').values({ customer_id, points: -n, kind: 'expire', reason: 'Points expired' }).execute();
      await tx.updateTable('loyalty_accounts').set({ balance: sql<number>`balance - ${n}`, updated_at: sql<Date>`now()` }).where('customer_id', '=', customer_id).execute();
      return n;
    });
  }
  return { customers: due.length, points };
}

// ---------------------------------------------------------------- reading

export const LOYALTY_KIND_LABELS: Record<string, string> = {
  earn: 'Earned', redeem: 'Used on an order', adjust: 'Adjusted by staff', import: 'Imported', restore: 'Given back (order cancelled)',
  reverse: 'Taken back (order cancelled)', expire: 'Expired',
};

const history = (q: Queryable, customerId: string, limit: number) =>
  q.selectFrom('loyalty_transactions as t').leftJoin('orders as o', 'o.id', 't.order_id')
    .select(['t.id', 't.points', 't.kind', 't.reason', 't.created_at', 't.expires_at', 't.remaining', 't.staff_id', 'o.id as order_id', 'o.order_number'])
    .where('t.customer_id', '=', customerId).orderBy('t.created_at', 'desc').orderBy('t.id').limit(limit).execute();

/** The customer's own points (account page). */
export async function getMyLoyalty(db: Db, p: CustomerPrincipal) {
  const [s, balance, rows] = await Promise.all([readLoyaltySettings(db), loyaltyBalance(db, p.customerId), history(db, p.customerId, 50)]);
  const soon = await db.selectFrom('loyalty_transactions').select([sql<number>`coalesce(sum(remaining), 0)::int`.as('n'), sql<Date | null>`min(expires_at)`.as('at')])
    .where('customer_id', '=', p.customerId).where('remaining', '>', 0).where('expires_at', 'is not', null).where('expires_at', '>', sql<Date>`now()`)
    .where('expires_at', '<=', sql<Date>`now() + interval '30 days'`).executeTakeFirst();
  return { settings: s, balance, rows: rows.map(({ staff_id: _, ...r }) => r), expiringSoon: soon?.n ? { points: soon.n, at: soon.at } : null };
}

/** Staff: one customer's balance and history (customer page). */
export async function getCustomerLoyalty(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'loyalty.read');
  const [balance, rows] = await Promise.all([loyaltyBalance(db, customerId), history(db, customerId, 100)]);
  const ids = [...new Set(rows.map(r => r.staff_id).filter((x): x is string => !!x))];
  const staff = new Map(ids.length ? (await db.selectFrom('staff_users').select(['id', 'email']).where('id', 'in', ids).execute()).map(s => [s.id, s.email]) : []);
  return { balance, rows: rows.map(r => ({ ...r, staff_email: r.staff_id ? staff.get(r.staff_id) ?? null : null })) };
}

/** Staff: customers with points (Loyalty page), biggest balances first, and the latest point changes. */
export async function listLoyaltyAccounts(db: Db, actor: StaffPrincipal, query: { q?: string; page: number }) {
  requirePermission(actor, 'loyalty.read');
  let q = db.selectFrom('loyalty_accounts as a').innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['c.id', 'c.email', 'c.full_name', 'a.balance', 'a.updated_at']).where('a.balance', '>', 0);
  if (query.q) q = q.where(eb => eb.or([eb('c.email', 'ilike', `%${query.q}%`), eb('c.full_name', 'ilike', `%${query.q}%`)]));
  const rows = await q.orderBy('a.balance', 'desc').orderBy('c.email').limit(51).offset((query.page - 1) * 50).execute();
  const totals = await db.selectFrom('loyalty_accounts').select([sql<number>`coalesce(sum(balance), 0)::int`.as('points'), sql<number>`count(*) filter (where balance > 0)::int`.as('customers')]).executeTakeFirstOrThrow();
  const recent = await db.selectFrom('loyalty_transactions as t').innerJoin('customers as c', 'c.id', 't.customer_id').leftJoin('orders as o', 'o.id', 't.order_id')
    .select(['t.id', 't.points', 't.kind', 't.reason', 't.created_at', 'c.id as customer_id', 'c.email', 'o.id as order_id', 'o.order_number'])
    .orderBy('t.created_at', 'desc').orderBy('t.id').limit(30).execute();
  return { rows: rows.slice(0, 50), hasNext: rows.length > 50, totals, recent, settings: await readLoyaltySettings(db) };
}
