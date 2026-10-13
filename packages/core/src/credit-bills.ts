/* Credit bills (2026-10-13): a sale the customer pays later. This is money owed TO the shop (a receivable); it is the
   opposite of store credit and is never mixed with it.
   - Nobody has credit by default. An administrator approves a credit account for one customer: a limit, a due period in
     days, active or not (credit.manage).
   - A credit sale needs an active account and room under the limit, checked while the account row is locked, so two
     tills cannot go over the limit together. The bill keeps the terms as they were at the sale; changing the account
     later never changes a bill already made.
   - A repayment is a real payment (cash, card or UPI) recorded once against one bill; the amount owed can never go below
     zero. Only when the whole bill is repaid is the order marked paid.
   - No write-off, no automatic reminders, no automatic limit changes. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { earnForOrder } from './loyalty.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (c: MutationContext) => ({ ip: c.ip ?? null, userAgent: c.userAgent ?? null, requestId: c.requestId ?? null });
const inr = (paise: number) => `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const CREDIT_REPAY_METHODS = ['cash', 'card', 'upi'] as const;
export type CreditRepayMethod = typeof CREDIT_REPAY_METHODS[number];

/** Approve a credit account for a customer, or change its terms (credit.manage). Existing bills are not touched. */
export async function setCreditAccount(db: Db, actor: StaffPrincipal, input: { customerId: string; limitPaise: number; dueDays: number; active: boolean; note: string | null }, ctx: MutationContext) {
  if (!can(actor, 'credit.manage')) {
    await recordAudit(db, { actorType: 'staff', staffId: actor.staffId, action: 'credit.account_denied', entityType: 'customers', entityId: input.customerId, metadata: { limit_paise: input.limitPaise, due_days: input.dueDays }, ...auditCtx(ctx) });
    requirePermission(actor, 'credit.manage');
  }
  if (!Number.isInteger(input.limitPaise) || input.limitPaise <= 0) throw new DomainError('invalid', 'Enter a credit limit above ₹0.');
  if (!Number.isInteger(input.dueDays) || input.dueDays < 1 || input.dueDays > 365) throw new DomainError('invalid', 'Enter the due period in days (1 to 365).');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('customers').select(['id', 'status']).where('id', '=', input.customerId).executeTakeFirst();
    if (!c) throw new NotFoundError('Customer not found.');
    const before = await tx.selectFrom('credit_accounts').select(['limit_paise', 'due_days', 'status', 'outstanding_paise']).where('customer_id', '=', c.id).forUpdate().executeTakeFirst();
    const status = input.active ? 'active' as const : 'inactive' as const, note = input.note?.trim().slice(0, 500) || null;
    if (before) await tx.updateTable('credit_accounts').set({ limit_paise: input.limitPaise, due_days: input.dueDays, status, note, approved_by: actor.staffId, approved_at: sql<Date>`now()`, updated_at: sql<Date>`now()` }).where('customer_id', '=', c.id).execute();
    else await tx.insertInto('credit_accounts').values({ customer_id: c.id, limit_paise: input.limitPaise, due_days: input.dueDays, status, note, approved_by: actor.staffId }).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: before ? 'credit.account_update' : 'credit.account_approve', entityType: 'customers', entityId: c.id,
      before: before ? { limit_paise: before.limit_paise, due_days: before.due_days, status: before.status } : null,
      after: { limit_paise: input.limitPaise, due_days: input.dueDays, status }, metadata: { note, outstanding_paise: before?.outstanding_paise ?? 0 }, ...auditCtx(ctx) });
    return { created: !before };
  });
}

/** Inside a sale's transaction: puts `amountPaise` of this order on the customer's credit. Locks the account row. */
export async function openCreditBill(tx: Tx, actor: StaffPrincipal, input: { customerId: string; orderId: string; amountPaise: number }) {
  requirePermission(actor, 'pos.credit_sell');
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new DomainError('invalid', 'The amount on credit must be above ₹0.');
  const a = await tx.selectFrom('credit_accounts').select(['limit_paise', 'due_days', 'status', 'outstanding_paise']).where('customer_id', '=', input.customerId).forUpdate().executeTakeFirst();
  if (!a) throw new ForbiddenError('This customer has no approved credit account: take payment now, or ask an administrator to approve credit for them.');
  if (a.status !== 'active') throw new ForbiddenError('This customer’s credit account is switched off: take payment now.');
  const room = a.limit_paise - a.outstanding_paise;
  if (input.amountPaise > room) throw new ConflictError(`Over the credit limit: ${inr(Math.max(0, room))} of ${inr(a.limit_paise)} is available (${inr(a.outstanding_paise)} is already owed).`);
  const due = (await sql<{ d: string }>`select ((now() at time zone 'Asia/Kolkata')::date + ${a.due_days}::int)::text as d`.execute(tx)).rows[0]!.d;
  const b = await tx.insertInto('credit_bills').values({ order_id: input.orderId, customer_id: input.customerId, amount_paise: input.amountPaise, outstanding_paise: input.amountPaise,
    limit_paise_at_sale: a.limit_paise, due_days_at_sale: a.due_days, due_on: due, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
  await tx.updateTable('credit_accounts').set({ outstanding_paise: a.outstanding_paise + input.amountPaise, updated_at: sql<Date>`now()` }).where('customer_id', '=', input.customerId).execute();
  return { billId: b.id, dueOn: due, outstandingPaise: a.outstanding_paise + input.amountPaise };
}

/** Inside a void's transaction: a credit bill with no repayment yet is cancelled and the customer's debt is reduced. */
export async function cancelCreditBillForVoid(tx: Tx, orderId: string): Promise<number> {
  const seen = await tx.selectFrom('credit_bills').select(['id', 'customer_id']).where('order_id', '=', orderId).executeTakeFirst();
  if (!seen) return 0;
  await tx.selectFrom('credit_accounts').select('customer_id').where('customer_id', '=', seen.customer_id).forUpdate().executeTakeFirst();
  const b = await tx.selectFrom('credit_bills').select(['id', 'customer_id', 'amount_paise', 'outstanding_paise', 'status']).where('id', '=', seen.id).forUpdate().executeTakeFirstOrThrow();
  if (b.status === 'cancelled') return 0;
  if (b.outstanding_paise !== b.amount_paise) throw new ConflictError('Part of this credit bill has been repaid: it cannot be voided. Use Returns & refunds for this sale.');
  await tx.updateTable('credit_bills').set({ outstanding_paise: 0, status: 'cancelled', closed_at: sql<Date>`now()` }).where('id', '=', b.id).execute();
  await tx.updateTable('credit_accounts').set({ outstanding_paise: sql<number>`outstanding_paise - ${b.amount_paise}`, updated_at: sql<Date>`now()` }).where('customer_id', '=', b.customer_id).execute();
  return b.amount_paise;
}

/** Record a repayment against one credit bill (credit.repay). At a till, pass the cashier's open session: cash goes into that drawer. */
export async function repayCreditBill(db: Db, actor: StaffPrincipal,
  input: { billId: string; amountPaise: number; method: CreditRepayMethod; reference: string | null; sessionId?: string | null; key: string }, ctx: MutationContext) {
  requirePermission(actor, 'credit.repay');
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new DomainError('invalid', 'Enter the amount received, above ₹0.');
  if (!(CREDIT_REPAY_METHODS as readonly string[]).includes(input.method)) throw new DomainError('invalid', 'Choose how it was paid: cash, card or UPI.');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.key ?? '')) throw new DomainError('invalid', 'Missing request key: reload the page and try again.');
  const reference = input.reference?.trim() || null;
  if (input.method !== 'cash' && (!reference || !/^[A-Za-z0-9 /_-]{4,64}$/.test(reference))) throw new DomainError('invalid', 'Enter the transaction reference shown when the payment succeeded.');
  const key = `crp:${input.key}`;
  return db.transaction().execute(async tx => {
    const seen = await tx.selectFrom('credit_bills').select(['id', 'customer_id']).where('id', '=', input.billId).executeTakeFirst();
    if (!seen) throw new NotFoundError('Credit bill not found.');
    // Account first, then the bill: the same order a credit sale takes its locks in.
    await tx.selectFrom('credit_accounts').select('customer_id').where('customer_id', '=', seen.customer_id).forUpdate().executeTakeFirst();
    const b = await tx.selectFrom('credit_bills as b').innerJoin('orders as o', 'o.id', 'b.order_id')
      .select(['b.id', 'b.order_id', 'b.customer_id', 'b.amount_paise', 'b.outstanding_paise', 'b.status', 'o.order_number', 'o.pos_number']).where('b.id', '=', seen.id).forUpdate('b').executeTakeFirstOrThrow();
    const prior = await tx.selectFrom('credit_repayments').select(['id', 'bill_id', 'number', 'amount_paise', 'method', 'outstanding_after']).where('idempotency_key', '=', key).executeTakeFirst();
    if (prior) {
      if (prior.bill_id !== b.id || prior.amount_paise !== input.amountPaise || prior.method !== input.method) throw new ConflictError('This request was already used for a different repayment.');
      return { repaymentId: prior.id, number: prior.number, outstandingPaise: prior.outstanding_after, paidOff: prior.outstanding_after === 0, replay: true };
    }
    if (b.status !== 'open') throw new ConflictError(b.status === 'paid' ? 'This credit bill is already fully repaid.' : 'This credit bill was cancelled.');
    if (input.amountPaise > b.outstanding_paise) throw new ConflictError(`Only ${inr(b.outstanding_paise)} is owed on this bill: enter that or less.`);
    if (input.sessionId) {
      const s = await tx.selectFrom('pos_sessions').select(['id', 'staff_id', 'status']).where('id', '=', input.sessionId).forUpdate().executeTakeFirst();
      if (!s || s.staff_id !== actor.staffId || s.status !== 'open') throw new ConflictError('Your cashier session is not open: open a session, or record the repayment without a till.');
    }
    const number = (await sql<{ n: string }>`select public.next_document_number('credit_repayment', 'CRP') as n`.execute(tx)).rows[0]!.n;
    const left = b.outstanding_paise - input.amountPaise;
    // A real payment row on the order (its own provider name, so POS sale totals never count a repayment as a new sale).
    const pay = await tx.insertInto('payments').values({ order_id: b.order_id, provider: 'pos_credit', provider_order_id: b.pos_number ?? b.order_number, provider_payment_id: number,
      amount_paise: input.amountPaise, currency: 'INR', status: 'captured', method: input.method, captured_at: sql<Date>`now()`,
      raw: JSON.stringify({ repayment: number, reference, cashier_id: actor.staffId, session_id: input.sessionId ?? null }) }).returning('id').executeTakeFirstOrThrow();
    const r = await tx.insertInto('credit_repayments').values({ bill_id: b.id, number, amount_paise: input.amountPaise, method: input.method, reference, payment_id: pay.id,
      pos_session_id: input.sessionId ?? null, staff_id: actor.staffId, outstanding_after: left, idempotency_key: key }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('credit_bills').set(left === 0 ? { outstanding_paise: 0, status: 'paid', closed_at: sql<Date>`now()` } : { outstanding_paise: left }).where('id', '=', b.id).execute();
    await tx.updateTable('credit_accounts').set({ outstanding_paise: sql<number>`outstanding_paise - ${input.amountPaise}`, updated_at: sql<Date>`now()` }).where('customer_id', '=', b.customer_id).execute();
    if (left === 0) {
      await tx.updateTable('orders').set({ payment_status: 'paid', paid_at: sql<Date>`now()` }).where('id', '=', b.order_id).execute();
      // Points are earned on money actually received: a credit sale earns once it is fully repaid.
      await earnForOrder(tx, b.order_id, 'paid'); await earnForOrder(tx, b.order_id, 'delivered');
    }
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'credit.repayment', entityType: 'orders', entityId: b.order_id,
      before: { outstanding_paise: b.outstanding_paise }, after: { outstanding_paise: left, status: left === 0 ? 'paid' : 'open' },
      metadata: { number, bill_id: b.id, amount_paise: input.amountPaise, method: input.method, reference, session_id: input.sessionId ?? null }, ...auditCtx(ctx) });
    return { repaymentId: r.id, number, outstandingPaise: left, paidOff: left === 0, replay: false };
  });
}

/** A customer's credit position for staff: the account (if any), what is owed, and the bills. */
export async function getCustomerCredit(db: Db, actor: StaffPrincipal, customerId: string) {
  if (!can(actor, 'pos.access')) requirePermission(actor, 'customers.read');
  const [account, bills] = await Promise.all([
    db.selectFrom('credit_accounts as a').leftJoin('staff_users as s', 's.id', 'a.approved_by')
      .select(['a.limit_paise', 'a.due_days', 'a.status', 'a.outstanding_paise', 'a.approved_at', 'a.note', 's.email as approved_by_email']).where('a.customer_id', '=', customerId).executeTakeFirst(),
    db.selectFrom('credit_bills as b').innerJoin('orders as o', 'o.id', 'b.order_id')
      .select(['b.id', 'b.order_id', 'o.order_number', 'o.pos_number', 'b.amount_paise', 'b.outstanding_paise', 'b.due_on', 'b.status', 'b.created_at', sql<boolean>`b.status = 'open' and b.due_on < (now() at time zone 'Asia/Kolkata')::date`.as('overdue')])
      .where('b.customer_id', '=', customerId).orderBy('b.created_at', 'desc').limit(50).execute(),
  ]);
  return { account: account ?? null, bills, availablePaise: account && account.status === 'active' ? Math.max(0, account.limit_paise - account.outstanding_paise) : 0 };
}

/** One credit bill with its repayments (the repayment screen and its receipt). */
export async function getCreditBill(db: Db, actor: StaffPrincipal, billId: string) {
  if (!can(actor, 'credit.repay') && !can(actor, 'pos.reports')) requirePermission(actor, 'pos.access');
  const bill = await db.selectFrom('credit_bills as b').innerJoin('orders as o', 'o.id', 'b.order_id').innerJoin('customers as c', 'c.id', 'b.customer_id')
    .select(['b.id', 'b.order_id', 'b.customer_id', 'o.order_number', 'o.pos_number', 'o.total_paise', 'b.amount_paise', 'b.outstanding_paise', 'b.due_on', 'b.status', 'b.created_at', 'b.due_days_at_sale', 'b.limit_paise_at_sale',
      'c.full_name', 'c.email', 'c.phone', sql<boolean>`b.status = 'open' and b.due_on < (now() at time zone 'Asia/Kolkata')::date`.as('overdue')])
    .where('b.id', '=', billId).executeTakeFirst();
  if (!bill) throw new NotFoundError('Credit bill not found.');
  const repayments = await db.selectFrom('credit_repayments as r').leftJoin('staff_users as s', 's.id', 'r.staff_id')
    .select(['r.id', 'r.number', 'r.amount_paise', 'r.method', 'r.reference', 'r.outstanding_after', 'r.created_at', 's.email as staff_email']).where('r.bill_id', '=', billId).orderBy('r.created_at').execute();
  return { bill, repayments };
}

/** Receivables (pos.reports): open bills, overdue ones, what was repaid in a period, and a check that the totals agree. */
export async function creditReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'pos.reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.from > range.to) throw new DomainError('invalid', 'Choose a valid date range.');
  const inRange = (col: string) => sql<boolean>`(${sql.ref(col)} at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`;
  const [open, sold, repaid, check] = await Promise.all([
    db.selectFrom('credit_bills as b').innerJoin('orders as o', 'o.id', 'b.order_id').innerJoin('customers as c', 'c.id', 'b.customer_id')
      .select(['b.id', 'o.order_number', 'o.pos_number', 'c.id as customer_id', 'c.full_name', 'c.email', 'c.phone', 'b.amount_paise', 'b.outstanding_paise', 'b.due_on', 'b.created_at',
        sql<boolean>`b.due_on < (now() at time zone 'Asia/Kolkata')::date`.as('overdue')])
      .where('b.status', '=', 'open').orderBy('b.due_on').limit(500).execute(),
    db.selectFrom('credit_bills as b').select([sql<number>`count(*)::int`.as('count'), sql<number>`coalesce(sum(b.amount_paise), 0)::int`.as('amount')]).where('b.status', '!=', 'cancelled').where(inRange('b.created_at')).executeTakeFirstOrThrow(),
    db.selectFrom('credit_repayments as r').select(['r.method', sql<number>`count(*)::int`.as('count'), sql<number>`coalesce(sum(r.amount_paise), 0)::int`.as('amount')]).where(inRange('r.created_at')).groupBy('r.method').execute(),
    creditReconciliation(db),
  ]);
  return { range, outstandingPaise: open.reduce((n, b) => n + b.outstanding_paise, 0), overduePaise: open.filter(b => b.overdue).reduce((n, b) => n + b.outstanding_paise, 0),
    open, overdue: open.filter(b => b.overdue), soldOnCredit: sold, repaid, repaidPaise: repaid.reduce((n, r) => n + r.amount, 0), reconciled: check.ok };
}

/** What is owed must agree three ways: the accounts, the open bills, and bills minus repayments. */
export async function creditReconciliation(q: Queryable) {
  const r = await sql<{ accounts: number; bills: number; mismatched: number; bad_bills: number }>`
    select coalesce((select sum(outstanding_paise) from public.credit_accounts), 0)::int as accounts,
           coalesce((select sum(outstanding_paise) from public.credit_bills where status = 'open'), 0)::int as bills,
           (select count(*) from public.credit_accounts a where a.outstanding_paise <> coalesce((select sum(b.outstanding_paise) from public.credit_bills b where b.customer_id = a.customer_id and b.status = 'open'), 0))::int as mismatched,
           (select count(*) from public.credit_bills b where b.status <> 'cancelled' and b.outstanding_paise <> b.amount_paise - coalesce((select sum(p.amount_paise) from public.credit_repayments p where p.bill_id = b.id), 0))::int as bad_bills`.execute(q);
  const row = r.rows[0]!;
  return { accountsPaise: row.accounts, billsPaise: row.bills, mismatched: row.mismatched, badBills: row.bad_bills, ok: row.accounts === row.bills && row.mismatched === 0 && row.bad_bills === 0 };
}
