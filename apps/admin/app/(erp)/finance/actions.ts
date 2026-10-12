'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createInvoiceInput, expenseInput, financeNoteInput, financeNoteStatusInput, productTaxInput, taxRateInput, vendorPaymentInput, voidExpenseInput, voidInvoiceInput,
  type ActionState,
} from '@kitsyuu/contracts';
import {
  createFinanceNote, createInvoiceForOrder, notifyInvoiceIssued, sendInvoiceEmail, saveExpense, saveTaxRate, saveVendorPayment, setFinanceNoteStatus, setProductTax, voidExpense, voidInvoice,
} from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) { revalidatePath('/finance', 'layout'); revalidatePath('/orders', 'layout'); } return r; };

export async function createInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(createInvoiceInput, form, async input => { const r = await createInvoiceForOrder(db(), actor, input, await requestContext());
    // 2026-10-12: the invoice email, only when the business switched it on (off by default); it never blocks or undoes the invoice.
    await notifyInvoiceIssued(db(), mailer(), r.id, { storeUrl: process.env.STORE_URL || null });
    return { ok: true, message: `Invoice ${r.number} issued.` }; }));
}
/** 2026-10-12: staff email an issued invoice to the customer (finance.manage; checked in the core). The message says what
    happened to the attempt, and never that the email arrived. */
const emailInvoiceInput = z.object({ invoiceId: z.string().regex(/^[0-9a-f-]{36}$/i, 'Not a valid invoice.') });
export async function emailInvoiceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(emailInvoiceInput, form, async input => {
    const m = mailer();
    const r = await sendInvoiceEmail(db(), actor, m, input, await requestContext(), { storeUrl: process.env.STORE_URL || null });
    if (!r.result.sent) return { ok: false, message: `Invoice ${r.number} could not be emailed (${r.result.reason === 'failed' ? 'the email service refused or did not answer' : r.result.reason.replace(/_/g, ' ')}). The attempt is logged; nothing else changed.` };
    return { ok: true, message: m.kind === 'console' || m.kind === 'file'
      ? `No email provider is configured here: the email for invoice ${r.number} was only written to the server's own log, not sent to the customer.`
      : `Invoice ${r.number} was handed to the email service. That is not a confirmation that it was delivered.` };
  }));
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
