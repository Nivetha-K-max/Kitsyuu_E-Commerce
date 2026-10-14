/* POS (point of sale) billing at a branch (2026-10-02).

   Built on the existing commerce engine, not beside it:
   - a POS sale is an order in `orders` with channel 'retail' (offline) at the cashier session's branch, priced by the same
     priceOrder() (tax from Finance → Tax as at checkout; nothing is delivered so no delivery charge), with the same staff
     discount rules as draft orders (a % never above Configuration → Discounts "Maximum staff discount", never below a product's
     minimum price, a reason, permission orders.discount), the same stock ledger (sell_order_at_location: the branch's own
     stock, reason retail_sale, never below zero) and the same audit log;
   - the order carries its POS bill number (pos_number) and cashier session (pos_session_id);
   - the payment is recorded in `payments` (provider 'pos', method cash / card / upi, status captured) so the existing
     returns / refunds workflow can refund it like any other payment;
   - cashier sessions: open (opening cash) → sales → close (cash counted; expected cash and the variance are recorded).
   Payment state: there is no card terminal or UPI integration. A sale is completed only when the cashier confirms the
   payment: cash needs the amount received (≥ the total; the change is worked out), card / UPI need the transaction
   reference shown by the terminal / UPI app. Nothing is recorded as paid without that confirmation. */
import { createHash } from 'node:crypto';
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError, MAX_QTY_PER_LINE } from '@kitsyuu/contracts';
import { can, locationScope, requireLocation, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { priceOrder, type CartTotals } from './pricing.ts';
import { lineLabel, pricedLine, variantQuery, type PricedLine } from './cart.ts';
import { checkStaffDiscount, inStore, staffDiscountMaxBp, staffRule } from './draft-orders.ts';
import { earnForOrder, lockLoyaltyAccount, redeemForOrder, reverseOrderPoints } from './loyalty.ts';
import { counterDiscounts, couponCodeOf, recordDiscountRedemptions } from './discounts.ts';
import { billFromTotals } from './bill.ts';
import { markPaymentRefunded } from './returns.ts';
import { moveStoreCredit, storeCreditBalance } from './store-credit.ts';
import { cancelCreditBillForVoid, getCustomerCredit, openCreditBill } from './credit-bills.ts';
import { loyaltyBalance } from './loyalty.ts';
import type { MutationContext } from './staff.ts';

export const POS_PAYMENT_METHODS = ['cash', 'card', 'upi'] as const;
export type PosPaymentMethod = typeof POS_PAYMENT_METHODS[number];
const METHOD_LABEL: Record<PosPaymentMethod, string> = { cash: 'Cash', card: 'Card', upi: 'UPI' };
/* 2026-10-13: one bill may be settled by several tenders. cash / card / upi are money received now; store_credit spends the
   customer's store-credit balance (the shop already owed it: not money received); credit puts the amount on a credit bill
   (nothing received yet). 'exchange' is set by the exchange workflow only: the value of the goods handed back. */
export const POS_TENDER_METHODS = ['cash', 'card', 'upi', 'store_credit', 'credit'] as const;
export type PosTenderMethod = typeof POS_TENDER_METHODS[number];
export type PosTender = { method: PosTenderMethod; amountPaise: number; reference?: string | null; tenderedPaise?: number | null };
export const TENDER_LABEL: Record<PosTenderMethod | 'exchange', string> = { cash: 'Cash', card: 'Card', upi: 'UPI', store_credit: 'Store credit', credit: 'On credit', exchange: 'Exchange value' };
const REF_OK = /^[A-Za-z0-9 /_-]{4,64}$/;
const auditCtx = (c: MutationContext) => ({ ip: c.ip ?? null, userAgent: c.userAgent ?? null, requestId: c.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const inr = (paise: number) => `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- the counter: branches, session, limits
/** What the POS screen needs: the branches, the cashier's open session, the discount limit and what this staff member may do. */
export async function posContext(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'pos.access');
  // 2026-10-14: a staff member assigned to branches is offered only those branches.
  const scope = locationScope(actor);
  let branches = db.selectFrom('locations').select(['id', 'code', 'name', 'address']).where('is_online', '=', false).where('is_active', '=', true).orderBy('sort_order').orderBy('name');
  let others = db.selectFrom('locations').select(['id', 'code', 'name', 'is_online', 'is_active']).where(eb => eb.or([eb('is_online', '=', true), eb('is_active', '=', false)])).orderBy('sort_order').orderBy('name');
  if (scope) { branches = branches.where('id', 'in', scope); others = others.where('id', 'in', scope); }
  const [locations, session, maxDiscountBp, otherLocations] = await Promise.all([
    branches.execute(),
    openSessionOf(db, actor.staffId),
    staffDiscountMaxBp(db),
    // Locations POS cannot bill at, so the screen can say why they are not in the list (the online stock; switched off).
    others.execute(),
  ]);
  return { locations, otherLocations, session, maxDiscountBp, methods: POS_PAYMENT_METHODS.map(m => ({ code: m, label: METHOD_LABEL[m] })),
    can: { sell: can(actor, 'pos.sell'), discount: can(actor, 'orders.discount'), void: can(actor, 'pos.void'), reports: can(actor, 'pos.reports'), invoice: can(actor, 'finance.manage') } };
}

async function openSessionOf(q: Queryable, staffId: string) {
  return (await q.selectFrom('pos_sessions as s').innerJoin('locations as l', 'l.id', 's.location_id')
    .select(['s.id', 's.number', 's.location_id', 'l.name as location_name', 'l.code as location_code', 's.opening_cash_paise', 's.opened_at'])
    .where('s.staff_id', '=', staffId).where('s.status', '=', 'open').executeTakeFirst()) ?? null;
}

// ---------------------------------------------------------------- cashier sessions
export async function openPosSession(db: Db, actor: StaffPrincipal, input: { locationId: string; openingCashPaise: number }, ctx: MutationContext) {
  requirePermission(actor, 'pos.sell');
  if (!Number.isInteger(input.openingCashPaise) || input.openingCashPaise < 0 || input.openingCashPaise > 100_000_000) throw new DomainError('invalid', 'Enter the opening cash in the drawer (0 or more).');
  return db.transaction().execute(async tx => {
    const l = await tx.selectFrom('locations').select(['id', 'name', 'is_online', 'is_active']).where('id', '=', input.locationId).executeTakeFirst();
    if (!l) throw new NotFoundError('Branch not found.');
    requireLocation(actor, l.id);
    if (l.is_online) throw new DomainError('invalid', `${l.name} is the online stock, not a branch: choose the store you are billing at.`);
    if (!l.is_active) throw new ConflictError(`${l.name} is inactive.`);
    if (await openSessionOf(tx, actor.staffId)) throw new ConflictError('You already have an open session. Close it before opening another.');
    const number = (await sql<{ n: string }>`select public.next_document_number('pos_session', 'POSS') as n`.execute(tx)).rows[0].n;
    let row;
    try {
      row = await tx.insertInto('pos_sessions').values({ number, location_id: l.id, staff_id: actor.staffId, opening_cash_paise: input.openingCashPaise })
        .returning(['id', 'number']).executeTakeFirstOrThrow();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('You already have an open session. Close it before opening another.');
      throw e;
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.session_open', entityType: 'pos_sessions', entityId: row.id,
      after: { number, location_id: l.id, opening_cash_paise: input.openingCashPaise } });
    return row;
  });
}

/** Totals of a session: sales, payments by method, voids, and the cash that should be in the drawer. */
export async function posSessionSummary(q: Queryable, sessionId: string) {
  const s = await q.selectFrom('pos_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  if (!s) throw new NotFoundError('Session not found.');
  const sales = await q.selectFrom('orders as o').innerJoin('payments as p', join => join.onRef('p.order_id', '=', 'o.id').on('p.provider', '=', 'pos'))
    .select(['o.id', 'o.status', 'o.total_paise', 'o.discount_paise', 'p.method', 'p.amount_paise'])
    .where('o.pos_session_id', '=', sessionId).execute();
  // Money given back at the counter for this session's sales (voids; refunds of returns are reported separately).
  const voids = await q.selectFrom('refunds as r').innerJoin('orders as o', 'o.id', 'r.order_id').innerJoin('payments as p', 'p.id', 'r.payment_id')
    .select(['p.method', sql<number>`coalesce(sum(r.amount_paise), 0)::int`.as('n')])
    .where('o.pos_session_id', '=', sessionId).where('r.status', '=', 'processed').where('r.reference', 'like', 'VOID %').groupBy('p.method').execute();
  const byMethod: Record<PosPaymentMethod, { count: number; amountPaise: number; voidedPaise: number }> = { cash: { count: 0, amountPaise: 0, voidedPaise: 0 }, card: { count: 0, amountPaise: 0, voidedPaise: 0 }, upi: { count: 0, amountPaise: 0, voidedPaise: 0 } };
  for (const r of sales) { const m = byMethod[r.method as PosPaymentMethod]; if (m) { m.count++; m.amountPaise += r.amount_paise; } }
  for (const v of voids) { const m = byMethod[v.method as PosPaymentMethod]; if (m) m.voidedPaise += v.n; }
  // 2026-10-13: a bill with several tenders is still ONE bill (it used to be counted once per payment row). Money received is
  // the sum of the money tenders; store credit spent, amounts put on credit and credit repayments are reported on their own.
  const bills = await q.selectFrom('orders').select(['id', 'status', 'total_paise', 'discount_paise']).where('pos_session_id', '=', sessionId).execute();
  const valid = bills.filter(x => x.status !== 'cancelled');
  const other = await q.selectFrom('payments as p').innerJoin('orders as o', 'o.id', 'p.order_id').select(['p.provider', sql<number>`coalesce(sum(p.amount_paise), 0)::int`.as('n')])
    .where('o.pos_session_id', '=', sessionId).where('o.status', '!=', 'cancelled').where('p.provider', 'in', ['store_credit', 'exchange']).groupBy('p.provider').execute();
  const onCredit = await q.selectFrom('credit_bills as b').innerJoin('orders as o', 'o.id', 'b.order_id').select(sql<number>`coalesce(sum(b.amount_paise), 0)::int`.as('n'))
    .where('o.pos_session_id', '=', sessionId).where('b.status', '!=', 'cancelled').executeTakeFirstOrThrow();
  const repaid = await q.selectFrom('credit_repayments').select(['method', sql<number>`coalesce(sum(amount_paise), 0)::int`.as('n')]).where('pos_session_id', '=', sessionId).groupBy('method').execute();
  const repaidCash = repaid.find(r => r.method === 'cash')?.n ?? 0;
  const money = sales.reduce((n, x) => n + x.amount_paise, 0);
  return {
    session: s, transactions: bills.length, voidedTransactions: bills.length - valid.length,
    grossPaise: bills.reduce((n, x) => n + x.total_paise, 0), discountPaise: valid.reduce((n, x) => n + x.discount_paise, 0),
    netPaise: bills.reduce((n, x) => n + x.total_paise, 0) - bills.filter(x => x.status === 'cancelled').reduce((n, x) => n + x.total_paise, 0), byMethod,
    moneyReceivedPaise: money - voids.reduce((n, x) => n + x.n, 0),
    storeCreditPaise: other.find(x => x.provider === 'store_credit')?.n ?? 0, exchangeValuePaise: other.find(x => x.provider === 'exchange')?.n ?? 0,
    onCreditPaise: onCredit.n, repaymentsPaise: repaid.reduce((n, r) => n + r.n, 0), repaymentsCashPaise: repaidCash,
    cashSalesPaise: byMethod.cash.amountPaise - byMethod.cash.voidedPaise,
    expectedCashPaise: s.opening_cash_paise + byMethod.cash.amountPaise - byMethod.cash.voidedPaise + repaidCash,
  };
}

export async function closePosSession(db: Db, actor: StaffPrincipal, input: { sessionId: string; countedCashPaise: number; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'pos.sell');
  if (!Number.isInteger(input.countedCashPaise) || input.countedCashPaise < 0) throw new DomainError('invalid', 'Enter the cash counted in the drawer.');
  return db.transaction().execute(async tx => {
    const s = await tx.selectFrom('pos_sessions').selectAll().where('id', '=', input.sessionId).forUpdate().executeTakeFirst();
    if (!s) throw new NotFoundError('Session not found.');
    if (s.staff_id !== actor.staffId && !can(actor, 'pos.reports')) throw new ForbiddenError('Only the cashier of this session or a manager can close it.');
    // 2026-10-14: a manager closes other cashiers' sessions only at their own branches (a cashier can always close their own).
    if (s.staff_id !== actor.staffId) requireLocation(actor, s.location_id);
    if (s.status !== 'open') throw new ConflictError(`Session ${s.number} is already closed.`);
    const sum = await posSessionSummary(tx, s.id);
    const variance = input.countedCashPaise - sum.expectedCashPaise;
    const note = input.note?.trim().slice(0, 500) || null;
    if (variance !== 0 && !note) throw new DomainError('invalid', `The counted cash differs from the expected ${inr(sum.expectedCashPaise)} by ${inr(variance)}: enter a note explaining it.`);
    await tx.updateTable('pos_sessions').set({ status: 'closed', closed_at: sql`now()`, closed_by: actor.staffId, expected_cash_paise: sum.expectedCashPaise,
      counted_cash_paise: input.countedCashPaise, variance_paise: variance, close_note: note }).where('id', '=', s.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.session_close', entityType: 'pos_sessions', entityId: s.id,
      before: { status: 'open' }, after: { status: 'closed', expected_cash_paise: sum.expectedCashPaise, counted_cash_paise: input.countedCashPaise, variance_paise: variance, note },
      metadata: { number: s.number, transactions: sum.transactions } });
    return { number: s.number, expectedCashPaise: sum.expectedCashPaise, countedCashPaise: input.countedCashPaise, variancePaise: variance, transactions: sum.transactions };
  });
}

export async function listPosSessions(db: Db, actor: StaffPrincipal, opts: { all?: boolean; limit?: number } = {}) {
  requirePermission(actor, 'pos.access');
  let q = db.selectFrom('pos_sessions as s').innerJoin('locations as l', 'l.id', 's.location_id').innerJoin('staff_users as u', 'u.id', 's.staff_id')
    .select(['s.id', 's.number', 's.status', 's.opened_at', 's.closed_at', 's.opening_cash_paise', 's.expected_cash_paise', 's.counted_cash_paise', 's.variance_paise', 's.close_note',
      'l.name as location_name', 'u.email as cashier_email', 'u.full_name as cashier_name',
      sql<number>`(select count(*)::int from public.orders o where o.pos_session_id = s.id)`.as('transactions'),
      sql<number>`(select coalesce(sum(o.total_paise), 0)::int from public.orders o where o.pos_session_id = s.id and o.status <> 'cancelled')`.as('sales_paise')])
    .orderBy('s.opened_at', 'desc').limit(opts.limit ?? 100);
  // Cashiers see their own sessions; managers (pos.reports) see every cashier's.
  if (!(opts.all && can(actor, 'pos.reports'))) q = q.where('s.staff_id', '=', actor.staffId);
  // 2026-10-14: and only at the branches they are assigned to.
  const scope = locationScope(actor);
  if (scope) q = q.where('s.location_id', 'in', scope);
  return q.execute();
}

// ---------------------------------------------------------------- product search
export type PosVariant = { variantId: string; sku: string; barcode: string | null; size: string; colour: string | null; colourLabel: string | null; unitPaise: number; stock: number };
export type PosProduct = { productId: string; name: string; imagePath: string | null; /** the product's category (counter filter chips) */ category: string | null; variants: PosVariant[] };

/** Products by name, SKU (or SKU prefix) or barcode, with each size's price and the stock AT THIS BRANCH. An exact barcode
    or SKU match returns just that size (a scan adds it straight to the bill). */
export async function searchPosProducts(db: Db, actor: StaffPrincipal, input: { locationId: string; q: string }): Promise<{ exact: PosVariant & { productId: string; name: string } | null; products: PosProduct[] }> {
  requirePermission(actor, 'pos.access');
  requireLocation(actor, input.locationId);
  const term = input.q.trim().slice(0, 80);
  if (!term) return { exact: null, products: [] };
  const like = `${term.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`;
  const word = `%${term.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`;
  const rows = await variantQuery(db).leftJoin('location_stock as ls', join => join.onRef('ls.variant_id', '=', 'v.id').on('ls.location_id', '=', input.locationId))
    .select(['v.barcode', sql<string | null>`(select c.label from public.categories c where c.id = p.category_id)`.as('category_label'), sql<number>`coalesce(ls.qty, 0)::int`.as('branch_qty'), 'v.sort_order'])
    .where('v.is_active', '=', true)
    .where(eb => eb.or([eb('v.barcode', '=', term), sql<boolean>`lower(v.sku) like ${like}`, sql<boolean>`lower(p.sku) like ${like}`, sql<boolean>`lower(p.name) like ${word}`]))
    .orderBy('p.name').orderBy('v.colour_slug').orderBy('v.sort_order').limit(200).execute();
  const toVariant = (r: typeof rows[number]): PosVariant => ({ variantId: r.variant_id, sku: r.sku, barcode: r.barcode, size: r.size, colour: r.colour_slug,
    colourLabel: r.colour_slug ? (r.colour_label ?? r.colour_slug) : null, unitPaise: r.unit_paise, stock: r.branch_qty });
  const hit = rows.find(r => r.barcode === term) ?? rows.find(r => r.sku.toLowerCase() === term.toLowerCase());
  const products = new Map<string, PosProduct>();
  for (const r of rows) {
    const p = products.get(r.product_id) ?? { productId: r.product_id, name: r.name, imagePath: r.image_path, category: r.category_label, variants: [] };
    p.variants.push(toVariant(r));
    products.set(r.product_id, p);
  }
  return { exact: hit ? { ...toVariant(hit), productId: hit.product_id, name: hit.name } : null, products: [...products.values()].slice(0, 30) };
}

/** What can be sold at this branch right now: every size with stock AT THIS BRANCH, by product (up to `limit` products,
    by name). Shown on the counter before anything is searched, so the cashier sees the branch's stock at a glance. */
export async function listPosBranchStock(db: Db, actor: StaffPrincipal, input: { locationId: string; limit?: number }): Promise<{ products: PosProduct[]; more: boolean }> {
  requirePermission(actor, 'pos.access');
  requireLocation(actor, input.locationId);
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
  const rows = await variantQuery(db).innerJoin('location_stock as ls', join => join.onRef('ls.variant_id', '=', 'v.id').on('ls.location_id', '=', input.locationId))
    .select(['v.barcode', sql<string | null>`(select c.label from public.categories c where c.id = p.category_id)`.as('category_label'), sql<number>`ls.qty::int`.as('branch_qty'), 'v.sort_order'])
    .where('v.is_active', '=', true).where('ls.qty', '>', 0)
    .orderBy('p.name').orderBy('v.colour_slug').orderBy('v.sort_order').limit(1500).execute();
  const products = new Map<string, PosProduct>();
  for (const r of rows) {
    const p = products.get(r.product_id) ?? { productId: r.product_id, name: r.name, imagePath: r.image_path, category: r.category_label, variants: [] };
    p.variants.push({ variantId: r.variant_id, sku: r.sku, barcode: r.barcode, size: r.size, colour: r.colour_slug,
      colourLabel: r.colour_slug ? (r.colour_label ?? r.colour_slug) : null, unitPaise: r.unit_paise, stock: r.branch_qty });
    products.set(r.product_id, p);
  }
  const all = [...products.values()];
  return { products: all.slice(0, limit), more: all.length > limit };
}

// ---------------------------------------------------------------- pricing a bill
export type PosLineInput = { variantId: string; qty: number };
export type PosDiscountInput = { percent: number; reason: string | null } | null;

function cleanLines(lines: PosLineInput[]): PosLineInput[] {
  const merged = new Map<string, number>();
  for (const l of lines) {
    if (typeof l?.variantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(l.variantId)) throw new DomainError('invalid', 'One of the items is not valid.');
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new DomainError('invalid', 'Each quantity must be at least 1.');
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.qty);
  }
  for (const [, qty] of merged) if (qty > MAX_QTY_PER_LINE) throw new DomainError('invalid', `At most ${MAX_QTY_PER_LINE} of one size per bill.`);
  if (!merged.size) throw new DomainError('invalid', 'Add at least one item.');
  if (merged.size > 60) throw new DomainError('invalid', 'At most 60 different items per bill.');
  return [...merged].map(([variantId, qty]) => ({ variantId, qty }));
}

/** Prices the lines for this branch: each line with the branch's stock and a problem when it cannot be sold. */
/* 2026-10-12: a counter bill may also carry a coupon (the store's own coupons, by the same rules) and, for a linked customer,
   loyalty points. Order: staff discount and coupon first (combined as the stacking setting says), then points on what is
   left, then tax: the same priceOrder the store checkout uses. Points always need a customer on the bill. */
async function priceBill(q: Queryable, locationId: string, input: { lines: PosLineInput[]; customerId?: string | null; discount: PosDiscountInput; couponCode?: string | null; usePoints?: boolean }) {
  const lines = cleanLines(input.lines);
  const ids = lines.map(l => l.variantId);
  const rows = new Map((await variantQuery(q).where('v.id', 'in', ids).execute()).map(r => [r.variant_id, r]));
  // A check here gives the cashier a clear message; the real guarantee is the stock ledger itself: location_stock never goes
  // below zero (check constraint), so when two tills sell the last unit at the same moment exactly one sale commits.
  const stock = new Map((await q.selectFrom('location_stock').select(['variant_id', 'qty']).where('location_id', '=', locationId).where('variant_id', 'in', ids).execute()).map(r => [r.variant_id, r.qty]));
  const priced: (PricedLine & { branchStock: number; problem: PricedLine['problem'] })[] = [];
  for (const l of lines) {
    const v = rows.get(l.variantId);
    if (!v) throw new NotFoundError('One of the items is no longer on sale.');
    const have = stock.get(l.variantId) ?? 0;
    const line = pricedLine({ ...v, stock_qty: have }, l.qty);
    priced.push({ ...line, branchStock: have, problem: !v.is_active ? 'unavailable' : have <= 0 ? 'out_of_stock' : l.qty > have ? 'insufficient_stock' : null });
  }
  const bp = input.discount && input.discount.percent > 0 ? Math.round(input.discount.percent * 100) : 0;
  if (bp) await checkStaffDiscount(q, priced, bp);
  const subtotal = priced.reduce((n, l) => n + l.lineTotalPaise, 0);
  const rule = bp ? staffRule(bp, input.discount?.reason ?? '') : null;
  const staff = rule ? { code: rule.code, label: rule.label, amountPaise: Math.max(0, Math.floor(await rule.evaluate({ lines: priced, subtotalPaise: subtotal, customerId: input.customerId ?? null }))) } : null;
  const code = couponCodeOf(input.couponCode);
  const totals: CartTotals = await priceOrder(q, priced, {
    config: { shipping: inStore, discounts: [], discountSource: counterDiscounts(code, staff) },
    customerId: input.customerId ?? null, shipTo: null,
    // With a customer on the bill the points are always quoted (their balance and what it can take off); used only when asked.
    payment: input.customerId ? { method: 'online', usePoints: !!input.usePoints } : null,
  });
  return { lines: priced, totals, discountBp: bp, bill: billFromTotals(totals), coupon: totals.coupon ?? null, loyalty: totals.payment?.loyalty ?? null };
}

/** The bill as the counter shows it (always priced on the server: price, sale price, discount limits, tax, branch stock). */
export async function quotePosSale(db: Db, actor: StaffPrincipal, input: { locationId: string; lines: PosLineInput[]; customerId?: string | null; discount: PosDiscountInput; couponCode?: string | null; usePoints?: boolean }) {
  requirePermission(actor, 'pos.access');
  requireLocation(actor, input.locationId);
  if (input.discount && input.discount.percent > 0) requirePermission(actor, 'orders.discount');
  const r = await priceBill(db, input.locationId, input);
  return { ...r, problems: r.lines.filter(l => l.problem).map(l => l.problem === 'unavailable' ? `${lineLabel(l)} is not offered.`
    : `Only ${l.branchStock} of ${lineLabel(l)} ${l.branchStock === 1 ? 'is' : 'are'} in stock at this branch.`) };
}

// ---------------------------------------------------------------- completing a sale
export interface PosSaleInput {
  sessionId: string;
  idempotencyKey: string;
  lines: PosLineInput[];
  customerId?: string | null;
  contact?: { name?: string | null; phone?: string | null } | null;
  discount: PosDiscountInput;
  /** 2026-10-12: a coupon code typed at the counter, and whether the linked customer's loyalty points are used. The server
      decides whether either applies and what it takes off; a coupon or points that do not apply refuse the sale. */
  couponCode?: string | null; usePoints?: boolean;
  payment: { method: PosPaymentMethod; tenderedPaise?: number | null; reference?: string | null };
  /** 2026-10-13: several tenders instead of `payment`. Their amounts must add up to the bill exactly. */
  tenders?: PosTender[] | null;
  /** The total the cashier showed the customer; the sale is refused if the server's total differs. */
  expectedTotalPaise: number;
}

/** What a bill consists of, as one short value kept with the sale (2026-10-13). A bill sent again with the same key
    (double click, retry after a lost answer) is the same sale only if this matches: the same sizes and quantities, customer,
    discount, coupon, points, method and total. */
function billFingerprint(input: PosSaleInput): string {
  const lines = [...input.lines].map(l => `${l.variantId}:${l.qty}`).sort().join(',');
  return createHash('sha256').update(JSON.stringify([lines, input.customerId ?? null, input.discount && input.discount.percent > 0 ? input.discount.percent : 0,
    (input.couponCode ?? '').trim().toUpperCase(), !!input.usePoints, input.tenders?.length ? [...input.tenders].map(t => `${t.method}:${t.amountPaise}`).sort().join(',') : input.payment.method,
    input.expectedTotalPaise])).digest('hex').slice(0, 32);
}

export async function completePosSale(db: Db, actor: StaffPrincipal, input: PosSaleInput, ctx: MutationContext,
  /** Internal (the exchange workflow): run inside its transaction, with the value of the returned goods as a tender. */
  inner?: { tx: Tx; exchange: { returnId: string; valuePaise: number } })
  : Promise<{ orderId: string; orderNumber: string; posNumber: string; totalPaise: number; changePaise: number; replay: boolean; creditDueOn?: string | null }> {
  requirePermission(actor, 'pos.sell');
  const split = Array.isArray(input.tenders) && input.tenders.length > 0;
  if (split) {
    const ts = input.tenders!;
    if (ts.length > 4) throw new DomainError('invalid', 'At most four ways of paying on one bill.');
    if (new Set(ts.map(t => t.method)).size !== ts.length) throw new DomainError('invalid', 'Each way of paying can be used once on a bill.');
    for (const t of ts) {
      if (!(POS_TENDER_METHODS as readonly string[]).includes(t?.method)) throw new DomainError('invalid', 'One of the payments is not a way of paying this shop accepts.');
      if (!Number.isInteger(t.amountPaise) || t.amountPaise <= 0) throw new DomainError('invalid', `Enter the ${TENDER_LABEL[t.method].toLowerCase()} amount, above ₹0.`);
      if ((t.method === 'card' || t.method === 'upi') && !REF_OK.test(t.reference?.trim() ?? '')) throw new DomainError('invalid', `Enter the ${t.method === 'upi' ? 'UPI transaction reference (UTR)' : 'card approval / transaction reference'} shown when the payment succeeded.`);
    }
    if (ts.some(t => t.method === 'store_credit')) requirePermission(actor, 'store_credit.redeem');
    if (ts.some(t => t.method === 'credit')) requirePermission(actor, 'pos.credit_sell');
    if (ts.some(t => t.method === 'store_credit' || t.method === 'credit') && !input.customerId) throw new DomainError('invalid', 'Store credit and credit bills need a customer on the bill.');
  }
  if (!/^[A-Za-z0-9_-]{16,60}$/.test(input.idempotencyKey ?? '')) throw new DomainError('invalid', 'Missing sale key: reload the POS screen.');
  if (!split && !(POS_PAYMENT_METHODS as readonly string[]).includes(input.payment?.method)) throw new DomainError('invalid', 'Choose the payment method: cash, card or UPI.');
  const discount = input.discount && input.discount.percent > 0 ? input.discount : null;
  if (discount) {
    requirePermission(actor, 'orders.discount');
    if (!discount.reason || discount.reason.trim().length < 3) throw new DomainError('invalid', 'Enter the reason for the discount.');
  }
  const reference = (split ? input.tenders!.find(t => t.method === 'card' || t.method === 'upi')?.reference : input.payment.reference)?.trim() || null;
  if (!split && input.payment.method !== 'cash' && (!reference || !REF_OK.test(reference)))
    throw new DomainError('invalid', `Enter the ${input.payment.method === 'upi' ? 'UPI transaction reference (UTR)' : 'card approval / transaction reference'} shown when the payment succeeded.`);
  const key = `pos-${input.idempotencyKey}`.slice(0, 64);
  try {
    const run = async (tx: Tx) => {
      // The session row is locked for the whole sale: sales of one till are one at a time, and a double-submitted bill
      // finds the first one (idempotency key) instead of charging twice.
      const s = await tx.selectFrom('pos_sessions as s').innerJoin('locations as l', 'l.id', 's.location_id')
        .select(['s.id', 's.number', 's.status', 's.staff_id', 's.location_id', 'l.name as location_name', 'l.address as location_address', 'l.is_active'])
        .where('s.id', '=', input.sessionId).forUpdate('s').executeTakeFirst();
      if (!s) throw new NotFoundError('Cashier session not found.');
      if (s.staff_id !== actor.staffId) throw new ForbiddenError('This is another cashier’s session: open your own session.');
      // 2026-10-14: a cashier moved off this branch since opening the session can close it but no longer sell on it.
      requireLocation(actor, s.location_id);
      if (s.status !== 'open') throw new ConflictError(`Session ${s.number} is closed: open a new session to keep billing.`);
      if (!s.is_active) throw new ConflictError(`${s.location_name} is inactive.`);
      const prior = await tx.selectFrom('orders').select(['id', 'order_number', 'pos_number', 'total_paise', 'pricing', 'status']).where('idempotency_key', '=', key).where('channel', '=', 'retail').executeTakeFirst();
      if (prior) {
        // 2026-10-13: the earlier sale is returned only when this IS that bill. Before, a bill changed after a lost answer
        // (an item added, then Charge again) was answered "paid" with the old total, and a voided one likewise.
        const was = ((prior.pricing ?? {}) as { pos?: { changePaise?: number; fingerprint?: string } }).pos ?? {};
        if (prior.status === 'cancelled') throw new ConflictError(`This bill was already saved as ${prior.pos_number} and has since been voided. Start a new sale.`);
        if (was.fingerprint && was.fingerprint !== billFingerprint(input))
          throw new ConflictError(`This bill was already paid as ${prior.pos_number} (₹${(prior.total_paise / 100).toFixed(2)}). What is on the screen now is different: start a new sale for anything added since.`);
        return { orderId: prior.id, orderNumber: prior.order_number, posNumber: prior.pos_number!, totalPaise: prior.total_paise, changePaise: Number(was.changePaise ?? 0), replay: true };
      }

      let contact = { name: input.contact?.name?.trim().slice(0, 120) || null, email: null as string | null, phone: input.contact?.phone?.replace(/[^0-9+]/g, '').slice(0, 15) || null };
      if (input.customerId) {
        const c = await tx.selectFrom('customers').select(['id', 'email', 'full_name', 'phone', 'status']).where('id', '=', input.customerId).executeTakeFirst();
        if (!c) throw new NotFoundError('Customer not found.');
        if (c.status !== 'active') throw new ConflictError('This customer account is disabled.');
        contact = { name: c.full_name, email: c.email, phone: c.phone ?? contact.phone };
      }

      const couponCode = couponCodeOf(input.couponCode), usePoints = !!input.usePoints;
      if (usePoints && !input.customerId) throw new DomainError('invalid', 'Loyalty points need a customer on the bill.');
      // The points priced below cannot be spent twice: the customer's balance row stays locked until the sale is saved.
      if (usePoints) await lockLoyaltyAccount(tx, input.customerId!);
      const bill = await priceBill(tx, s.location_id, { lines: input.lines, customerId: input.customerId ?? null, discount, couponCode, usePoints });
      if (couponCode && !bill.coupon?.applied) throw new ConflictError(`Coupon ${couponCode} was not applied: ${bill.coupon?.message ?? 'it is not valid.'} Remove it from the bill or fix it, then take payment.`);
      const pointsUsed = bill.loyalty?.usedPoints ?? 0, pointsValue = bill.loyalty?.discountPaise ?? 0;
      if (usePoints && pointsUsed <= 0) throw new ConflictError(`Loyalty points were not used: ${bill.loyalty?.message ?? 'this customer has no points that can be used on this bill.'} Untick them, then take payment.`);
      const bad = bill.lines.find(l => l.problem);
      if (bad) throw new ConflictError(bad.problem === 'unavailable' ? `${lineLabel(bad)} is not offered.` : `Only ${bad.branchStock} of ${lineLabel(bad)} ${bad.branchStock === 1 ? 'is' : 'are'} in stock at ${s.location_name}.`);
      const t = bill.totals;
      if (t.totalPaise !== input.expectedTotalPaise) throw new ConflictError(`The total changed to ${inr(t.totalPaise)} (prices or stock changed). Check the bill and take payment again.`);
      // What settles the bill. An exchange brings the value of the returned goods (never more than the bill); the rest is
      // the cashier's tenders, which must add up to exactly what is left.
      const exchangePaise = inner ? Math.min(inner.exchange.valuePaise, t.totalPaise) : 0, duePaise = t.totalPaise - exchangePaise;
      const tenders: PosTender[] = split ? input.tenders!.map(x => ({ method: x.method, amountPaise: x.amountPaise, reference: x.reference?.trim() || null, tenderedPaise: x.tenderedPaise ?? null }))
        : duePaise > 0 || !inner ? [{ method: input.payment.method, amountPaise: duePaise, reference, tenderedPaise: input.payment.tenderedPaise ?? null }] : [];
      const tendered = tenders.reduce((n, x) => n + x.amountPaise, 0);
      if (tendered !== duePaise) throw new ConflictError(`The payments add up to ${inr(tendered)} but ${inr(duePaise)} is due. Correct the amounts and take payment again.`);
      let changePaise = 0, tenderedPaise: number | null = null;
      const cash = tenders.find(x => x.method === 'cash');
      if (cash) {
        tenderedPaise = split && cash.tenderedPaise == null ? cash.amountPaise : Number(cash.tenderedPaise);
        if (!Number.isInteger(tenderedPaise) || tenderedPaise < cash.amountPaise) throw new DomainError('invalid', `Enter the cash received: at least ${inr(cash.amountPaise)}.`);
        changePaise = tenderedPaise - cash.amountPaise;
      }
      const onCredit = tenders.find(x => x.method === 'credit')?.amountPaise ?? 0, fromStoreCredit = tenders.find(x => x.method === 'store_credit')?.amountPaise ?? 0;
      const methodCode = tenders.length === 1 ? tenders[0]!.method : 'split' as const;
      const payText = [...(exchangePaise ? [`${TENDER_LABEL.exchange} ${inr(exchangePaise)}`] : []), ...tenders.map(x => `${TENDER_LABEL[x.method]} ${inr(x.amountPaise)}${x.reference ? ` (ref ${x.reference})` : ''}`)].join(' + ') || 'nothing to pay';
      const staffDiscount = t.discounts.find(x => x.code === 'STAFF')?.amountPaise ?? 0;
      const posNumber = (await sql<{ n: string }>`select public.next_document_number('pos_sale', 'POS') as n`.execute(tx)).rows[0].n;
      const pos = { number: posNumber, session: s.number, cashier: actor.email, method: methodCode, reference, tenderedPaise, changePaise, fingerprint: billFingerprint(input),
        tenders: [...(exchangePaise ? [{ method: 'exchange', amountPaise: exchangePaise }] : []), ...tenders.map(x => ({ method: x.method, amountPaise: x.amountPaise, reference: x.reference ?? null }))],
        ...(onCredit ? { onCreditPaise: onCredit } : {}), ...(inner ? { exchangeOfReturn: inner.exchange.returnId } : {}) };

      const order = await tx.insertInto('orders').values({
        customer_id: input.customerId ?? null, cart_id: null, idempotency_key: key,
        status: 'delivered', payment_status: onCredit ? 'unpaid' : 'paid', currency: 'INR',
        subtotal_paise: t.subtotalPaise, discount_paise: t.discountPaise, shipping_paise: t.shippingPaise, tax_paise: t.taxPaise,
        total_paise: t.totalPaise, prices_include_tax: t.pricesIncludeTax,
        pricing: JSON.stringify({ tax: t.tax, shipping: t.shipping, discounts: t.discounts, ...(couponCode ? { coupon: couponCode } : {}), source: { pos: posNumber }, pos }),
        loyalty_points_used: pointsUsed, loyalty_discount_paise: pointsValue,
        payment_method: methodCode, cod_status: null, cod_fee_paise: 0, exchange_return_id: inner?.exchange.returnId ?? null,
        contact: JSON.stringify(contact),
        // A counter sale has no delivery: its address is the branch (shown on bills and invoices as the place of sale).
        shipping_address: JSON.stringify({ name: contact.name ?? 'Walk-in customer', phone: contact.phone, line1: s.location_name, line2: s.location_address, city: '', state: '', pin: '', country: 'India' }),
        billing_address: null,
        channel: 'retail', location_id: s.location_id, created_by: actor.staffId, draft_order_id: null,
        pos_session_id: s.id, pos_number: posNumber,
        staff_discount_paise: staffDiscount, staff_discount_bp: staffDiscount ? bill.discountBp : null,
        staff_discount_reason: staffDiscount ? discount!.reason!.trim().slice(0, 200) : null, staff_discount_by: staffDiscount ? actor.staffId : null,
        paid_at: onCredit ? null : sql<Date>`now()`, payment_expires_at: null,
      }).returning(['id', 'order_number']).executeTakeFirstOrThrow();
      await tx.insertInto('order_items').values(bill.lines.map(l => ({
        order_id: order.id, product_id: l.productId, variant_id: l.variantId, sku: l.sku, name: l.name, size: l.size, colour: l.colourLabel,
        image_path: l.imagePath, unit_price_paise: l.unitPaise, qty: l.qty, line_total_paise: l.lineTotalPaise,
      }))).execute();
      await tx.insertInto('order_status_history').values([
        { order_id: order.id, from_status: null, to_status: 'paid', note: `POS ${posNumber}: ${payText} at ${s.location_name}, cashier ${actor.email}`.slice(0, 1000) },
        { order_id: order.id, from_status: 'paid', to_status: 'delivered', note: `Handed over at the counter, ${s.location_name}` },
      ]).execute();
      // Stock from THIS branch only, through the ledger (reason retail_sale, linked to the order; never below zero).
      await sql`select public.sell_order_at_location(${order.id}::uuid, ${actor.staffId}::uuid)`.execute(tx);
      // One payments row per tender that settles something now. Money (cash / card / UPI) is provider 'pos'; store credit
      // and the exchange value have their own provider names, so no report mistakes them for money received. A credit
      // tender has no payments row at all: it becomes a credit bill.
      const rawBase = { cashier_id: actor.staffId, session: s.number, location_id: s.location_id };
      let posRows = 0;
      if (exchangePaise) await tx.insertInto('payments').values({ order_id: order.id, provider: 'exchange', provider_order_id: s.number, provider_payment_id: posNumber, amount_paise: exchangePaise, currency: 'INR',
        status: 'captured', method: 'exchange', captured_at: sql<Date>`now()`, raw: JSON.stringify({ ...rawBase, return_id: inner!.exchange.returnId }) }).execute();
      for (const x of tenders) {
        if (x.method === 'credit') continue;
        const money = x.method !== 'store_credit';
        await tx.insertInto('payments').values({
          order_id: order.id, provider: money ? 'pos' : 'store_credit', provider_order_id: s.number, provider_payment_id: money && posRows++ > 0 ? `${posNumber}/${posRows}` : posNumber, amount_paise: x.amountPaise, currency: 'INR',
          status: 'captured', method: x.method, captured_at: sql<Date>`now()`,
          raw: JSON.stringify({ ...rawBase, reference: x.reference ?? null, ...(x.method === 'cash' ? { tendered_paise: tenderedPaise, change_paise: changePaise } : {}) }),
        }).execute();
        // The customer's balance row is locked and debited here: two tills cannot spend the same store credit, and a sale that
        // fails after this point rolls the debit back with everything else.
        if (!money) await moveStoreCredit(tx, { customerId: input.customerId!, amountPaise: -x.amountPaise, kind: 'redeem', reason: `Spent on ${posNumber}`, key: `pos:${key}`, orderId: order.id, staffId: actor.staffId });
      }
      if (tenders.length === 0 && !exchangePaise) throw new DomainError('invalid', 'Choose how this bill is paid.');
      const credit = onCredit ? await openCreditBill(tx, actor, { customerId: input.customerId!, orderId: order.id, amountPaise: onCredit }) : null;
      // The coupon's use is recorded (and its limits re-checked under a lock) and the points are taken, in this same transaction.
      await recordDiscountRedemptions(tx, order.id, input.customerId ?? null, t.discounts);
      if (pointsUsed > 0) await redeemForOrder(tx, input.customerId!, order.id, pointsUsed, order.order_number);
      // Points are earned on money received: a bill with an amount on credit earns when that credit bill is fully repaid.
      if (input.customerId && !onCredit) { await earnForOrder(tx, order.id, 'paid'); await earnForOrder(tx, order.id, 'delivered'); }
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.sale', entityType: 'orders', entityId: order.id,
        after: { pos_number: posNumber, order_number: order.order_number, location_id: s.location_id, payment_method: methodCode, total_paise: t.totalPaise,
          staff_discount_paise: staffDiscount, customer_id: input.customerId ?? null, discount_paise: t.discountPaise, coupon: couponCode, loyalty_points_used: pointsUsed },
        metadata: { session: s.number, reference, units: t.units, tenders: pos.tenders, ...(credit ? { credit_bill_id: credit.billId, due_on: credit.dueOn } : {}),
          ...(staffDiscount ? { discount_bp: bill.discountBp, discount_reason: discount!.reason } : {}) } });
      return { orderId: order.id, orderNumber: order.order_number, posNumber, totalPaise: t.totalPaise, changePaise, replay: false, creditDueOn: credit?.dueOn ?? null };
    };
    return inner ? await run(inner.tx) : await db.transaction().execute(run);
  } catch (e) {
    // location_stock never goes below zero (a check constraint): another till sold the last unit first.
    if ((e as { code?: string })?.code === '23514') throw new ConflictError('Part of this bill just sold out at this branch. Check the stock and try again.');
    throw e;
  }
}

// ---------------------------------------------------------------- reading sales (bill / receipt)
export async function getPosSale(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'pos.access');
  const o = await db.selectFrom('orders as o').leftJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as u', 'u.id', 'o.created_by')
    .leftJoin('pos_sessions as s', 's.id', 'o.pos_session_id').leftJoin('customers as c', 'c.id', 'o.customer_id')
    .select(['o.id', 'o.order_number', 'o.pos_number', 'o.status', 'o.payment_status', 'o.payment_method', 'o.created_at', 'o.subtotal_paise', 'o.discount_paise', 'o.tax_paise',
      'o.shipping_paise', 'o.total_paise', 'o.prices_include_tax', 'o.pricing', 'o.contact', 'o.staff_discount_bp', 'o.staff_discount_reason', 'o.customer_id', 'o.loyalty_points_used', 'o.cod_fee_paise', 'o.location_id',
      'l.name as location_name', 'l.address as location_address', 'l.code as location_code', 'u.email as cashier_email', 'u.full_name as cashier_name',
      's.number as session_number', 's.status as session_status', 's.staff_id as session_staff_id', 'c.email as customer_email', 'c.full_name as customer_name'])
    .where('o.id', '=', orderId).executeTakeFirst();
  if (!o || !o.pos_number) throw new NotFoundError('POS sale not found.');
  requireLocation(actor, o.location_id);   // 2026-10-14: another branch's bill is not shown to staff assigned elsewhere
  const [items, payment, invoice, returns] = await Promise.all([
    db.selectFrom('order_items').select(['id', 'name', 'sku', 'size', 'colour', 'qty', 'unit_price_paise', 'line_total_paise']).where('order_id', '=', o.id).orderBy('name').execute(),
    db.selectFrom('payments').select(['id', 'method', 'amount_paise', 'status', 'raw', 'captured_at']).where('order_id', '=', o.id).where('provider', '=', 'pos').executeTakeFirst(),
    db.selectFrom('invoices').select(['id', 'invoice_number']).where('order_id', '=', o.id).where('status', '=', 'issued').executeTakeFirst(),
    db.selectFrom('return_requests').select(['id', 'number', 'status', 'settlement', 'settlement_paise', 'exchange_order_id']).where('order_id', '=', o.id).execute(),
  ]);
  // 2026-10-13: every tender of the bill, its credit bill (if part of it was sold on credit) and its place in an exchange.
  const [tenders, creditBill, exchangeOf, replacements] = await Promise.all([
    db.selectFrom('payments').select(['provider', 'method', 'amount_paise', 'status', 'raw']).where('order_id', '=', o.id).where('provider', 'in', ['pos', 'store_credit', 'exchange']).orderBy('created_at').orderBy('provider_payment_id').execute(),
    db.selectFrom('credit_bills').select(['id', 'amount_paise', 'outstanding_paise', 'due_on', 'status']).where('order_id', '=', o.id).executeTakeFirst(),
    db.selectFrom('orders as x').innerJoin('return_requests as r', 'r.id', 'x.exchange_return_id').innerJoin('orders as orig', 'orig.id', 'r.order_id')
      .select(['r.id as return_id', 'r.number as return_number', 'orig.id as order_id', 'orig.order_number', 'orig.pos_number']).where('x.id', '=', o.id).executeTakeFirst(),
    db.selectFrom('return_requests as r').innerJoin('orders as x', 'x.id', 'r.exchange_order_id').select(['r.number as return_number', 'x.id as order_id', 'x.pos_number']).where('r.order_id', '=', o.id).execute(),
  ]);
  const pricing = (o.pricing ?? {}) as { tax?: { configured?: boolean; label?: string; rateBp?: number; inclusive?: boolean }; pos?: { reference?: string | null; tenderedPaise?: number | null; changePaise?: number } };
  return { sale: o, items, payment, invoice: invoice ?? null, returns, tax: pricing.tax ?? null, pos: pricing.pos ?? null,
    tenders: tenders.map(t => ({ method: t.method ?? t.provider, amountPaise: t.amount_paise, status: t.status, reference: ((t.raw ?? {}) as { reference?: string | null }).reference ?? null })),
    creditBill: creditBill ?? null, exchangeOf: exchangeOf ?? null, replacements,
    canVoid: can(actor, 'pos.void') && o.status !== 'cancelled' && o.session_status === 'open' && !returns.some(r => !['rejected', 'cancelled'].includes(r.status)) };
}

export async function listPosSales(db: Db, actor: StaffPrincipal, opts: { sessionId?: string; limit?: number } = {}) {
  requirePermission(actor, 'pos.access');
  let q = db.selectFrom('orders as o').innerJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as u', 'u.id', 'o.created_by')
    .select(['o.id', 'o.order_number', 'o.pos_number', 'o.status', 'o.payment_method', 'o.total_paise', 'o.created_at', 'o.contact', 'l.name as location_name', 'u.email as cashier_email'])
    .where('o.pos_number', 'is not', null).orderBy('o.created_at', 'desc').limit(opts.limit ?? 50);
  if (opts.sessionId) q = q.where('o.pos_session_id', '=', opts.sessionId);
  if (!can(actor, 'pos.reports')) q = q.where('o.created_by', '=', actor.staffId);
  const scope = locationScope(actor);   // 2026-10-14: only the branches the staff member is assigned to
  if (scope) q = q.where('o.location_id', 'in', scope);
  return q.execute();
}

// ---------------------------------------------------------------- voiding a sale at the counter
/** Voids a POS sale of an OPEN session (a mistake at the counter): every unit goes back to the same branch through the
    ledger (reason pos_void), the payment is recorded as returned (a processed manual refund "VOID …"), the order is
    cancelled, loyalty points earned on it are taken back. After the session is closed, use a return instead. */
export async function voidPosSale(db: Db, actor: StaffPrincipal, input: { orderId: string; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'pos.void');
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3) throw new DomainError('invalid', 'Enter the reason for voiding this sale.');
  return db.transaction().execute(async tx => {
    // 2026-10-13: the till's session is locked first, as a sale and a close do, so a void cannot slip in while the session is
    // being closed (its expected cash would then still count the voided sale).
    const seen = await tx.selectFrom('orders').select('pos_session_id').where('id', '=', input.orderId).executeTakeFirst();
    if (seen?.pos_session_id) await tx.selectFrom('pos_sessions').select('id').where('id', '=', seen.pos_session_id).forUpdate().executeTakeFirst();
    const o = await tx.selectFrom('orders as o').innerJoin('pos_sessions as s', 's.id', 'o.pos_session_id')
      .select(['o.id', 'o.order_number', 'o.pos_number', 'o.status', 'o.location_id', 'o.total_paise', 's.status as session_status', 's.number as session_number'])
      .where('o.id', '=', input.orderId).forUpdate('o').executeTakeFirst();
    if (!o || !o.pos_number) throw new NotFoundError('POS sale not found.');
    requireLocation(actor, o.location_id);   // 2026-10-14
    if (o.status === 'cancelled') throw new ConflictError(`${o.pos_number} is already voided.`);
    if (o.session_status !== 'open') throw new ConflictError(`Session ${o.session_number} is closed: a sale from a closed session is returned through Returns & refunds.`);
    const openReturn = await tx.selectFrom('return_requests').select('number').where('order_id', '=', o.id).where('status', 'not in', ['rejected', 'cancelled']).executeTakeFirst();
    if (openReturn) throw new ConflictError(`${o.pos_number} has return ${openReturn.number}: continue it in Returns & refunds.`);
    // 2026-10-13: a tax invoice that has been issued is a numbered legal document; voiding the sale under it would leave an
    // issued invoice for a cancelled sale. The sale is then corrected through a return (which keeps the invoice trail).
    const invoice = await tx.selectFrom('invoices').select('invoice_number').where('order_id', '=', o.id).where('status', '=', 'issued').executeTakeFirst();
    if (invoice) throw new ConflictError(`${o.pos_number} has tax invoice ${invoice.invoice_number} issued: it cannot be voided. Use Returns & refunds for this sale.`);
    const items = await tx.selectFrom('order_items').select(['variant_id', sql<number>`sum(qty)::int`.as('qty')]).where('order_id', '=', o.id).where('variant_id', 'is not', null)
      .groupBy('variant_id').orderBy('variant_id').execute();
    for (const it of items) {
      await sql`select public.order_stock_at_location(${o.id}::uuid, ${it.variant_id}::uuid, ${it.qty}::int, 'pos_void', ${actor.staffId}::uuid, ${`Void ${o.pos_number}`}::text)`.execute(tx);
    }
    // 2026-10-12: points used on the voided bill go back to the customer, and points it earned are taken back (once each).
    await reverseOrderPoints(tx, o.id, `POS sale ${o.pos_number} voided`);
    if (await tx.selectFrom('payments').select('id').where('order_id', '=', o.id).where('provider', '=', 'exchange').executeTakeFirst())
      throw new ConflictError(`${o.pos_number} is the replacement bill of an exchange: it cannot be voided. Use Returns & refunds.`);
    // 2026-10-13: a credit bill with nothing repaid is cancelled with the sale (the customer no longer owes it); store credit
    // spent on the sale goes back to the customer through a reversal entry; each money tender gets its own refund row below.
    await cancelCreditBillForVoid(tx, o.id);
    let refundedMoney = 0;
    const spent = await tx.selectFrom('payments').select(['id', 'amount_paise']).where('order_id', '=', o.id).where('provider', '=', 'store_credit').where('status', '=', 'captured').executeTakeFirst();
    if (spent) {
      const e = await tx.selectFrom('store_credit_entries').select(['id', 'customer_id']).where('order_id', '=', o.id).where('kind', '=', 'redeem').executeTakeFirstOrThrow();
      await moveStoreCredit(tx, { customerId: e.customer_id, amountPaise: spent.amount_paise, kind: 'reversal', reason: `POS sale ${o.pos_number} voided`, key: `void:${o.id}`, reversesId: e.id, orderId: o.id, staffId: actor.staffId });
      await tx.updateTable('payments').set({ status: 'refunded' }).where('id', '=', spent.id).execute();
    }
    const pays = await tx.selectFrom('payments').select(['id', 'amount_paise']).where('order_id', '=', o.id).where('provider', '=', 'pos').where('status', '=', 'captured').orderBy('created_at').orderBy('id').execute();
    for (const p of pays.filter(x => x.amount_paise > 0)) {
      await tx.insertInto('refunds').values({ payment_id: p.id, order_id: o.id, amount_paise: p.amount_paise, reason: `POS void: ${reason}`.slice(0, 500), status: 'processed',
        method: 'manual', reference: `VOID ${o.pos_number}`, requested_by: actor.staffId, processed_at: sql<Date>`now()`, processed_by: actor.staffId } as never).execute();
      await markPaymentRefunded(tx, o.id, p.id);
      refundedMoney += p.amount_paise;
    }
    // A bill that took no money (fully covered by a coupon or points) has nothing to refund: its payment row is closed.
    for (const p of pays.filter(x => x.amount_paise === 0)) await tx.updateTable('payments').set({ status: 'refunded' }).where('id', '=', p.id).execute();
    // every tender has been undone above: whatever the mix was, the bill is now fully returned
    await tx.updateTable('orders').set({ payment_status: 'refunded' }).where('id', '=', o.id).execute();
    await tx.updateTable('orders').set({ status: 'cancelled' }).where('id', '=', o.id).execute();
    await tx.insertInto('order_status_history').values({ order_id: o.id, from_status: o.status, to_status: 'cancelled', note: `POS sale voided by ${actor.email}: ${reason}`.slice(0, 1000) }).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.void', entityType: 'orders', entityId: o.id, before: { status: o.status }, after: { status: 'cancelled', payment_status: 'refunded' },
      metadata: { pos_number: o.pos_number, reason, total_paise: o.total_paise, units: items.reduce((n, i) => n + i.qty, 0) } });
    return { posNumber: o.pos_number, refundedPaise: refundedMoney };
  });
}

// ---------------------------------------------------------------- report
/** POS sales between two dates (India time, inclusive): totals, payment methods, discounts, voids and refunds, by cashier and by branch. */
export async function posReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string; locationId?: string | null }) {
  requirePermission(actor, 'pos.reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.from > range.to) throw new DomainError('invalid', 'Choose a valid date range.');
  const inRange = sql<boolean>`(o.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`;
  // 2026-10-14: a manager assigned to branches reports on those branches only (one of them, or all of them together).
  if (range.locationId) requireLocation(actor, range.locationId);
  const scope = range.locationId ? null : locationScope(actor);
  let base = db.selectFrom('orders as o').innerJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as u', 'u.id', 'o.created_by')
    .where('o.pos_number', 'is not', null).where(inRange);
  if (range.locationId) base = base.where('o.location_id', '=', range.locationId);
  if (scope) base = base.where('o.location_id', 'in', scope);
  const sales = await base.select(['o.id', 'o.status', 'o.payment_method', 'o.subtotal_paise', 'o.discount_paise', 'o.tax_paise', 'o.total_paise', 'l.name as location', 'u.email as cashier']).execute();
  let refundQ = db.selectFrom('refunds as r').innerJoin('orders as o', 'o.id', 'r.order_id')
    .select(['r.amount_paise', 'r.reference', 'o.payment_method']).where('o.pos_number', 'is not', null).where('r.status', '=', 'processed')
    .where(sql<boolean>`(r.processed_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`);
  if (range.locationId) refundQ = refundQ.where('o.location_id', '=', range.locationId);
  if (scope) refundQ = refundQ.where('o.location_id', 'in', scope);
  const refunds = await refundQ.execute();
  const sum = (xs: { total_paise: number }[]) => xs.reduce((n, x) => n + x.total_paise, 0);
  // 2026-10-13: voided sales are left out here, as they are in the by-cashier and by-branch tables (they were counted here only).
  // (2026-10-13, later the same day) taken from the payment rows, so each tender of a split bill is under its own method.
  const live = new Set(sales.filter(s => s.status !== 'cancelled').map(s => s.id));
  const tenderRows = live.size ? (await db.selectFrom('payments').select(['order_id', 'provider', 'method', 'amount_paise']).where('order_id', 'in', [...live]).where('provider', 'in', ['pos', 'store_credit', 'exchange']).execute()) : [];
  const methods = POS_PAYMENT_METHODS.map(m => { const xs = tenderRows.filter(r => r.provider === 'pos' && r.method === m); return { method: m, label: METHOD_LABEL[m], count: xs.length, amountPaise: xs.reduce((n, x) => n + x.amount_paise, 0) }; });
  const storeCreditPaise = tenderRows.filter(r => r.provider === 'store_credit').reduce((n, x) => n + x.amount_paise, 0), exchangeValuePaise = tenderRows.filter(r => r.provider === 'exchange').reduce((n, x) => n + x.amount_paise, 0);
  const creditRows = live.size ? (await db.selectFrom('credit_bills').select(['amount_paise']).where('order_id', 'in', [...live]).where('status', '!=', 'cancelled').execute()) : [];
  const onCreditPaise = creditRows.reduce((n, x) => n + x.amount_paise, 0);
  let repayQ = db.selectFrom('credit_repayments as r').innerJoin('credit_bills as b', 'b.id', 'r.bill_id').innerJoin('orders as o', 'o.id', 'b.order_id').select(['r.method', 'r.amount_paise'])
    .where(sql<boolean>`(r.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`);
  if (range.locationId) repayQ = repayQ.where('o.location_id', '=', range.locationId);
  if (scope) repayQ = repayQ.where('o.location_id', 'in', scope);
  const repaymentsPaise = (await repayQ.execute()).reduce((n, x) => n + x.amount_paise, 0);
  const group = (key: 'cashier' | 'location') => Object.values(sales.reduce<Record<string, { name: string; count: number; amountPaise: number; voided: number }>>((acc, s) => {
    const k = s[key] ?? '—'; const g = acc[k] ??= { name: k, count: 0, amountPaise: 0, voided: 0 };
    if (s.status === 'cancelled') g.voided++; else { g.count++; g.amountPaise += s.total_paise; }
    return acc;
  }, {})).sort((a, b) => b.amountPaise - a.amountPaise);
  const voidRefunds = refunds.filter(r => r.reference?.startsWith('VOID ')).reduce((n, r) => n + r.amount_paise, 0);
  const returnRefunds = refunds.filter(r => !r.reference?.startsWith('VOID ')).reduce((n, r) => n + r.amount_paise, 0);
  const grossPaise = sum(sales);
  return {
    range, transactions: sales.length, voided: sales.filter(s => s.status === 'cancelled').length, grossPaise,
    discountPaise: sales.filter(s => s.status !== 'cancelled').reduce((n, s) => n + s.discount_paise, 0),
    taxPaise: sales.filter(s => s.status !== 'cancelled').reduce((n, s) => n + s.tax_paise, 0),
    voidRefundsPaise: voidRefunds, returnRefundsPaise: returnRefunds, netPaise: grossPaise - voidRefunds - returnRefunds,
    methods, byCashier: group('cashier'), byLocation: group('location'),
    // not money received at the sale: reported apart from the payment methods above
    moneyReceivedPaise: methods.reduce((n, m) => n + m.amountPaise, 0), storeCreditPaise, exchangeValuePaise, onCreditPaise, repaymentsPaise,
  };
}

// ---------------------------------------------------------------- customers at the counter
/** What the counter shows about a chosen customer (2026-10-13): their latest orders from the website and from every branch,
    open returns, and three separate balances: loyalty points, store credit (the shop owes them), credit owed (they owe the
    shop). Each part appears only when the staff member's role may see it. Never more than the latest ten orders. */
export async function posCustomerProfile(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'pos.access');
  const c = await db.selectFrom('customers').select(['id', 'email', 'full_name', 'phone', 'status', 'created_at']).where('id', '=', customerId).executeTakeFirst();
  if (!c) throw new NotFoundError('Customer not found.');
  const seeOrders = can(actor, 'orders.read'), seeReturns = can(actor, 'returns.read');
  const [orders, counts, returns, points, storeCreditPaise, credit] = await Promise.all([
    seeOrders ? db.selectFrom('orders as o').leftJoin('locations as l', 'l.id', 'o.location_id')
      .select(['o.id', 'o.order_number', 'o.pos_number', 'o.channel', 'o.created_at', 'o.total_paise', 'o.status', 'o.payment_status', 'o.payment_method', 'l.name as location_name'])
      .where('o.customer_id', '=', c.id).orderBy('o.created_at', 'desc').limit(10).execute() : Promise.resolve(null),
    seeOrders ? db.selectFrom('orders').select([sql<number>`count(*) filter (where channel = 'online')::int`.as('online'), sql<number>`count(*) filter (where channel = 'retail')::int`.as('retail')]).where('customer_id', '=', c.id).executeTakeFirstOrThrow() : Promise.resolve(null),
    seeReturns ? db.selectFrom('return_requests as r').innerJoin('orders as o', 'o.id', 'r.order_id').select(['r.id', 'r.number', 'r.status', 'r.resolution', 'r.requested_at', 'o.order_number', 'o.pos_number'])
      .where('r.customer_id', '=', c.id).where('r.status', 'not in', ['completed', 'cancelled', 'rejected']).orderBy('r.requested_at', 'desc').limit(10).execute() : Promise.resolve(null),
    loyaltyBalance(db, c.id), storeCreditBalance(db, c.id), getCustomerCredit(db, actor, c.id),
  ]);
  const open = credit.bills.filter(b => b.status === 'open');
  return { customer: c, orders, counts, returns, points, storeCreditPaise,
    credit: { account: credit.account, availablePaise: credit.availablePaise, owedPaise: credit.account?.outstanding_paise ?? 0, openBills: open, nextDueOn: open.length ? open.map(b => String(b.due_on)).sort()[0]! : null },
    can: { storeCredit: can(actor, 'store_credit.redeem'), creditSale: can(actor, 'pos.credit_sell'), repay: can(actor, 'credit.repay') } };
}

/** Find an order from the counter (2026-10-13): by order number, POS bill number, the customer's phone or email. Website and
    branch orders alike. Needs orders.read as well as POS access; at most 20, newest first. */
export async function findPosOrders(db: Db, actor: StaffPrincipal, term: string) {
  requirePermission(actor, 'pos.access'); requirePermission(actor, 'orders.read');
  const t = term.trim();
  if (t.length < 3) return [];
  const low = t.toLowerCase(), digits = t.replace(/\D/g, ''), like = `%${low.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
  const rows = await db.selectFrom('orders as o').leftJoin('locations as l', 'l.id', 'o.location_id').leftJoin('customers as c', 'c.id', 'o.customer_id')
    .select(['o.id', 'o.order_number', 'o.pos_number', 'o.channel', 'o.created_at', 'o.total_paise', 'o.status', 'o.payment_status', 'o.payment_method', 'l.name as location_name',
      'c.full_name as customer_name', sql<string | null>`o.contact->>'name'`.as('contact_name'),
      sql<number>`(select count(*) from public.return_requests r where r.order_id = o.id and r.status not in ('rejected', 'cancelled'))::int`.as('returns')])
    .where(eb => eb.or([sql<boolean>`lower(o.order_number) like ${like}`, sql<boolean>`lower(coalesce(o.pos_number, '')) like ${like}`, sql<boolean>`lower(coalesce(c.email, '')) = ${low}`, sql<boolean>`lower(coalesce(o.contact->>'email', '')) = ${low}`,
      ...(digits.length >= 6 ? [sql<boolean>`regexp_replace(coalesce(o.contact->>'phone', ''), '\D', '', 'g') like ${'%' + digits}`, sql<boolean>`regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like ${'%' + digits}`] : []),
      ...(uuid ? [eb('o.customer_id', '=', t), eb('o.id', '=', t)] : [])]))
    .orderBy('o.created_at', 'desc').limit(20).execute();
  return rows;
}
export async function findPosCustomers(db: Db, actor: StaffPrincipal, term: string) {
  requirePermission(actor, 'pos.access');
  const t = term.trim().toLowerCase();
  if (t.length < 3) return [];
  const like = `%${t.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const digits = t.replace(/\D/g, '');
  return db.selectFrom('customers').select(['id', 'email', 'full_name', 'phone']).where('status', '=', 'active')
    .where(eb => eb.or([sql<boolean>`lower(email) like ${like}`, sql<boolean>`lower(coalesce(full_name, '')) like ${like}`,
      ...(digits.length >= 4 ? [sql<boolean>`regexp_replace(coalesce(phone, ''), '\\D', '', 'g') like ${'%' + digits + '%'}`] : [])]))
    .orderBy('full_name').limit(10).execute();
}

/** Sets or clears the barcode of a size (products.write). */
export async function setVariantBarcode(db: Db, actor: StaffPrincipal, input: { variantId: string; barcode: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  const code = input.barcode?.trim() || null;
  if (code && !/^[0-9A-Za-z-]{4,64}$/.test(code)) throw new DomainError('invalid', 'A barcode is 4–64 letters, digits or dashes.');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('product_variants').select(['id', 'sku', 'barcode']).where('id', '=', input.variantId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    try { await tx.updateTable('product_variants').set({ barcode: code }).where('id', '=', v.id).execute(); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError('Another size already uses this barcode.'); throw e; }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'variant.barcode', entityType: 'product_variants', entityId: v.id, before: { barcode: v.barcode }, after: { barcode: code }, metadata: { sku: v.sku } });
  });
}
