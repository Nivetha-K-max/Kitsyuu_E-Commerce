'use server';
import { revalidatePath } from 'next/cache';
import { setCustomerStatusInput, updateCustomerContactInput, type ActionState } from '@kitsyuu/contracts';
import { setCustomerStatus, updateCustomerContact } from '@kitsyuu/core';
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
