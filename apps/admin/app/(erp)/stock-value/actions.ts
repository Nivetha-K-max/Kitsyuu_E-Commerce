'use server';
import { revalidatePath } from 'next/cache';
import { variantCostInput, type ActionState } from '@kitsyuu/contracts';
import { setVariantCost } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function setVariantCostAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(variantCostInput, form, async input => {
    await setVariantCost(db(), actor, input, await requestContext());
    return { ok: true, message: input.unitCostPaise === null ? 'Cost cleared.' : 'Cost saved.' };
  });
  if (r.ok) revalidatePath('/stock-value');
  return r;
}
