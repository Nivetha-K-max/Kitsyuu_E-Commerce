'use server';
/* POS server actions. The counter screen calls the JSON actions directly (search, quote, customers, complete); session,
   void, return and invoice use the usual ActionForm plumbing. Every call checks the session's permissions in the core. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DomainError, type ActionState } from '@kitsyuu/contracts';
import { closePosSession, completePosSale, setVariantBarcode, createInvoiceForOrder, notifyInvoiceIssued, createStaffReturn, findPosCustomers, openPosSession, quotePosSale, searchPosProducts, voidPosSale,
  listPosBranchStock, posCustomerProfile, findPosOrders, quoteCounterExchange, settleCounterExchange, repayCreditBill, setCreditAccount, adjustStoreCredit,
  type PosLineInput, type PosPaymentMethod, type PosTender, type PosTenderMethod, type ExchangeReturnLine, type CreditRepayMethod } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, productImageUrl, requestContext, requireActor } from '@/lib/server';

type Json<T> = { ok: true; data: T } | { ok: false; message: string };
async function json<T>(run: () => Promise<T>): Promise<Json<T>> {
  try { return { ok: true, data: await run() }; }
  catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    console.error('[pos action]', e);
    return { ok: false, message: 'Something went wrong. Nothing was charged or changed.' };
  }
}
const rupees = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'Not valid.');
/** A tender as the counter sends it (rupees as typed); amounts are turned into paise here and checked again in the core. */
export type TenderInput = { method: PosTenderMethod; amount: string; reference?: string; tendered?: string };
function toTenders(list: TenderInput[] | undefined | null): PosTender[] | null {
  if (!list?.length) return null;
  return list.map(t => {
    const amountPaise = rupees(t.amount);
    if (!Number.isInteger(amountPaise)) throw new DomainError('invalid', 'Enter each payment amount in rupees.');
    const tenderedPaise = t.method === 'cash' && String(t.tendered ?? '').trim() ? rupees(t.tendered) : null;
    return { method: t.method, amountPaise, reference: t.reference?.trim() || null, tenderedPaise: Number.isInteger(tenderedPaise) ? tenderedPaise : null };
  });
}

// ---------------------------------------------------------------- counter (JSON)
export async function posSearchAction(locationId: string, q: string) {
  const actor = await requireActor();
  return json(async () => {
    const r = await searchPosProducts(db(), actor, { locationId, q: String(q ?? '') });
    return { exact: r.exact, products: r.products.map(p => ({ ...p, image: productImageUrl(p.imagePath) })) };
  });
}

/** The branch's available stock, for the counter's first view. */
export async function posStockAction(locationId: string) {
  const actor = await requireActor();
  return json(async () => {
    const r = await listPosBranchStock(db(), actor, { locationId });
    return { more: r.more, products: r.products.map(p => ({ ...p, image: productImageUrl(p.imagePath) })) };
  });
}

export async function posCustomersAction(term: string) {
  const actor = await requireActor();
  return json(() => findPosCustomers(db(), actor, String(term ?? '')));
}

export async function posQuoteAction(input: { locationId: string; lines: PosLineInput[]; customerId: string | null; discountPercent: number; discountReason: string; couponCode?: string; usePoints?: boolean }) {
  const actor = await requireActor();
  return json(async () => {
    if (!input.lines.length) return null;
    const discount = input.discountPercent > 0 ? { percent: input.discountPercent, reason: input.discountReason || 'pending' } : null;
    const q = await quotePosSale(db(), actor, { locationId: input.locationId, lines: input.lines, customerId: input.customerId, discount, couponCode: input.couponCode ?? null, usePoints: !!input.usePoints });
    return { lines: q.lines.map(l => ({ variantId: l.variantId, sku: l.sku, name: l.name, size: l.size, colourLabel: l.colourLabel, unitPaise: l.unitPaise, qty: l.qty,
      lineTotalPaise: l.lineTotalPaise, stock: l.branchStock, problem: l.problem })), problems: q.problems,
      totals: { subtotalPaise: q.totals.subtotalPaise, discountPaise: q.totals.discountPaise, taxPaise: q.totals.taxPaise, totalPaise: q.totals.totalPaise, units: q.totals.units,
        pricesIncludeTax: q.totals.pricesIncludeTax, tax: q.totals.tax, discounts: q.totals.discounts },
      // 2026-10-12: the bill as every bill is shown (core bill.ts), the state of the typed coupon, and the linked customer's points.
      bill: q.bill, coupon: q.coupon,
      loyalty: q.loyalty && { redeemable: q.loyalty.redeemable, balance: q.loyalty.balance, usablePoints: q.loyalty.usablePoints, usableValuePaise: q.loyalty.usableValuePaise,
        usedPoints: q.loyalty.usedPoints, discountPaise: q.loyalty.discountPaise, message: q.loyalty.message } };
  });
}

export async function posCompleteAction(input: { sessionId: string; idempotencyKey: string; lines: PosLineInput[]; customerId: string | null; contactName: string; contactPhone: string;
  discountPercent: number; discountReason: string; method: PosPaymentMethod; tendered: string; reference: string; expectedTotalPaise: number; couponCode?: string; usePoints?: boolean;
  /** 2026-10-13: several ways of paying one bill (cash, card, UPI, store credit, on credit). When given, `method` is ignored. */
  tenders?: TenderInput[] }) {
  const actor = await requireActor();
  const r = await json(async () => {
    const tenders = toTenders(input.tenders);
    const tenderedPaise = !tenders && input.method === 'cash' ? rupees(input.tendered) : null;
    if (!tenders && input.method === 'cash' && !Number.isInteger(tenderedPaise)) throw new DomainError('invalid', 'Enter the cash received.');
    return completePosSale(db(), actor, {
      sessionId: input.sessionId, idempotencyKey: input.idempotencyKey, lines: input.lines, customerId: input.customerId,
      contact: { name: input.contactName, phone: input.contactPhone },
      discount: input.discountPercent > 0 ? { percent: input.discountPercent, reason: input.discountReason } : null,
      couponCode: input.couponCode ?? null, usePoints: !!input.usePoints,
      payment: { method: input.method, tenderedPaise, reference: input.reference }, tenders, expectedTotalPaise: input.expectedTotalPaise,
    }, await requestContext());
  });
  if (r.ok) { revalidatePath('/pos', 'layout'); revalidatePath('/orders'); }
  return r;
}

// ---------------------------------------------------------------- customer profile, order lookup, exchange (JSON)
export async function posProfileAction(customerId: string) {
  const actor = await requireActor();
  return json(() => posCustomerProfile(db(), actor, String(customerId ?? '')));
}

export async function posOrdersAction(term: string) {
  const actor = await requireActor();
  return json(() => findPosOrders(db(), actor, String(term ?? '')));
}

export async function posExchangeQuoteAction(input: { orderId: string; locationId: string; items: ExchangeReturnLine[]; replacements: PosLineInput[] }) {
  const actor = await requireActor();
  return json(() => quoteCounterExchange(db(), actor, input));
}

export async function posExchangeSettleAction(input: { sessionId: string; orderId: string; items: ExchangeReturnLine[]; reasonCode: string; note: string; replacements: PosLineInput[];
  surplus: 'store_credit' | 'refund'; tenders?: TenderInput[]; expected: { returnValuePaise: number; replacementPaise: number }; key: string }) {
  const actor = await requireActor();
  const r = await json(async () => settleCounterExchange(db(), actor, { sessionId: input.sessionId, orderId: input.orderId, items: input.items, reasonCode: input.reasonCode, note: input.note || null,
    replacements: input.replacements, surplus: input.surplus, tenders: toTenders(input.tenders), expected: input.expected, key: input.key }, await requestContext()));
  if (r.ok) { revalidatePath('/pos', 'layout'); revalidatePath('/orders'); revalidatePath('/returns'); }
  return r;
}

// ---------------------------------------------------------------- credit and store credit (forms)
const money = z.string().trim().min(1, 'Enter an amount.');
export async function repayCreditAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let done = '';
  const r = await handle(z.object({ billId: uuid, amount: money, method: z.enum(['cash', 'card', 'upi']), reference: z.string().trim().max(64).optional(), sessionId: uuid.optional().or(z.literal('')), key: z.string().min(8).max(100) }), form, async input => {
    const amountPaise = rupees(input.amount);
    if (!Number.isInteger(amountPaise)) throw new DomainError('invalid', 'Enter the amount received in rupees.');
    const res = await repayCreditBill(db(), actor, { billId: input.billId, amountPaise, method: input.method as CreditRepayMethod, reference: input.reference || null, sessionId: input.sessionId || null, key: input.key }, await requestContext());
    done = res.paidOff ? `Repayment ${res.number} recorded. This credit bill is now fully repaid.` : `Repayment ${res.number} recorded. ₹${(res.outstandingPaise / 100).toFixed(2)} is still owed on this bill.`;
  });
  if (r.ok) { revalidatePath('/pos', 'layout'); revalidatePath('/customers', 'layout'); return { ok: true, message: done }; }
  return r;
}

export async function setCreditAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(z.object({ customerId: uuid, limit: money, dueDays: z.coerce.number().int('Enter whole days.'), active: z.enum(['yes', 'no']), note: z.string().trim().max(500).optional() }), form, async input => {
    const limitPaise = rupees(input.limit);
    if (!Number.isInteger(limitPaise)) throw new DomainError('invalid', 'Enter the credit limit in rupees.');
    await setCreditAccount(db(), actor, { customerId: input.customerId, limitPaise, dueDays: input.dueDays, active: input.active === 'yes', note: input.note || null }, await requestContext());
  });
  if (r.ok) { revalidatePath('/customers', 'layout'); return { ok: true, message: 'Credit account saved. Bills already made keep the terms they were sold on.' }; }
  return r;
}

export async function adjustStoreCreditAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let done = '';
  const r = await handle(z.object({ customerId: uuid, amount: z.string().trim().min(1, 'Enter an amount.'), reason: z.string().trim().min(3, 'Enter the reason.').max(300), key: z.string().min(8).max(100) }), form, async input => {
    const amountPaise = rupees(input.amount);
    if (!Number.isInteger(amountPaise) || amountPaise === 0) throw new DomainError('invalid', 'Enter an amount in rupees, other than 0 (a minus sign takes credit away).');
    const res = await adjustStoreCredit(db(), actor, { customerId: input.customerId, amountPaise, reason: input.reason, key: input.key }, await requestContext());
    done = `Store credit ${amountPaise > 0 ? 'added' : 'removed'}. The balance is now ₹${(res.balancePaise / 100).toFixed(2)}.`;
  });
  if (r.ok) { revalidatePath('/customers', 'layout'); return { ok: true, message: done }; }
  return r;
}

// ---------------------------------------------------------------- sessions, void, returns, invoice (forms)
const openInput = z.object({ locationId: uuid, openingCash: z.string().trim().min(1, 'Enter the opening cash (0 if none).') });
export async function openSessionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(openInput, form, async input => {
    const paise = rupees(input.openingCash);
    if (!Number.isInteger(paise)) return { ok: false, fieldErrors: { openingCash: 'Enter an amount in rupees.' }, message: 'Check the highlighted fields.' };
    await openPosSession(db(), actor, { locationId: input.locationId, openingCashPaise: paise }, await requestContext());
    return { ok: true, message: 'Session opened.' };
  });
  if (r.ok) { revalidatePath('/pos', 'layout'); redirect('/pos'); }
  return r;
}

const closeInput = z.object({ sessionId: uuid, countedCash: z.string().trim().min(1, 'Enter the cash counted in the drawer.'), note: z.string().trim().max(500).optional() });
export async function closeSessionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let done = false;
  const r = await handle(closeInput, form, async input => {
    const paise = rupees(input.countedCash);
    if (!Number.isInteger(paise)) return { ok: false, fieldErrors: { countedCash: 'Enter an amount in rupees.' }, message: 'Check the highlighted fields.' };
    const c = await closePosSession(db(), actor, { sessionId: input.sessionId, countedCashPaise: paise, note: input.note || null }, await requestContext());
    done = true;
    return { ok: true, message: `Session ${c.number} closed: ${c.transactions} transactions, variance ${c.variancePaise < 0 ? '−' : ''}₹${(Math.abs(c.variancePaise) / 100).toFixed(2)}.` };
  });
  if (done) { revalidatePath('/pos', 'layout'); redirect('/pos/sessions?closed=1'); }
  return r;
}

const voidInput = z.object({ orderId: uuid, reason: z.string().trim().min(3, 'Enter the reason.').max(300) });
export async function voidSaleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(voidInput, form, async input => {
    const v = await voidPosSale(db(), actor, input, await requestContext());
    return { ok: true, message: `${v.posNumber} voided: ₹${(v.refundedPaise / 100).toFixed(2)} to give back; stock returned to the branch.` };
  });
  if (r.ok) revalidatePath('/pos', 'layout');
  return r;
}

const returnInput = z.object({ orderId: uuid, reasonCode: z.string().trim().min(1, 'Choose a reason.'), description: z.string().trim().max(2000).optional() });
export async function staffReturnAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(returnInput, form, async input => {
    const items = [...form.keys()].filter(k => k.startsWith('qty_')).map(k => ({ orderItemId: k.slice(4), qty: parseInt(String(form.get(k) ?? '0'), 10) || 0 })).filter(i => i.qty > 0);
    if (!items.length) return { ok: false, message: 'Enter the quantity being returned for at least one item.' };
    id = (await createStaffReturn(db(), actor, { orderId: input.orderId, reasonCode: input.reasonCode, description: input.description || null, items }, await requestContext())).id;
  });
  if (id) { revalidatePath('/returns'); redirect(`/returns/${id}`); }
  return r;
}

const barcodeInput = z.object({ variantId: uuid, productId: z.string().trim().min(1), barcode: z.string().trim().max(64).optional() });
export async function setBarcodeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(barcodeInput, form, async input => {
    await setVariantBarcode(db(), actor, { variantId: input.variantId, barcode: input.barcode || null }, await requestContext());
    return { ok: true, message: input.barcode ? 'Barcode saved.' : 'Barcode cleared.' };
  });
  if (r.ok) revalidatePath(`/products/${String(form.get('productId'))}`);
  return r;
}

const orderInput = z.object({ orderId: uuid });
export async function issueInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(orderInput, form, async input => {
    const inv = await createInvoiceForOrder(db(), actor, { orderId: input.orderId }, await requestContext());
    // The invoice email, only when the business switched it on (Configuration → Customer emails); never blocks the invoice.
    const mail = await notifyInvoiceIssued(db(), mailer(), inv.id, { storeUrl: process.env.STORE_URL || null });
    return { ok: true, message: `Tax invoice ${inv.number} issued.${mail.sent ? ' It was handed to the email service for the customer.' : ''}` };
  });
  if (r.ok) revalidatePath('/pos', 'layout');
  return r;
}
