/* Store credit (2026-10-13): money the shop owes a customer, to be spent on a later purchase. It is NOT loyalty points
   (earned by buying) and NOT a credit bill (money the customer owes the shop).
   - One balance row per customer (store_credit_accounts) and a ledger of every movement (store_credit_entries). Both are
     written in the same transaction; the balance row is locked first, so two tills cannot spend the same rupee and the
     balance can never go below zero. balance = sum(entries) at all times (storeCreditReconciliation checks it).
   - It never expires: there is no expiry field and no job.
   - Every movement names its source (a return, the sale it was spent on, or a staff adjustment with a reason), who made it
     and an idempotency key: the same request sent twice is one movement.
   - Nothing is ever edited or deleted: a mistake is corrected with a compensating entry that points at the wrong one. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { StoreCreditKind } from '@kitsyuu/db';
import type { MutationContext } from './staff.ts';

const auditCtx = (c: MutationContext) => ({ ip: c.ip ?? null, userAgent: c.userAgent ?? null, requestId: c.requestId ?? null });
const inr = (paise: number) => `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const STORE_CREDIT_KIND_LABELS: Record<StoreCreditKind, string> = { return: 'From a return / exchange', adjustment: 'Staff adjustment', redeem: 'Spent on a purchase', reversal: 'Reversal' };

export async function storeCreditBalance(q: Queryable, customerId: string): Promise<number> {
  return (await q.selectFrom('store_credit_accounts').select('balance_paise').where('customer_id', '=', customerId).executeTakeFirst())?.balance_paise ?? 0;
}

export interface StoreCreditMove {
  customerId: string; amountPaise: number; kind: StoreCreditKind; reason: string; key: string;
  orderId?: string | null; returnId?: string | null; reversesId?: string | null; staffId: string | null;
}
/** One ledger movement, inside the caller's transaction. Locks the customer's balance row; refuses to go below zero.
    The same key again returns the first movement (and refuses if it was for something else). */
export async function moveStoreCredit(tx: Tx, m: StoreCreditMove): Promise<{ entryId: string; balancePaise: number; replay: boolean }> {
  if (!Number.isInteger(m.amountPaise) || m.amountPaise === 0) throw new DomainError('invalid', 'Enter an amount other than ₹0.');
  if (!/^[A-Za-z0-9:/_-]{8,120}$/.test(m.key)) throw new DomainError('invalid', 'Missing request key: reload the page and try again.');
  const reason = m.reason.trim().slice(0, 300);
  if (reason.length < 3) throw new DomainError('invalid', 'Enter the reason.');
  // The balance row is created if needed and then locked: every movement of one customer waits here for the one before it.
  await tx.insertInto('store_credit_accounts').values({ customer_id: m.customerId }).onConflict(oc => oc.column('customer_id').doNothing()).execute();
  const acct = await tx.selectFrom('store_credit_accounts').select('balance_paise').where('customer_id', '=', m.customerId).forUpdate().executeTakeFirstOrThrow();
  const prior = await tx.selectFrom('store_credit_entries').select(['id', 'customer_id', 'amount_paise', 'kind']).where('idempotency_key', '=', m.key).executeTakeFirst();
  if (prior) {
    if (prior.customer_id !== m.customerId || prior.amount_paise !== m.amountPaise || prior.kind !== m.kind) throw new ConflictError('This request was already used for a different store-credit movement.');
    return { entryId: prior.id, balancePaise: acct.balance_paise, replay: true };
  }
  const next = acct.balance_paise + m.amountPaise;
  if (next < 0) throw new ConflictError(`Only ${inr(acct.balance_paise)} of store credit is available.`);
  await tx.updateTable('store_credit_accounts').set({ balance_paise: next, updated_at: sql<Date>`now()` }).where('customer_id', '=', m.customerId).execute();
  const e = await tx.insertInto('store_credit_entries').values({ customer_id: m.customerId, amount_paise: m.amountPaise, balance_after: next, kind: m.kind,
    order_id: m.orderId ?? null, return_id: m.returnId ?? null, reverses_id: m.reversesId ?? null, staff_id: m.staffId, reason, idempotency_key: m.key }).returning('id').executeTakeFirstOrThrow();
  return { entryId: e.id, balancePaise: next, replay: false };
}

/** Staff add or remove store credit by hand (store_credit.adjust): a goodwill credit, or a correction. Signed amount in paise. */
export async function adjustStoreCredit(db: Db, actor: StaffPrincipal, input: { customerId: string; amountPaise: number; reason: string; key: string }, ctx: MutationContext) {
  // A refused attempt to change a balance by hand is itself written to the audit log.
  if (!can(actor, 'store_credit.adjust')) {
    await recordAudit(db, { actorType: 'staff', staffId: actor.staffId, action: 'store_credit.adjust_denied', entityType: 'customers', entityId: input.customerId, metadata: { amount_paise: input.amountPaise, reason: String(input.reason ?? '').slice(0, 300) }, ...auditCtx(ctx) });
    requirePermission(actor, 'store_credit.adjust');
  }
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('customers').select(['id', 'email']).where('id', '=', input.customerId).executeTakeFirst();
    if (!c) throw new NotFoundError('Customer not found.');
    const before = await storeCreditBalance(tx, c.id);
    const r = await moveStoreCredit(tx, { customerId: c.id, amountPaise: input.amountPaise, kind: 'adjustment', reason: input.reason, key: `adj:${input.key}`, staffId: actor.staffId });
    if (!r.replay) await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'store_credit.adjust', entityType: 'customers', entityId: c.id,
      before: { balance_paise: before }, after: { balance_paise: r.balancePaise }, metadata: { amount_paise: input.amountPaise, reason: input.reason.trim(), entry_id: r.entryId }, ...auditCtx(ctx) });
    return r;
  });
}

/** Undo one ledger entry with a compensating entry (store_credit.adjust). The original stays; each entry is reversed at most once. */
export async function reverseStoreCreditEntry(db: Db, actor: StaffPrincipal, input: { entryId: string; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'store_credit.adjust');
  return db.transaction().execute(async tx => {
    const e = await tx.selectFrom('store_credit_entries').select(['id', 'customer_id', 'amount_paise', 'kind', 'order_id', 'return_id']).where('id', '=', input.entryId).executeTakeFirst();
    if (!e) throw new NotFoundError('Store-credit entry not found.');
    if (e.kind === 'reversal') throw new ConflictError('A reversal cannot itself be reversed: make an adjustment instead.');
    const done = await tx.selectFrom('store_credit_entries').select('id').where('reverses_id', '=', e.id).executeTakeFirst();
    if (done) throw new ConflictError('This entry was already reversed.');
    const r = await moveStoreCredit(tx, { customerId: e.customer_id, amountPaise: -e.amount_paise, kind: 'reversal', reason: input.reason, key: `rev:${e.id}`, reversesId: e.id,
      orderId: e.order_id, returnId: e.return_id, staffId: actor.staffId });
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'store_credit.reverse', entityType: 'customers', entityId: e.customer_id,
      after: { balance_paise: r.balancePaise }, metadata: { reversed_entry_id: e.id, amount_paise: -e.amount_paise, reason: input.reason.trim(), entry_id: r.entryId }, ...auditCtx(ctx) });
    return r;
  });
}

/** A customer's store credit for staff: the balance and the latest movements. */
export async function getStoreCredit(db: Db, actor: StaffPrincipal, customerId: string, limit = 30) {
  if (!can(actor, 'pos.access')) requirePermission(actor, 'customers.read');
  const [balancePaise, entries] = await Promise.all([storeCreditBalance(db, customerId),
    db.selectFrom('store_credit_entries as e').leftJoin('staff_users as s', 's.id', 'e.staff_id').leftJoin('orders as o', 'o.id', 'e.order_id').leftJoin('return_requests as r', 'r.id', 'e.return_id')
      .select(['e.id', 'e.amount_paise', 'e.balance_after', 'e.kind', 'e.reason', 'e.created_at', 'e.reverses_id', 's.email as staff_email', 'o.order_number', 'o.pos_number', 'o.id as order_id', 'r.number as return_number', 'r.id as return_id'])
      .where('e.customer_id', '=', customerId).orderBy('e.created_at', 'desc').orderBy('e.id').limit(Math.min(Math.max(limit, 1), 100)).execute()]);
  return { balancePaise, entries };
}

/** Store-credit liability (pos.reports): what the shop owes in total, who holds it, and the movements of a period by kind. */
export async function storeCreditReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'pos.reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.from > range.to) throw new DomainError('invalid', 'Choose a valid date range.');
  const [holders, moves, check] = await Promise.all([
    db.selectFrom('store_credit_accounts as a').innerJoin('customers as c', 'c.id', 'a.customer_id').select(['c.id', 'c.email', 'c.full_name', 'a.balance_paise', 'a.updated_at'])
      .where('a.balance_paise', '>', 0).orderBy('a.balance_paise', 'desc').limit(200).execute(),
    db.selectFrom('store_credit_entries').select(['kind', sql<number>`count(*)::int`.as('count'), sql<number>`coalesce(sum(amount_paise) filter (where amount_paise > 0), 0)::int`.as('issued'),
      sql<number>`coalesce(-sum(amount_paise) filter (where amount_paise < 0), 0)::int`.as('taken')])
      .where(sql<boolean>`(created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`).groupBy('kind').execute(),
    storeCreditReconciliation(db),
  ]);
  return { range, liabilityPaise: check.balancesPaise, holders, moves, reconciled: check.ok, ledgerPaise: check.ledgerPaise };
}

/** The balances and the ledger must agree, customer by customer. */
export async function storeCreditReconciliation(q: Queryable) {
  const r = await sql<{ balances: number; ledger: number; mismatched: number }>`
    select coalesce((select sum(balance_paise) from public.store_credit_accounts), 0)::int as balances,
           coalesce((select sum(amount_paise) from public.store_credit_entries), 0)::int as ledger,
           (select count(*) from public.store_credit_accounts a where a.balance_paise <> coalesce((select sum(e.amount_paise) from public.store_credit_entries e where e.customer_id = a.customer_id), 0))::int as mismatched`.execute(q);
  const row = r.rows[0]!;
  return { balancesPaise: row.balances, ledgerPaise: row.ledger, mismatched: row.mismatched, ok: row.balances === row.ledger && row.mismatched === 0 };
}
