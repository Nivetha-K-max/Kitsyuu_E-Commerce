'use server';
import { revalidatePath } from 'next/cache';
import { customerNoteInput, setCustomerStatusInput, updateCustomerContactInput, type ActionState } from '@kitsyuu/contracts';
import { addCustomerNote, setCustomerStatus, updateCustomerContact } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function setCustomerStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setCustomerStatusInput, form, async input => {
    const res = await setCustomerStatus(db(), actor, input, await requestContext());
    return { ok: true, message: res.status === 'disabled'
      ? `Account disabled. ${res.sessionsEnded} session(s) ended; the customer can no longer log in.`
      : 'Account enabled. The customer can log in again.' };
  });
  if (r.ok) { revalidatePath('/customers', 'layout'); revalidatePath('/dashboard'); }
  return r;
}

export async function updateCustomerContactAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateCustomerContactInput, form, async input => {
    const res = await updateCustomerContact(db(), actor, input, await requestContext());
    return { ok: true, message: res.changed ? 'Contact details saved.' : 'Nothing changed.' };
  });
  if (r.ok) revalidatePath('/customers', 'layout');
  return r;
}

/** M17: an internal service note on a customer (customers.note). */
export async function addCustomerNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(customerNoteInput, form, async input => { await addCustomerNote(db(), actor, input, await requestContext()); return { ok: true, message: 'Note added.' }; });
  if (r.ok) revalidatePath(`/customers/${String(form.get('customerId'))}`);
  return r;
}
