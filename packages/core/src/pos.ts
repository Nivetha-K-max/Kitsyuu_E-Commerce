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
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError, MAX_QTY_PER_LINE } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { priceOrder, type CartTotals } from './pricing.ts';
import { lineLabel, pricedLine, variantQuery, type PricedLine } from './cart.ts';
import { checkStaffDiscount, inStore, staffDiscountMaxBp, staffRule } from './draft-orders.ts';
import { earnForOrder } from './loyalty.ts';
import { markPaymentRefunded } from './returns.ts';
import type { MutationContext } from './staff.ts';

export const POS_PAYMENT_METHODS = ['cash', 'card', 'upi'] as const;
export type PosPaymentMethod = typeof POS_PAYMENT_METHODS[number];
const METHOD_LABEL: Record<PosPaymentMethod, string> = { cash: 'Cash', card: 'Card', upi: 'UPI' };
const auditCtx = (c: MutationContext) => ({ ip: c.ip ?? null, userAgent: c.userAgent ?? null, requestId: c.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const inr = (paise: number) => `${paise < 0 ? '−' : ''}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- the counter: branches, session, limits
/** What the POS screen needs: the branches, the cashier's open session, the discount limit and what this staff member may do. */
export async function posContext(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'pos.access');
  const [locations, session, maxDiscountBp] = await Promise.all([
    db.selectFrom('locations').select(['id', 'code', 'name', 'address']).where('is_online', '=', false).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
    openSessionOf(db, actor.staffId),
    staffDiscountMaxBp(db),
  ]);
  return { locations, session, maxDiscountBp, methods: POS_PAYMENT_METHODS.map(m => ({ code: m, label: METHOD_LABEL[m] })),
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
  const valid = sales.filter(x => x.status !== 'cancelled');
  return {
    session: s, transactions: sales.length, voidedTransactions: sales.length - valid.length,
    grossPaise: sales.reduce((n, x) => n + x.total_paise, 0), discountPaise: valid.reduce((n, x) => n + x.discount_paise, 0),
    netPaise: sales.reduce((n, x) => n + x.total_paise, 0) - voids.reduce((n, x) => n + x.n, 0), byMethod,
    cashSalesPaise: byMethod.cash.amountPaise - byMethod.cash.voidedPaise,
    expectedCashPaise: s.opening_cash_paise + byMethod.cash.amountPaise - byMethod.cash.voidedPaise,
  };
}

export async function closePosSession(db: Db, actor: StaffPrincipal, input: { sessionId: string; countedCashPaise: number; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'pos.sell');
  if (!Number.isInteger(input.countedCashPaise) || input.countedCashPaise < 0) throw new DomainError('invalid', 'Enter the cash counted in the drawer.');
  return db.transaction().execute(async tx => {
    const s = await tx.selectFrom('pos_sessions').selectAll().where('id', '=', input.sessionId).forUpdate().executeTakeFirst();
    if (!s) throw new NotFoundError('Session not found.');
    if (s.staff_id !== actor.staffId && !can(actor, 'pos.reports')) throw new ForbiddenError('Only the cashier of this session or a manager can close it.');
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
  return q.execute();
}

// ---------------------------------------------------------------- product search
export type PosVariant = { variantId: string; sku: string; barcode: string | null; size: string; colour: string | null; colourLabel: string | null; unitPaise: number; stock: number };
export type PosProduct = { productId: string; name: string; imagePath: string | null; variants: PosVariant[] };

/** Products by name, SKU (or SKU prefix) or barcode, with each size's price and the stock AT THIS BRANCH. An exact barcode
    or SKU match returns just that size (a scan adds it straight to the bill). */
export async function searchPosProducts(db: Db, actor: StaffPrincipal, input: { locationId: string; q: string }): Promise<{ exact: PosVariant & { productId: string; name: string } | null; products: PosProduct[] }> {
  requirePermission(actor, 'pos.access');
  const term = input.q.trim().slice(0, 80);
  if (!term) return { exact: null, products: [] };
  const like = `${term.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`;
  const word = `%${term.toLowerCase().replace(/[%_\\]/g, m => '\\' + m)}%`;
  const rows = await variantQuery(db).leftJoin('location_stock as ls', join => join.onRef('ls.variant_id', '=', 'v.id').on('ls.location_id', '=', input.locationId))
    .select(['v.barcode', sql<number>`coalesce(ls.qty, 0)::int`.as('branch_qty'), 'v.sort_order'])
    .where('v.is_active', '=', true)
    .where(eb => eb.or([eb('v.barcode', '=', term), sql<boolean>`lower(v.sku) like ${like}`, sql<boolean>`lower(p.sku) like ${like}`, sql<boolean>`lower(p.name) like ${word}`]))
    .orderBy('p.name').orderBy('v.colour_slug').orderBy('v.sort_order').limit(200).execute();
  const toVariant = (r: typeof rows[number]): PosVariant => ({ variantId: r.variant_id, sku: r.sku, barcode: r.barcode, size: r.size, colour: r.colour_slug,
    colourLabel: r.colour_slug ? (r.colour_label ?? r.colour_slug) : null, unitPaise: r.unit_paise, stock: r.branch_qty });
  const hit = rows.find(r => r.barcode === term) ?? rows.find(r => r.sku.toLowerCase() === term.toLowerCase());
  const products = new Map<string, PosProduct>();
  for (const r of rows) {
    const p = products.get(r.product_id) ?? { productId: r.product_id, name: r.name, imagePath: r.image_path, variants: [] };
    p.variants.push(toVariant(r));
    products.set(r.product_id, p);
  }
  return { exact: hit ? { ...toVariant(hit), productId: hit.product_id, name: hit.name } : null, products: [...products.values()].slice(0, 30) };
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
async function priceBill(q: Queryable, locationId: string, input: { lines: PosLineInput[]; customerId?: string | null; discount: PosDiscountInput }) {
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
  const totals: CartTotals = await priceOrder(q, priced, {
    config: { shipping: inStore, discounts: bp ? [staffRule(bp, input.discount?.reason ?? '')] : [] },
    customerId: input.customerId ?? null, shipTo: null, payment: null,
  });
  return { lines: priced, totals, discountBp: bp };
}

/** The bill as the counter shows it (always priced on the server: price, sale price, discount limits, tax, branch stock). */
export async function quotePosSale(db: Db, actor: StaffPrincipal, input: { locationId: string; lines: PosLineInput[]; customerId?: string | null; discount: PosDiscountInput }) {
  requirePermission(actor, 'pos.access');
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
  payment: { method: PosPaymentMethod; tenderedPaise?: number | null; reference?: string | null };
  /** The total the cashier showed the customer; the sale is refused if the server's total differs. */
  expectedTotalPaise: number;
}

export async function completePosSale(db: Db, actor: StaffPrincipal, input: PosSaleInput, ctx: MutationContext)
  : Promise<{ orderId: string; orderNumber: string; posNumber: string; totalPaise: number; changePaise: number; replay: boolean }> {
  requirePermission(actor, 'pos.sell');
  if (!/^[A-Za-z0-9_-]{16,60}$/.test(input.idempotencyKey ?? '')) throw new DomainError('invalid', 'Missing sale key: reload the POS screen.');
  if (!(POS_PAYMENT_METHODS as readonly string[]).includes(input.payment?.method)) throw new DomainError('invalid', 'Choose the payment method: cash, card or UPI.');
  const discount = input.discount && input.discount.percent > 0 ? input.discount : null;
  if (discount) {
    requirePermission(actor, 'orders.discount');
    if (!discount.reason || discount.reason.trim().length < 3) throw new DomainError('invalid', 'Enter the reason for the discount.');
  }
  const reference = input.payment.reference?.trim() || null;
  if (input.payment.method !== 'cash' && (!reference || !/^[A-Za-z0-9 /_-]{4,64}$/.test(reference)))
    throw new DomainError('invalid', `Enter the ${input.payment.method === 'upi' ? 'UPI transaction reference (UTR)' : 'card approval / transaction reference'} shown when the payment succeeded.`);
  const key = `pos-${input.idempotencyKey}`.slice(0, 64);
  try {
    return await db.transaction().execute(async tx => {
      // The session row is locked for the whole sale: sales of one till are one at a time, and a double-submitted bill
      // finds the first one (idempotency key) instead of charging twice.
      const s = await tx.selectFrom('pos_sessions as s').innerJoin('locations as l', 'l.id', 's.location_id')
        .select(['s.id', 's.number', 's.status', 's.staff_id', 's.location_id', 'l.name as location_name', 'l.address as location_address', 'l.is_active'])
        .where('s.id', '=', input.sessionId).forUpdate('s').executeTakeFirst();
      if (!s) throw new NotFoundError('Cashier session not found.');
      if (s.staff_id !== actor.staffId) throw new ForbiddenError('This is another cashier’s session: open your own session.');
      if (s.status !== 'open') throw new ConflictError(`Session ${s.number} is closed: open a new session to keep billing.`);
      if (!s.is_active) throw new ConflictError(`${s.location_name} is inactive.`);
      const prior = await tx.selectFrom('orders').select(['id', 'order_number', 'pos_number', 'total_paise', 'pricing']).where('idempotency_key', '=', key).where('channel', '=', 'retail').executeTakeFirst();
      if (prior) return { orderId: prior.id, orderNumber: prior.order_number, posNumber: prior.pos_number!, totalPaise: prior.total_paise,
        changePaise: Number(((prior.pricing ?? {}) as { pos?: { changePaise?: number } }).pos?.changePaise ?? 0), replay: true };

      let contact = { name: input.contact?.name?.trim().slice(0, 120) || null, email: null as string | null, phone: input.contact?.phone?.replace(/[^0-9+]/g, '').slice(0, 15) || null };
      if (input.customerId) {
        const c = await tx.selectFrom('customers').select(['id', 'email', 'full_name', 'phone', 'status']).where('id', '=', input.customerId).executeTakeFirst();
        if (!c) throw new NotFoundError('Customer not found.');
        if (c.status !== 'active') throw new ConflictError('This customer account is disabled.');
        contact = { name: c.full_name, email: c.email, phone: c.phone ?? contact.phone };
      }

      const bill = await priceBill(tx, s.location_id, { lines: input.lines, customerId: input.customerId ?? null, discount });
      const bad = bill.lines.find(l => l.problem);
      if (bad) throw new ConflictError(bad.problem === 'unavailable' ? `${lineLabel(bad)} is not offered.` : `Only ${bad.branchStock} of ${lineLabel(bad)} ${bad.branchStock === 1 ? 'is' : 'are'} in stock at ${s.location_name}.`);
      const t = bill.totals;
      if (t.totalPaise !== input.expectedTotalPaise) throw new ConflictError(`The total changed to ${inr(t.totalPaise)} (prices or stock changed). Check the bill and take payment again.`);
      let changePaise = 0, tenderedPaise: number | null = null;
      if (input.payment.method === 'cash') {
        tenderedPaise = Number(input.payment.tenderedPaise);
        if (!Number.isInteger(tenderedPaise) || tenderedPaise < t.totalPaise) throw new DomainError('invalid', `Enter the cash received: at least ${inr(t.totalPaise)}.`);
        changePaise = tenderedPaise - t.totalPaise;
      }
      const staffDiscount = t.discounts.find(x => x.code === 'STAFF')?.amountPaise ?? 0;
      const posNumber = (await sql<{ n: string }>`select public.next_document_number('pos_sale', 'POS') as n`.execute(tx)).rows[0].n;
      const pos = { number: posNumber, session: s.number, cashier: actor.email, method: input.payment.method, reference, tenderedPaise, changePaise };

      const order = await tx.insertInto('orders').values({
        customer_id: input.customerId ?? null, cart_id: null, idempotency_key: key,
        status: 'delivered', payment_status: 'paid', currency: 'INR',
        subtotal_paise: t.subtotalPaise, discount_paise: t.discountPaise, shipping_paise: t.shippingPaise, tax_paise: t.taxPaise,
        total_paise: t.totalPaise, prices_include_tax: t.pricesIncludeTax,
        pricing: JSON.stringify({ tax: t.tax, shipping: t.shipping, discounts: t.discounts, source: { pos: posNumber }, pos }),
        payment_method: input.payment.method, cod_status: null, cod_fee_paise: 0,
        contact: JSON.stringify(contact),
        // A counter sale has no delivery: its address is the branch (shown on bills and invoices as the place of sale).
        shipping_address: JSON.stringify({ name: contact.name ?? 'Walk-in customer', phone: contact.phone, line1: s.location_name, line2: s.location_address, city: '', state: '', pin: '', country: 'India' }),
        billing_address: null,
        channel: 'retail', location_id: s.location_id, created_by: actor.staffId, draft_order_id: null,
        pos_session_id: s.id, pos_number: posNumber,
        staff_discount_paise: staffDiscount, staff_discount_bp: staffDiscount ? bill.discountBp : null,
        staff_discount_reason: staffDiscount ? discount!.reason!.trim().slice(0, 200) : null, staff_discount_by: staffDiscount ? actor.staffId : null,
        paid_at: sql<Date>`now()`, payment_expires_at: null,
      }).returning(['id', 'order_number']).executeTakeFirstOrThrow();
      await tx.insertInto('order_items').values(bill.lines.map(l => ({
        order_id: order.id, product_id: l.productId, variant_id: l.variantId, sku: l.sku, name: l.name, size: l.size, colour: l.colourLabel,
        image_path: l.imagePath, unit_price_paise: l.unitPaise, qty: l.qty, line_total_paise: l.lineTotalPaise,
      }))).execute();
      await tx.insertInto('order_status_history').values([
        { order_id: order.id, from_status: null, to_status: 'paid', note: `POS ${posNumber}: paid by ${METHOD_LABEL[input.payment.method]}${reference ? ` (ref ${reference})` : ''} at ${s.location_name}, cashier ${actor.email}` },
        { order_id: order.id, from_status: 'paid', to_status: 'delivered', note: `Handed over at the counter, ${s.location_name}` },
      ]).execute();
      // Stock from THIS branch only, through the ledger (reason retail_sale, linked to the order; never below zero).
      await sql`select public.sell_order_at_location(${order.id}::uuid, ${actor.staffId}::uuid)`.execute(tx);
      await tx.insertInto('payments').values({
        order_id: order.id, provider: 'pos', provider_order_id: s.number, provider_payment_id: posNumber, amount_paise: t.totalPaise, currency: 'INR',
        status: 'captured', method: input.payment.method, captured_at: sql<Date>`now()`,
        raw: JSON.stringify({ reference, tendered_paise: tenderedPaise, change_paise: changePaise, cashier_id: actor.staffId, session: s.number, location_id: s.location_id }),
      }).execute();
      if (input.customerId) { await earnForOrder(tx, order.id, 'paid'); await earnForOrder(tx, order.id, 'delivered'); }
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.sale', entityType: 'orders', entityId: order.id,
        after: { pos_number: posNumber, order_number: order.order_number, location_id: s.location_id, payment_method: input.payment.method, total_paise: t.totalPaise,
          staff_discount_paise: staffDiscount, customer_id: input.customerId ?? null },
        metadata: { session: s.number, reference, units: t.units, ...(staffDiscount ? { discount_bp: bill.discountBp, discount_reason: discount!.reason } : {}) } });
      return { orderId: order.id, orderNumber: order.order_number, posNumber, totalPaise: t.totalPaise, changePaise, replay: false };
    });
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
      'o.shipping_paise', 'o.total_paise', 'o.prices_include_tax', 'o.pricing', 'o.contact', 'o.staff_discount_bp', 'o.staff_discount_reason', 'o.customer_id',
      'l.name as location_name', 'l.address as location_address', 'l.code as location_code', 'u.email as cashier_email', 'u.full_name as cashier_name',
      's.number as session_number', 's.status as session_status', 's.staff_id as session_staff_id', 'c.email as customer_email', 'c.full_name as customer_name'])
    .where('o.id', '=', orderId).executeTakeFirst();
  if (!o || !o.pos_number) throw new NotFoundError('POS sale not found.');
  const [items, payment, invoice, returns] = await Promise.all([
    db.selectFrom('order_items').select(['id', 'name', 'sku', 'size', 'colour', 'qty', 'unit_price_paise', 'line_total_paise']).where('order_id', '=', o.id).orderBy('name').execute(),
    db.selectFrom('payments').select(['id', 'method', 'amount_paise', 'status', 'raw', 'captured_at']).where('order_id', '=', o.id).where('provider', '=', 'pos').executeTakeFirst(),
    db.selectFrom('invoices').select(['id', 'invoice_number']).where('order_id', '=', o.id).where('status', '=', 'issued').executeTakeFirst(),
    db.selectFrom('return_requests').select(['id', 'number', 'status']).where('order_id', '=', o.id).execute(),
  ]);
  const pricing = (o.pricing ?? {}) as { tax?: { configured?: boolean; label?: string; rateBp?: number; inclusive?: boolean }; pos?: { reference?: string | null; tenderedPaise?: number | null; changePaise?: number } };
  return { sale: o, items, payment, invoice: invoice ?? null, returns, tax: pricing.tax ?? null, pos: pricing.pos ?? null,
    canVoid: can(actor, 'pos.void') && o.status !== 'cancelled' && o.session_status === 'open' && !returns.some(r => !['rejected', 'cancelled'].includes(r.status)) };
}

export async function listPosSales(db: Db, actor: StaffPrincipal, opts: { sessionId?: string; limit?: number } = {}) {
  requirePermission(actor, 'pos.access');
  let q = db.selectFrom('orders as o').innerJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as u', 'u.id', 'o.created_by')
    .select(['o.id', 'o.order_number', 'o.pos_number', 'o.status', 'o.payment_method', 'o.total_paise', 'o.created_at', 'o.contact', 'l.name as location_name', 'u.email as cashier_email'])
    .where('o.pos_number', 'is not', null).orderBy('o.created_at', 'desc').limit(opts.limit ?? 50);
  if (opts.sessionId) q = q.where('o.pos_session_id', '=', opts.sessionId);
  if (!can(actor, 'pos.reports')) q = q.where('o.created_by', '=', actor.staffId);
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
    const o = await tx.selectFrom('orders as o').innerJoin('pos_sessions as s', 's.id', 'o.pos_session_id')
      .select(['o.id', 'o.order_number', 'o.pos_number', 'o.status', 'o.location_id', 'o.total_paise', 's.status as session_status', 's.number as session_number'])
      .where('o.id', '=', input.orderId).forUpdate('o').executeTakeFirst();
    if (!o || !o.pos_number) throw new NotFoundError('POS sale not found.');
    if (o.status === 'cancelled') throw new ConflictError(`${o.pos_number} is already voided.`);
    if (o.session_status !== 'open') throw new ConflictError(`Session ${o.session_number} is closed: a sale from a closed session is returned through Returns & refunds.`);
    const openReturn = await tx.selectFrom('return_requests').select('number').where('order_id', '=', o.id).where('status', 'not in', ['rejected', 'cancelled']).executeTakeFirst();
    if (openReturn) throw new ConflictError(`${o.pos_number} has return ${openReturn.number}: continue it in Returns & refunds.`);
    const items = await tx.selectFrom('order_items').select(['variant_id', sql<number>`sum(qty)::int`.as('qty')]).where('order_id', '=', o.id).where('variant_id', 'is not', null)
      .groupBy('variant_id').orderBy('variant_id').execute();
    for (const it of items) {
      await sql`select public.order_stock_at_location(${o.id}::uuid, ${it.variant_id}::uuid, ${it.qty}::int, 'pos_void', ${actor.staffId}::uuid, ${`Void ${o.pos_number}`}::text)`.execute(tx);
    }
    const pay = await tx.selectFrom('payments').select(['id', 'amount_paise']).where('order_id', '=', o.id).where('provider', '=', 'pos').where('status', '=', 'captured').executeTakeFirst();
    if (pay) {
      await tx.insertInto('refunds').values({ payment_id: pay.id, order_id: o.id, amount_paise: pay.amount_paise, reason: `POS void: ${reason}`.slice(0, 500), status: 'processed',
        method: 'manual', reference: `VOID ${o.pos_number}`, requested_by: actor.staffId, processed_at: sql<Date>`now()`, processed_by: actor.staffId } as never).execute();
      await markPaymentRefunded(tx, o.id, pay.id);
    }
    await tx.updateTable('orders').set({ status: 'cancelled' }).where('id', '=', o.id).execute();
    await tx.insertInto('order_status_history').values({ order_id: o.id, from_status: o.status, to_status: 'cancelled', note: `POS sale voided by ${actor.email}: ${reason}`.slice(0, 1000) }).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'pos.void', entityType: 'orders', entityId: o.id, before: { status: o.status }, after: { status: 'cancelled', payment_status: 'refunded' },
      metadata: { pos_number: o.pos_number, reason, total_paise: o.total_paise, units: items.reduce((n, i) => n + i.qty, 0) } });
    return { posNumber: o.pos_number, refundedPaise: pay?.amount_paise ?? 0 };
  });
}

// ---------------------------------------------------------------- report
/** POS sales between two dates (India time, inclusive): totals, payment methods, discounts, voids and refunds, by cashier and by branch. */
export async function posReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string; locationId?: string | null }) {
  requirePermission(actor, 'pos.reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.from > range.to) throw new DomainError('invalid', 'Choose a valid date range.');
  const inRange = sql<boolean>`(o.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`;
  let base = db.selectFrom('orders as o').innerJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as u', 'u.id', 'o.created_by')
    .where('o.pos_number', 'is not', null).where(inRange);
  if (range.locationId) base = base.where('o.location_id', '=', range.locationId);
  const sales = await base.select(['o.id', 'o.status', 'o.payment_method', 'o.subtotal_paise', 'o.discount_paise', 'o.tax_paise', 'o.total_paise', 'l.name as location', 'u.email as cashier']).execute();
  let refundQ = db.selectFrom('refunds as r').innerJoin('orders as o', 'o.id', 'r.order_id')
    .select(['r.amount_paise', 'r.reference', 'o.payment_method']).where('o.pos_number', 'is not', null).where('r.status', '=', 'processed')
    .where(sql<boolean>`(r.processed_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`);
  if (range.locationId) refundQ = refundQ.where('o.location_id', '=', range.locationId);
  const refunds = await refundQ.execute();
  const sum = (xs: { total_paise: number }[]) => xs.reduce((n, x) => n + x.total_paise, 0);
  const methods = POS_PAYMENT_METHODS.map(m => { const xs = sales.filter(s => s.payment_method === m); return { method: m, label: METHOD_LABEL[m], count: xs.length, amountPaise: sum(xs) }; });
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
  };
}

// ---------------------------------------------------------------- customers at the counter
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
