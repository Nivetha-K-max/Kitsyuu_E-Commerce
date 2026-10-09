'use server';
import { revalidatePath } from 'next/cache';
import { adjustMaterialInput, materialInput, type ActionState } from '@kitsyuu/contracts';
import { adjustMaterialStock, saveMaterial } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function saveMaterialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(materialInput, form, async input => {
    const m = await saveMaterial(db(), actor, input, await requestContext());
    return { ok: true, message: input.materialId ? (m.changed ? 'Saved.' : 'No changes.') : `Material ${input.code} added.` };
  });
  if (r.ok) revalidatePath('/materials', 'layout');
  return r;
}

export async function adjustMaterialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(adjustMaterialInput, form, async input => {
    const res = await adjustMaterialStock(db(), actor, input, await requestContext());
    return { ok: true, message: `Stock is now ${res.balance}.` };
  });
  if (r.ok) revalidatePath('/materials', 'layout');
  return r;
}
