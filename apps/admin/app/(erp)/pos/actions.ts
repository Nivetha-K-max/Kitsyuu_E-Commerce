'use server';
/* POS server actions. The counter screen calls the JSON actions directly (search, quote, customers, complete); session,
   void, return and invoice use the usual ActionForm plumbing. Every call checks the session's permissions in the core. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DomainError, type ActionState } from '@kitsyuu/contracts';
import { closePosSession, completePosSale, setVariantBarcode, createInvoiceForOrder, createStaffReturn, findPosCustomers, openPosSession, quotePosSale, searchPosProducts, voidPosSale,
  type PosLineInput, type PosPaymentMethod } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, productImageUrl, requestContext, requireActor } from '@/lib/server';

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

// ---------------------------------------------------------------- counter (JSON)
export async function posSearchAction(locationId: string, q: string) {
  const actor = await requireActor();
  return json(async () => {
    const r = await searchPosProducts(db(), actor, { locationId, q: String(q ?? '') });
    return { exact: r.exact, products: r.products.map(p => ({ ...p, image: productImageUrl(p.imagePath) })) };
  });
}

export async function posCustomersAction(term: string) {
  const actor = await requireActor();
  return json(() => findPosCustomers(db(), actor, String(term ?? '')));
}

export async function posQuoteAction(input: { locationId: string; lines: PosLineInput[]; customerId: string | null; discountPercent: number; discountReason: string }) {
  const actor = await requireActor();
  return json(async () => {
    if (!input.lines.length) return null;
    const discount = input.discountPercent > 0 ? { percent: input.discountPercent, reason: input.discountReason || 'pending' } : null;
    const q = await quotePosSale(db(), actor, { locationId: input.locationId, lines: input.lines, customerId: input.customerId, discount });
    return { lines: q.lines.map(l => ({ variantId: l.variantId, sku: l.sku, name: l.name, size: l.size, colourLabel: l.colourLabel, unitPaise: l.unitPaise, qty: l.qty,
      lineTotalPaise: l.lineTotalPaise, stock: l.branchStock, problem: l.problem })), problems: q.problems,
      totals: { subtotalPaise: q.totals.subtotalPaise, discountPaise: q.totals.discountPaise, taxPaise: q.totals.taxPaise, totalPaise: q.totals.totalPaise, units: q.totals.units,
        pricesIncludeTax: q.totals.pricesIncludeTax, tax: q.totals.tax, discounts: q.totals.discounts } };
  });
}

export async function posCompleteAction(input: { sessionId: string; idempotencyKey: string; lines: PosLineInput[]; customerId: string | null; contactName: string; contactPhone: string;
  discountPercent: number; discountReason: string; method: PosPaymentMethod; tendered: string; reference: string; expectedTotalPaise: number }) {
  const actor = await requireActor();
  const r = await json(async () => {
    const tenderedPaise = input.method === 'cash' ? rupees(input.tendered) : null;
    if (input.method === 'cash' && !Number.isInteger(tenderedPaise)) throw new DomainError('invalid', 'Enter the cash received.');
    return completePosSale(db(), actor, {
      sessionId: input.sessionId, idempotencyKey: input.idempotencyKey, lines: input.lines, customerId: input.customerId,
      contact: { name: input.contactName, phone: input.contactPhone },
      discount: input.discountPercent > 0 ? { percent: input.discountPercent, reason: input.discountReason } : null,
      payment: { method: input.method, tenderedPaise, reference: input.reference }, expectedTotalPaise: input.expectedTotalPaise,
    }, await requestContext());
  });
  if (r.ok) { revalidatePath('/pos', 'layout'); revalidatePath('/orders'); }
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
    return { ok: true, message: `Tax invoice ${inv.number} issued.` };
  });
  if (r.ok) revalidatePath('/pos', 'layout');
  return r;
}
