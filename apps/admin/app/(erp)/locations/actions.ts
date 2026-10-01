'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { locationAdjustInput, locationInput, type ActionState } from '@kitsyuu/contracts';
import { adjustLocationStock, saveLocation } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => { revalidatePath('/locations'); if (id) revalidatePath(`/locations/${id}`); revalidatePath('/inventory'); revalidatePath('/products', 'layout'); };

export async function saveLocationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let created = '';
  const r = await handle(locationInput, form, async input => {
    const res = await saveLocation(db(), actor, input, await requestContext());
    if (!input.locationId) created = res.id;
    return { ok: true, message: input.locationId ? ('changed' in res && res.changed === 0 ? 'Nothing changed.' : 'Location saved.') : 'Location added.' };
  });
  if (r.ok) refresh(String(form.get('locationId') || '') || undefined);
  if (created) redirect(`/locations/${created}`);
  return r;
}

/** The size select carries "<variantId>:<quantity shown>" so a stale page is refused (expectedQty). */
export async function adjustLocationStockAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const [variantId = '', expectedQty = ''] = String(form.get('variant') ?? '').split(':');
  if (!variantId) return { ok: false, fieldErrors: { variant: 'Choose a size.' }, message: 'Check the highlighted fields.' };
  const r = await handle(locationAdjustInput, form, async input => {
    const res = await adjustLocationStock(db(), actor, input, await requestContext());
    return { ok: true, message: `Stock updated. Now ${res.balance} at this location.` };
  }, { variantId, expectedQty });
  if (r.ok) refresh(String(form.get('locationId')));
  return r;
}
