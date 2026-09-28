'use server';
import { revalidatePath } from 'next/cache';
import { settingUpdateInput, type ActionState } from '@kitsyuu/contracts';
import { updateSetting } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

/** Changes one registry setting that is marked editable; the service refuses locked or unknown keys. */
export async function updateSettingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(settingUpdateInput, form, async input => {
    const res = await updateSetting(db(), actor, input, await requestContext());
    return { ok: true, message: res.changed ? 'Setting saved.' : 'Nothing changed.' };
  });
  if (r.ok) { revalidatePath('/settings'); revalidatePath('/inventory'); revalidatePath('/dashboard'); }
  return r;
}
