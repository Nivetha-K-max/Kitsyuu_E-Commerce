'use server';
/* Third pass: colour variants. A product in colours has its sizes per colour (each with its own SKU, stock and photos). */
import { revalidatePath } from 'next/cache';
import { colourVariantInput, imageColourInput, variantColourInput, type ActionState } from '@kitsyuu/contracts';
import { addColourVariant, setImageColour, setVariantColour } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (form: FormData) => { revalidatePath(`/products/${String(form.get('productId'))}`); revalidatePath('/products'); revalidatePath('/inventory'); };

export async function addColourVariantAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(colourVariantInput, form, async input => {
    const v = await addColourVariant(db(), actor, input, await requestContext());
    return { ok: true, message: `Size added: ${v.sku}, 0 in stock. Add stock with a restock adjustment.` };
  });
  if (r.ok) refresh(form);
  return r;
}

export async function setVariantColourAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(variantColourInput, form, async input => { await setVariantColour(db(), actor, input, await requestContext()); return { ok: true, message: 'Colour saved.' }; });
  if (r.ok) refresh(form);
  return r;
}

export async function setImageColourAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(imageColourInput, form, async input => { await setImageColour(db(), actor, input, await requestContext()); return { ok: true, message: 'Photo colour saved.' }; });
  if (r.ok) refresh(form);
  return r;
}
