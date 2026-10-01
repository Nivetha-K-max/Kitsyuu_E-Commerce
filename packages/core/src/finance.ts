/* ERP module 6: finance and accounting.
   GST rules are the business's decision: rates are data staff enter (tax_rates), products can be mapped to a rate, and the
   company's registered state (company.state) decides the invoice split (CGST + SGST within the state, IGST outside it;
   "not set" when the state is missing — the invoice then says so instead of guessing).
   An invoice is built from an order exactly as it was charged: its tax must equal the tax the order was charged (the rate
   snapshot stored on the order); if product mappings would give a different amount, the invoice is refused with the
   reason, so an invoice never disagrees with the payment. Numbers are gap-free per financial year (next_document_number).
   Credit / debit notes adjust an issued invoice. Expenses and vendor payments are entered by staff.
   Reconciliation compares the platform's own records (orders marked paid, captured payments, refunds). It does NOT see
   bank or provider settlements (no settlement import exists), so it never claims the books are reconciled with the bank. */
import { recordAudit, sql, type Db, type Queryable } from "@kitsyuu/db";
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { companyDetails } from './settings.ts';
import { checkRange, csvCell, type ReportRange } from './reports.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const SOLD = ['paid', 'processing', 'shipped', 'delivered'] as const;
const inRange = (col: string, r: ReportRange) => sql<boolean>`(${sql.ref(col)} at time zone 'Asia/Kolkata')::date between ${r.from}::date and ${r.to}::date`;
const dateRange = (col: string, r: ReportRange) => sql<boolean>`${sql.ref(col)} between ${r.from}::date and ${r.to}::date`;

// ---------------------------------------------------------------- tax rates
export async function listTaxRates(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'finance.read');
  return db.selectFrom('tax_rates as t').select(['t.id', 't.code', 't.label', 't.rate_bp', 't.is_inclusive', 't.is_active', 't.valid_from', 't.valid_to',
    sql<number>`(select count(*)::int from public.products p where p.tax_rate_code = t.code)`.as('products')]).orderBy('t.valid_from', 'desc').orderBy('t.code').execute();
}

export async function saveTaxRate(db: Db, actor: StaffPrincipal,
  input: { rateId?: string; code: string; label: string; ratePercent: number; inclusive: boolean; validFrom: string; validTo: string | null; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  const row = { code: input.code, label: input.label, rate_bp: input.ratePercent, is_inclusive: input.inclusive, valid_from: input.validFrom as unknown as Date,
    valid_to: input.validTo as unknown as Date | null, is_active: input.active };
  return db.transaction().execute(async tx => {
    const clash = await tx.selectFrom('tax_rates').select('id').where('code', '=', input.code).executeTakeFirst();
    if (clash && clash.id !== input.rateId) throw new ConflictError(`The code ${input.code} is already used.`);
    if (!input.rateId) {
      const t = await tx.insertInto('tax_rates').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'tax_rate.create', entityType: 'tax_rates', entityId: t.id, after: row });
      return { id: t.id };
    }
    const before = await tx.selectFrom('tax_rates').select(['code', 'label', 'rate_bp', 'is_inclusive', 'valid_from', 'valid_to', 'is_active']).where('id', '=', input.rateId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Tax rate not found.');
    if (before.code !== input.code && (await tx.selectFrom('products').select('id').where('tax_rate_code', '=', before.code).executeTakeFirst()))
      throw new ConflictError('Products are mapped to this rate, so its code cannot change.');
    await tx.updateTable('tax_rates').set(row).where('id', '=', input.rateId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'tax_rate.update', entityType: 'tax_rates', entityId: input.rateId, before, after: row });
    return { id: input.rateId };
  });
}

export async function listProductTax(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'finance.read');
  return db.selectFrom('products').select(['id', 'sku', 'name', 'hsn_code', 'tax_rate_code', 'status']).orderBy('name').execute();
}

export async function setProductTax(db: Db, actor: StaffPrincipal, input: { productId: string; taxRateCode: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  await db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select('tax_rate_code').where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    if (input.taxRateCode && !(await tx.selectFrom('tax_rates').select('id').where('code', '=', input.taxRateCode).executeTakeFirst())) throw new NotFoundError('Tax rate not found.');
    if (p.tax_rate_code === input.taxRateCode) return;
    await tx.updateTable('products').set({ tax_rate_code: input.taxRateCode }).where('id', '=', input.productId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'product.tax_map', entityType: 'products', entityId: input.productId, before: { tax_rate_code: p.tax_rate_code }, after: { tax_rate_code: input.taxRateCode } });
  });
}

// ---------------------------------------------------------------- invoices
/** The registered state (Settings → Company → Registered state), or null when not set. */
export async function companyState(q: Queryable) {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'company.state').executeTakeFirst();
  return typeof r?.value === 'string' && r.value ? r.value : null;
}
async function docPrefix(q: Queryable, suffix = '') {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'billing.invoice_prefix').executeTakeFirst();
  const base = typeof r?.value === 'string' && /^[A-Z0-9-]{1,4}$/.test(r.value) ? r.value : 'KTS';
  return (base + suffix).slice(0, 6);
}

/** Tax of one line under a rate (basis points; inclusive = already inside the price). */
const lineTax = (amount: number, bp: number, inclusive: boolean) => (inclusive ? Math.round(amount * bp / (10_000 + bp)) : Math.round(amount * bp / 10_000));

/** Splits tax by place of supply: CGST + SGST within the registered state, IGST outside; unknown without the state. */
export function taxSplit(taxPaise: number, sellerState: string | null, placeOfSupply: string | null) {
  if (!sellerState || !placeOfSupply) return { type: 'unknown' as const, cgst: 0, sgst: 0, igst: 0, note: 'Registered state or delivery state missing: GST type not determined.' };
  if (sellerState.toLowerCase() === placeOfSupply.toLowerCase()) { const c = Math.floor(taxPaise / 2); return { type: 'intra' as const, cgst: c, sgst: taxPaise - c, igst: 0, note: null }; }
  return { type: 'inter' as const, cgst: 0, sgst: 0, igst: taxPaise, note: null };
}

export async function listInvoices(db: Db, actor: StaffPrincipal, query: { q?: string; status?: string; page: number }) {
  requirePermission(actor, 'finance.read');
  let q = db.selectFrom('invoices as i').leftJoin('orders as o', 'o.id', 'i.order_id')
    .select(['i.id', 'i.invoice_number', 'i.status', 'i.issued_at', 'i.total_paise', 'i.tax_paise', 'i.place_of_supply', 'o.order_number', 'o.id as order_id']);
  if (query.status && query.status !== 'all') q = q.where('i.status', '=', query.status as 'issued');
  if (query.q) { const l = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('i.invoice_number', 'ilike', l), eb('o.order_number', 'ilike', l)])); }
  const rows = await q.orderBy('i.created_at', 'desc').limit(41).offset((query.page - 1) * 40).execute();
  return { rows: rows.slice(0, 40), hasNext: rows.length > 40 };
}

/** Orders that were paid and have no current (issued) invoice. */
export async function ordersWithoutInvoice(db: Db, actor: StaffPrincipal, limit = 50) {
  requirePermission(actor, 'finance.read');
  return db.selectFrom('orders as o').select(['o.id', 'o.order_number', 'o.status', 'o.total_paise', 'o.created_at'])
    .where('o.status', 'in', [...SOLD]).where(eb => eb.not(eb.exists(eb.selectFrom('invoices as i').select('i.id').whereRef('i.order_id', '=', 'o.id').where('i.status', '=', 'issued'))))
    .orderBy('o.created_at', 'desc').limit(limit).execute();
}

export async function createInvoiceForOrder(db: Db, actor: StaffPrincipal, input: { orderId: string }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  return db.transaction().execute(async tx => {
    const o = await tx.selectFrom('orders').select(['id', 'order_number', 'status', 'customer_id', 'subtotal_paise', 'discount_paise', 'shipping_paise', 'tax_paise', 'total_paise',
      'prices_include_tax', 'pricing', 'contact', 'shipping_address', 'billing_address', 'created_at']).where('id', '=', input.orderId).forUpdate().executeTakeFirst();
    if (!o) throw new NotFoundError('Order not found.');
    if (!(SOLD as readonly string[]).includes(o.status)) throw new ConflictError('An invoice can be issued for a paid order only.');
    if (await tx.selectFrom('invoices').select('id').where('order_id', '=', o.id).where('status', '=', 'issued').executeTakeFirst()) throw new ConflictError('This order already has an invoice. Void it first to issue a new one.');
    const items = await tx.selectFrom('order_items as i').leftJoin('products as p', 'p.id', 'i.product_id').leftJoin('tax_rates as t', 't.code', 'p.tax_rate_code')
      .select(['i.id', 'i.name', 'i.size', 'i.colour', 'i.sku', 'i.qty', 'i.unit_price_paise', 'i.line_total_paise', 'p.hsn_code', 't.id as rate_id', 't.rate_bp', 't.is_inclusive'])
      .where('i.order_id', '=', o.id).orderBy('i.name').execute();
    const snap = ((o.pricing ?? {}) as { tax?: { configured?: boolean; code?: string; rateBp?: number; inclusive?: boolean } }).tax;
    const orderRate = snap?.configured ? await tx.selectFrom('tax_rates').select(['id', 'rate_bp', 'is_inclusive']).where('code', '=', snap.code ?? '').executeTakeFirst() : undefined;
    const fallback = { id: orderRate?.id ?? null, bp: snap?.rateBp ?? 0, inclusive: snap?.inclusive ?? o.prices_include_tax };
    // Discounts are spread over the lines in proportion to their value, so each line's tax is on what was actually paid.
    let discountLeft = o.discount_paise;
    const lines = items.map((it, idx) => {
      const share = idx === items.length - 1 ? discountLeft : Math.floor(o.discount_paise * it.line_total_paise / Math.max(1, o.subtotal_paise));
      discountLeft -= share;
      const rate = it.rate_id ? { id: it.rate_id, bp: it.rate_bp!, inclusive: it.is_inclusive! } : fallback;
      return { it, rate, taxable: it.line_total_paise - share, tax: lineTax(it.line_total_paise - share, rate.bp, rate.inclusive) };
    });
    const taxSum = lines.reduce((n, l) => n + l.tax, 0);
    if (Math.abs(taxSum - o.tax_paise) > lines.length) {
      throw new ConflictError(`This order was charged ₹${(o.tax_paise / 100).toFixed(2)} tax, but the products' tax rates would give ₹${(taxSum / 100).toFixed(2)}. `
        + 'An invoice must match what was charged: check the product tax mapping (it applies to invoices of orders placed with those rates).');
    }
    // Rounding: the last line absorbs the (at most a few paise) difference so the invoice tax equals the order tax exactly.
    if (lines.length) lines[lines.length - 1].tax += o.tax_paise - taxSum;
    const ship = (o.shipping_address ?? {}) as Record<string, unknown>;
    const placeOfSupply = typeof ship.state === 'string' ? ship.state : null;
    const seller = await companyDetails(tx);
    const sellerState = await companyState(tx);
    const split = taxSplit(o.tax_paise, sellerState, placeOfSupply);
    const number = (await sql<{ n: string }>`select public.next_document_number('invoice', ${await docPrefix(tx)}, (now() at time zone 'Asia/Kolkata')::date) as n`.execute(tx)).rows[0].n;
    const fy = (await sql<{ fy: string }>`select public.financial_year_of((now() at time zone 'Asia/Kolkata')::date) as fy`.execute(tx)).rows[0].fy;
    const contact = (o.contact ?? {}) as Record<string, unknown>;
    const inv = await tx.insertInto('invoices').values({
      id: sql<string>`gen_random_uuid()` as unknown as string, invoice_number: number, status: 'issued', order_id: o.id, customer_id: o.customer_id, financial_year: fy, issued_at: sql<Date>`now()` as unknown as Date,
      subtotal_paise: o.subtotal_paise, tax_paise: o.tax_paise, total_paise: o.total_paise, prices_include_tax: o.prices_include_tax,
      discount_paise: o.discount_paise, shipping_paise: o.shipping_paise, place_of_supply: placeOfSupply,
      // The billing address the customer gave at checkout, else the delivery address (client change request).
      billing_address: JSON.stringify({ name: contact.name ?? ship.name ?? null, email: contact.email ?? null, phone: contact.phone ?? ship.phone ?? null, ...ship,
        ...((o.billing_address ?? {}) as Record<string, unknown>) }),
      shipping_address: JSON.stringify(ship), seller_details: JSON.stringify({ ...seller, state: sellerState }), tax_split: JSON.stringify(split), created_by: actor.staffId,
    } as never).returning('id').executeTakeFirstOrThrow() as { id: string };
    await tx.insertInto('invoice_items').values(lines.map((l, idx) => ({ invoice_id: inv.id, order_item_id: l.it.id, position: idx, description: `${l.it.name} (${l.it.colour ? `${l.it.colour}, ` : ''}size ${l.it.size})`,
      sku: l.it.sku, hsn_code: l.it.hsn_code, qty: l.it.qty, unit_price_paise: l.it.unit_price_paise, tax_rate_id: l.rate.id, tax_rate_bp: l.rate.bp, tax_paise: Math.max(0, l.tax),
      line_total_paise: l.it.line_total_paise }))).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'invoice.issue', entityType: 'invoices', entityId: inv.id,
      after: { invoice_number: number, total_paise: o.total_paise, tax_paise: o.tax_paise, split: split.type }, metadata: { order_number: o.order_number } });
    return { id: inv.id, number };
  });
}

export async function voidInvoice(db: Db, actor: StaffPrincipal, input: { invoiceId: string; reason: string }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  await db.transaction().execute(async tx => {
    const i = await tx.selectFrom('invoices').select(['status', 'invoice_number']).where('id', '=', input.invoiceId).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundError('Invoice not found.');
    if (i.status !== 'issued') throw new ConflictError('Only an issued invoice can be voided.');
    if (await tx.selectFrom('finance_notes').select('id').where('invoice_id', '=', input.invoiceId).where('status', '=', 'issued').executeTakeFirst())
      throw new ConflictError('This invoice has issued credit or debit notes; void those first.');
    await tx.updateTable('invoices').set({ status: 'void', voided_at: sql<Date>`now()` as unknown as Date, void_reason: input.reason }).where('id', '=', input.invoiceId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'invoice.void', entityType: 'invoices', entityId: input.invoiceId, before: { status: 'issued' }, after: { status: 'void' }, metadata: { number: i.invoice_number, reason: input.reason } });
  });
}

export async function getInvoice(db: Db, actor: StaffPrincipal, invoiceId: string) {
  requirePermission(actor, 'finance.read');
  const inv = await db.selectFrom('invoices as i').leftJoin('orders as o', 'o.id', 'i.order_id')
    .select(['i.id', 'i.invoice_number', 'i.status', 'i.issued_at', 'i.financial_year', 'i.subtotal_paise', 'i.discount_paise', 'i.shipping_paise', 'i.tax_paise', 'i.total_paise',
      'i.prices_include_tax', 'i.place_of_supply', 'i.tax_split', 'i.billing_address', 'i.shipping_address', 'i.seller_details', 'i.void_reason', 'i.voided_at', 'o.order_number', 'o.id as order_id',
      'o.payment_method', 'o.payment_status', 'o.status as order_status', 'o.loyalty_points_used', 'o.loyalty_discount_paise', 'o.contact', 'o.pricing'])
    .where('i.id', '=', invoiceId).executeTakeFirst();
  if (!inv) throw new NotFoundError('Invoice not found.');
  const [items, notes] = await Promise.all([
    db.selectFrom('invoice_items').selectAll().where('invoice_id', '=', invoiceId).orderBy('position').execute(),
    db.selectFrom('finance_notes').select(['id', 'kind', 'number', 'reason', 'amount_paise', 'tax_paise', 'note_date', 'status']).where('invoice_id', '=', invoiceId).orderBy('created_at').execute(),
  ]);
  return { invoice: inv, items, notes };
}

// ---------------------------------------------------------------- credit / debit notes
export async function listFinanceNotes(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'finance.read');
  return db.selectFrom('finance_notes as n').leftJoin('invoices as i', 'i.id', 'n.invoice_id')
    .select(['n.id', 'n.kind', 'n.number', 'n.reason', 'n.amount_paise', 'n.tax_paise', 'n.note_date', 'n.status', 'i.invoice_number', 'i.id as invoice_id']).orderBy('n.created_at', 'desc').limit(200).execute();
}

export async function createFinanceNote(db: Db, actor: StaffPrincipal, input: { kind: 'credit' | 'debit'; invoiceId: string; reason: string; amount: number; tax: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  return db.transaction().execute(async tx => {
    const inv = await tx.selectFrom('invoices').select(['id', 'status', 'order_id', 'total_paise']).where('id', '=', input.invoiceId).forUpdate().executeTakeFirst();
    if (!inv) throw new NotFoundError('Invoice not found.');
    if (inv.status !== 'issued') throw new ConflictError('Notes can be raised against an issued invoice only.');
    if ((input.tax ?? 0) > input.amount) throw new DomainError('invalid', 'The tax part cannot be more than the amount.');
    if (input.kind === 'credit') {
      const credited = await tx.selectFrom('finance_notes').select(sql<number>`coalesce(sum(amount_paise), 0)::int`.as('n')).where('invoice_id', '=', inv.id).where('kind', '=', 'credit').where('status', '!=', 'void').executeTakeFirstOrThrow();
      if (credited.n + input.amount > inv.total_paise) throw new ConflictError(`Credit notes cannot exceed the invoice total (₹${((inv.total_paise - credited.n) / 100).toFixed(2)} left).`);
    }
    const n = await tx.insertInto('finance_notes').values({ kind: input.kind, invoice_id: inv.id, order_id: inv.order_id, reason: input.reason, amount_paise: input.amount,
      tax_paise: input.tax ?? 0, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: `finance_note.${input.kind}_draft`, entityType: 'finance_notes', entityId: n.id, after: { amount_paise: input.amount, tax_paise: input.tax ?? 0 } });
    return { id: n.id };
  });
}

export async function setFinanceNoteStatus(db: Db, actor: StaffPrincipal, input: { noteId: string; status: 'issued' | 'void' }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  return db.transaction().execute(async tx => {
    const n = await tx.selectFrom('finance_notes').select(['id', 'kind', 'status', 'number']).where('id', '=', input.noteId).forUpdate().executeTakeFirst();
    if (!n) throw new NotFoundError('Note not found.');
    if (input.status === 'issued' && n.status !== 'draft') throw new ConflictError('Only a draft note can be issued.');
    if (input.status === 'void' && n.status === 'void') throw new ConflictError('This note is already void.');
    let number = n.number;
    if (input.status === 'issued') {
      number = (await sql<{ n: string }>`select public.next_document_number(${n.kind + '_note'}, ${await docPrefix(tx, n.kind === 'credit' ? '-C' : '-D')}, (now() at time zone 'Asia/Kolkata')::date) as n`.execute(tx)).rows[0].n;
    }
    await tx.updateTable('finance_notes').set({ status: input.status, number }).where('id', '=', n.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: `finance_note.${input.status === 'issued' ? 'issue' : 'void'}`, entityType: 'finance_notes', entityId: n.id, before: { status: n.status }, after: { status: input.status, number } });
    return { number };
  });
}

// ---------------------------------------------------------------- expenses and vendor payments
export async function expenseCategories(db: Db) {
  return db.selectFrom('expense_categories').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute();
}

export async function listExpenses(db: Db, actor: StaffPrincipal, range: ReportRange) {
  requirePermission(actor, 'finance.read'); checkRange(range);
  return db.selectFrom('expenses as e').innerJoin('expense_categories as c', 'c.code', 'e.category_code').leftJoin('vendors as v', 'v.id', 'e.vendor_id')
    .select(['e.id', 'e.expense_date', 'c.label as category', 'e.category_code', 'e.amount_paise', 'e.tax_paise', 'e.description', 'e.reference', 'e.voided_at', 'v.name as vendor', 'e.vendor_id'])
    .where(dateRange('e.expense_date', range)).orderBy('e.expense_date', 'desc').orderBy('e.created_at', 'desc').limit(500).execute();
}

export async function saveExpense(db: Db, actor: StaffPrincipal,
  input: { expenseId?: string; categoryCode: string; amount: number; tax: number | null; vendorId?: string; date: string; description: string; reference: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  if ((input.tax ?? 0) > input.amount) throw new DomainError('invalid', 'The tax part cannot be more than the amount.');
  const row = { category_code: input.categoryCode, amount_paise: input.amount, tax_paise: input.tax ?? 0, vendor_id: input.vendorId ?? null, expense_date: input.date,
    description: input.description, reference: input.reference };
  return db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('expense_categories').select('code').where('code', '=', input.categoryCode).executeTakeFirst())) throw new DomainError('invalid', 'Choose a category.');
    if (row.vendor_id && !(await tx.selectFrom('vendors').select('id').where('id', '=', row.vendor_id).executeTakeFirst())) throw new NotFoundError('Vendor not found.');
    if (!input.expenseId) {
      const e = await tx.insertInto('expenses').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'expense.create', entityType: 'expenses', entityId: e.id, after: row });
      return { id: e.id };
    }
    const before = await tx.selectFrom('expenses').select(['category_code', 'amount_paise', 'tax_paise', 'vendor_id', 'expense_date', 'description', 'reference', 'voided_at']).where('id', '=', input.expenseId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Expense not found.');
    if (before.voided_at) throw new ConflictError('A voided expense cannot be changed.');
    await tx.updateTable('expenses').set(row).where('id', '=', input.expenseId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'expense.update', entityType: 'expenses', entityId: input.expenseId, before, after: row });
    return { id: input.expenseId };
  });
}

export async function voidExpense(db: Db, actor: StaffPrincipal, input: { expenseId: string }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  await db.transaction().execute(async tx => {
    const e = await tx.selectFrom('expenses').select('voided_at').where('id', '=', input.expenseId).forUpdate().executeTakeFirst();
    if (!e) throw new NotFoundError('Expense not found.');
    if (e.voided_at) throw new ConflictError('This expense is already void.');
    await tx.updateTable('expenses').set({ voided_at: sql<Date>`now()` as unknown as Date }).where('id', '=', input.expenseId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'expense.void', entityType: 'expenses', entityId: input.expenseId });
  });
}

export async function listVendorPayments(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'finance.read');
  return db.selectFrom('vendor_payments as p').innerJoin('vendors as v', 'v.id', 'p.vendor_id').leftJoin('purchase_orders as po', 'po.id', 'p.purchase_order_id')
    .select(['p.id', 'p.vendor_id', 'v.name as vendor', 'p.purchase_order_id', 'po.po_number', 'p.amount_paise', 'p.status', 'p.paid_on', 'p.method', 'p.reference', 'p.notes', 'p.created_at'])
    .orderBy('p.created_at', 'desc').limit(300).execute();
}

export async function saveVendorPayment(db: Db, actor: StaffPrincipal,
  input: { paymentId?: string; vendorId: string; purchaseOrderId?: string; amount: number; status: 'scheduled' | 'paid' | 'void'; paidOn: string | null; method?: string; reference: string | null; notes: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'finance.manage');
  const row = { vendor_id: input.vendorId, purchase_order_id: input.purchaseOrderId ?? null, amount_paise: input.amount, status: input.status,
    paid_on: input.status === 'paid' ? input.paidOn : null, method: (input.method ?? null) as never, reference: input.reference, notes: input.notes };
  return db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('vendors').select('id').where('id', '=', input.vendorId).executeTakeFirst())) throw new NotFoundError('Vendor not found.');
    if (row.purchase_order_id) {
      const po = await tx.selectFrom('purchase_orders').select('vendor_id').where('id', '=', row.purchase_order_id).executeTakeFirst();
      if (!po || po.vendor_id !== input.vendorId) throw new DomainError('invalid', 'That purchase order is not from this vendor.');
    }
    if (!input.paymentId) {
      const p = await tx.insertInto('vendor_payments').values({ ...row, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor_payment.create', entityType: 'vendor_payments', entityId: p.id, after: row });
      return { id: p.id };
    }
    const before = await tx.selectFrom('vendor_payments').select(['status', 'amount_paise', 'paid_on', 'reference']).where('id', '=', input.paymentId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Payment not found.');
    if (before.status === 'void') throw new ConflictError('A void payment cannot be changed.');
    await tx.updateTable('vendor_payments').set(row).where('id', '=', input.paymentId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor_payment.update', entityType: 'vendor_payments', entityId: input.paymentId, before, after: row });
    return { id: input.paymentId };
  });
}

// ---------------------------------------------------------------- reports and reconciliation
export async function financeSummary(db: Db, actor: StaffPrincipal, range: ReportRange) {
  requirePermission(actor, 'finance.read'); checkRange(range);
  const [sales, refunds, taxByRate, expenses, vendorPaid, invoices] = await Promise.all([
    db.selectFrom('orders as o').select([sql<number>`count(*)::int`.as('orders'), sql<number>`coalesce(sum(o.subtotal_paise), 0)::float8`.as('gross'),
      sql<number>`coalesce(sum(o.discount_paise), 0)::float8`.as('discounts'), sql<number>`coalesce(sum(o.shipping_paise), 0)::float8`.as('shipping'),
      sql<number>`coalesce(sum(o.tax_paise), 0)::float8`.as('tax'), sql<number>`coalesce(sum(o.total_paise), 0)::float8`.as('total')])
      .where('o.status', 'in', [...SOLD, 'refunded']).where(inRange('o.created_at', range)).executeTakeFirstOrThrow(),
    db.selectFrom('refunds as f').select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(f.amount_paise), 0)::float8`.as('paise')])
      .where('f.status', '=', 'processed').where(inRange('f.processed_at', range)).executeTakeFirstOrThrow(),
    db.selectFrom('orders as o').select([sql<string>`coalesce(o.pricing->'tax'->>'label', 'Not configured')`.as('rate'), sql<number>`count(*)::int`.as('orders'),
      sql<number>`coalesce(sum(o.tax_paise), 0)::float8`.as('tax')])
      .where('o.status', 'in', [...SOLD]).where(inRange('o.created_at', range)).groupBy(sql`1`).execute(),
    db.selectFrom('expenses as e').innerJoin('expense_categories as c', 'c.code', 'e.category_code')
      .select(['c.label', sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(e.amount_paise), 0)::float8`.as('paise'), sql<number>`coalesce(sum(e.tax_paise), 0)::float8`.as('tax')])
      .where('e.voided_at', 'is', null).where(dateRange('e.expense_date', range)).groupBy('c.label').orderBy(sql`sum(e.amount_paise)`, 'desc').execute(),
    db.selectFrom('vendor_payments as p').select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(p.amount_paise), 0)::float8`.as('paise')])
      .where('p.status', '=', 'paid').where(dateRange('p.paid_on', range)).executeTakeFirstOrThrow(),
    db.selectFrom('invoices as i').select(['i.status', sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(i.total_paise), 0)::float8`.as('paise')])
      .where(inRange('i.issued_at', range)).groupBy('i.status').execute(),
  ]);
  const expenseTotal = expenses.reduce((n, e) => n + e.paise, 0);
  return { sales, refunds, netSalesPaise: sales.total - refunds.paise, taxByRate, expenses, expenseTotal, vendorPaid, invoices,
    cashflow: { inPaise: sales.total, refundsPaise: refunds.paise, expensesPaise: expenseTotal, vendorPaymentsPaise: vendorPaid.paise } };
}

/** Day by day: orders marked paid vs captured payments vs processed refunds, from the platform's own records. A day
    "matches" only when the paid orders and the captured payments agree to the paisa. */
export async function reconciliation(db: Db, actor: StaffPrincipal, range: ReportRange) {
  requirePermission(actor, 'finance.read'); checkRange(range);
  const rows = (await sql<{ day: string; orders_paid: number; orders_paise: number; payments: number; captured_paise: number; refunds_paise: number }>`
    with days as (select generate_series(${range.from}::date, ${range.to}::date, interval '1 day')::date as d),
    o as (select (paid_at at time zone 'Asia/Kolkata')::date d, count(*)::int n, sum(total_paise)::float8 s from public.orders where paid_at is not null group by 1),
    p as (select (coalesce(captured_at, created_at) at time zone 'Asia/Kolkata')::date d, count(*)::int n, sum(amount_paise)::float8 s from public.payments where status in ('captured', 'partially_refunded', 'refunded') group by 1),
    r as (select (processed_at at time zone 'Asia/Kolkata')::date d, sum(amount_paise)::float8 s from public.refunds where status = 'processed' group by 1)
    select days.d::text as day, coalesce(o.n, 0) orders_paid, coalesce(o.s, 0) orders_paise, coalesce(p.n, 0) payments, coalesce(p.s, 0) captured_paise, coalesce(r.s, 0) refunds_paise
    from days left join o on o.d = days.d left join p on p.d = days.d left join r on r.d = days.d
    where o.n is not null or p.n is not null or r.s is not null order by 1`.execute(db)).rows;
  const days = rows.map(r => ({ ...r, difference: r.captured_paise - r.orders_paise, matches: r.captured_paise === r.orders_paise }));
  return { days, allMatch: days.every(d => d.matches),
    note: 'Compares the platform\'s own records only. Bank and payment-provider settlements are not imported, so this is not a bank reconciliation.' };
}

export const FINANCE_EXPORTS = ['summary', 'expenses', 'vendor_payments', 'invoices', 'reconciliation'] as const;
export type FinanceExport = typeof FINANCE_EXPORTS[number];
const r2 = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2));

export async function exportFinance(db: Db, actor: StaffPrincipal, kind: FinanceExport, range: ReportRange, ctx: MutationContext) {
  requirePermission(actor, 'finance.read'); checkRange(range);
  let head: string[] = [], lines: unknown[][] = [];
  if (kind === 'summary') {
    const s = await financeSummary(db, actor, range);
    head = ['measure', 'inr'];
    lines = [['orders', s.sales.orders], ['gross_sales', r2(s.sales.gross)], ['discounts', r2(s.sales.discounts)], ['shipping', r2(s.sales.shipping)], ['tax', r2(s.sales.tax)],
      ['order_totals', r2(s.sales.total)], ['refunds_processed', r2(s.refunds.paise)], ['net_sales', r2(s.netSalesPaise)], ['expenses', r2(s.expenseTotal)], ['vendor_payments', r2(s.vendorPaid.paise)]];
  } else if (kind === 'expenses') {
    head = ['date', 'category', 'description', 'vendor', 'amount_inr', 'tax_inr', 'reference', 'void'];
    lines = (await listExpenses(db, actor, range)).map(e => [String(e.expense_date).slice(0, 10), e.category, e.description, e.vendor ?? '', r2(e.amount_paise), r2(e.tax_paise), e.reference ?? '', e.voided_at ? 'yes' : '']);
  } else if (kind === 'vendor_payments') {
    head = ['vendor', 'po', 'amount_inr', 'status', 'paid_on', 'method', 'reference'];
    lines = (await listVendorPayments(db, actor)).map(p => [p.vendor, p.po_number ?? '', r2(p.amount_paise), p.status, p.paid_on ? String(p.paid_on).slice(0, 10) : '', p.method ?? '', p.reference ?? '']);
  } else if (kind === 'invoices') {
    head = ['number', 'status', 'issued', 'order', 'place_of_supply', 'subtotal_inr', 'discount_inr', 'shipping_inr', 'tax_inr', 'cgst_inr', 'sgst_inr', 'igst_inr', 'total_inr'];
    const rows = await db.selectFrom('invoices as i').leftJoin('orders as o', 'o.id', 'i.order_id')
      .select(['i.invoice_number', 'i.status', 'i.issued_at', 'o.order_number', 'i.place_of_supply', 'i.subtotal_paise', 'i.discount_paise', 'i.shipping_paise', 'i.tax_paise', 'i.tax_split', 'i.total_paise'])
      .where(inRange('i.issued_at', range)).orderBy('i.issued_at').execute();
    lines = rows.map(i => { const t = (i.tax_split ?? {}) as { cgst?: number; sgst?: number; igst?: number };
      return [i.invoice_number, i.status, i.issued_at ? new Date(i.issued_at as Date).toISOString().slice(0, 10) : '', i.order_number ?? '', i.place_of_supply ?? '', r2(i.subtotal_paise), r2(i.discount_paise),
        r2(i.shipping_paise), r2(i.tax_paise), r2(t.cgst ?? 0), r2(t.sgst ?? 0), r2(t.igst ?? 0), r2(i.total_paise)]; });
  } else {
    head = ['date', 'orders_paid', 'orders_inr', 'payments', 'captured_inr', 'refunds_inr', 'difference_inr', 'matches'];
    lines = (await reconciliation(db, actor, range)).days.map(d => [d.day, d.orders_paid, r2(d.orders_paise), d.payments, r2(d.captured_paise), r2(d.refunds_paise), r2(d.difference), d.matches ? 'yes' : 'no']);
  }
  await db.transaction().execute(tx => recordAudit(tx, { ...staffAudit(actor, ctx), action: 'finance.export', entityType: 'reports', entityId: `finance.${kind}`, metadata: { ...range, rows: lines.length } }));
  return { csv: [head, ...lines].map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n', rows: lines.length };
}


/** Vendors and their purchase orders, for the finance forms (finance.read is enough; no costs are included). */
export async function financeLookups(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'finance.read');
  const [vendors, purchaseOrders, categories] = await Promise.all([
    db.selectFrom('vendors').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute(),
    db.selectFrom('purchase_orders').select(['id', 'po_number', 'vendor_id']).where('status', '!=', 'cancelled').orderBy('created_at', 'desc').limit(300).execute(),
    expenseCategories(db),
  ]);
  return { vendors, purchaseOrders, categories };
}
