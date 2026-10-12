'use server';
import { revalidatePath } from 'next/cache';
import { adjustMaterialInput, materialInput, packagingUseInput, type ActionState } from '@kitsyuu/contracts';
import { adjustMaterialStock, recordPackagingUse, saveMaterial } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function saveMaterialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(materialInput, form, async input => {
    const m = await saveMaterial(db(), actor, input, await requestContext());
    return { ok: true, message: input.materialId ? (m.changed ? 'Saved.' : 'No changes.') : `${input.kind === 'packaging' ? 'Packaging item' : 'Material'} ${input.code} added.` };
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

/** Packaging used (2026-10-12). The form carries the stock the page showed; the core refuses when it has changed since
    (someone else recorded, or the form was sent twice), so a use is never recorded twice. */
export async function recordPackagingUseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(packagingUseInput, form, async input => {
    const res = await recordPackagingUse(db(), actor, input, await requestContext());
    return { ok: true, message: `Recorded. In stock now: ${res.balance}.` };
  });
  if (r.ok) revalidatePath('/materials', 'layout');
  return r;
}
