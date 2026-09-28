'use server';
import { revalidatePath } from 'next/cache';
import { setVendorActiveInput, vendorInput, type ActionState } from '@kitsyuu/contracts';
import { saveVendor, setVendorActive } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function saveVendorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(vendorInput, form, async input => {
    const v = await saveVendor(db(), actor, input, await requestContext());
    return { ok: true, message: input.vendorId ? (v.changed ? 'Saved.' : 'No changes.') : 'Vendor added.' };
  });
  if (r.ok) revalidatePath('/vendors');
  return r;
}

export async function setVendorActiveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setVendorActiveInput, form, async input => {
    await setVendorActive(db(), actor, input, await requestContext());
    return { ok: true, message: input.active ? 'Vendor is active.' : 'Vendor is inactive (kept for history).' };
  });
  if (r.ok) revalidatePath('/vendors');
  return r;
}
