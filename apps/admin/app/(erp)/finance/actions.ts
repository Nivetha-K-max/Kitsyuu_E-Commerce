'use server';
import { revalidatePath } from 'next/cache';
import {
  createInvoiceInput, expenseInput, financeNoteInput, financeNoteStatusInput, productTaxInput, taxRateInput, vendorPaymentInput, voidExpenseInput, voidInvoiceInput,
  type ActionState,
} from '@kitsyuu/contracts';
import {
  createFinanceNote, createInvoiceForOrder, saveExpense, saveTaxRate, saveVendorPayment, setFinanceNoteStatus, setProductTax, voidExpense, voidInvoice,
} from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/finance', 'layout'); return r; };

export async function createInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(createInvoiceInput, form, async input => { const r = await createInvoiceForOrder(db(), actor, input, await requestContext()); return { ok: true, message: `Invoice ${r.number} issued.` }; }));
}
export async function voidInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(voidInvoiceInput, form, async input => { await voidInvoice(db(), actor, input, await requestContext()); return { ok: true, message: 'Invoice voided.' }; }));
}
export async function createNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(financeNoteInput, form, async input => { await createFinanceNote(db(), actor, { ...input, amount: input.amount! }, await requestContext()); return { ok: true, message: `Draft ${input.kind} note saved. Issue it to give it a number.` }; }));
}
export async function noteStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(financeNoteStatusInput, form, async input => { const r = await setFinanceNoteStatus(db(), actor, input, await requestContext()); return { ok: true, message: input.status === 'issued' ? `Note ${r.number} issued.` : 'Note voided.' }; }));
}
export async function saveExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(expenseInput, form, async input => { await saveExpense(db(), actor, { ...input, amount: input.amount!, date: input.date! }, await requestContext()); return { ok: true, message: 'Expense saved.' }; }));
}
export async function voidExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(voidExpenseInput, form, async input => { await voidExpense(db(), actor, input, await requestContext()); return { ok: true, message: 'Expense voided.' }; }));
}
export async function saveVendorPaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(vendorPaymentInput, form, async input => { await saveVendorPayment(db(), actor, { ...input, amount: input.amount! }, await requestContext()); return { ok: true, message: 'Vendor payment saved.' }; }));
}
export async function saveTaxRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(taxRateInput, form, async input => {
    await saveTaxRate(db(), actor, { ...input, validFrom: input.validFrom! }, await requestContext());
    return { ok: true, message: 'Tax rate saved. The active rate with the latest start date applies to carts priced from now on.' };
  }));
}
export async function productTaxAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(productTaxInput, form, async input => { await setProductTax(db(), actor, input, await requestContext()); return { ok: true, message: 'Saved.' }; }));
}
