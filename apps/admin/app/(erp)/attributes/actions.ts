'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addAttributeValueInput, attributeValueRef, createAttributeInput, moveAttributeInput, moveAttributeValueInput, renameAttributeValueInput,
  setAttributeActiveInput, updateAttributeInput, type ActionState
} from '@kitsyuu/contracts';
import {
  addAttributeValue, createAttribute, deleteAttributeValue, moveAttribute, moveAttributeValue, renameAttributeValue, setAttributeActive, updateAttribute
} from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = () => { revalidatePath('/attributes'); revalidatePath('/products', 'layout'); };

/** Runs one attribute service through the shared form plumbing and refreshes the pages that show attributes. */
function action<S extends z.ZodType>(schema: S, run: (input: z.output<S>, actor: Awaited<ReturnType<typeof requireActor>>) => Promise<ActionState | void>) {
  return async (_: ActionState, form: FormData): Promise<ActionState> => {
    const actor = await requireActor();
    const r = await handle(schema, form, input => run(input, actor));
    if (r.ok) refresh();
    return r;
  };
}

export const createAttributeAction = action(createAttributeInput, async (input, actor) => {
  const a = await createAttribute(db(), actor, input, await requestContext());
  return { ok: true, message: `Attribute "${a.id}" created. Add its values below.` };
});
export const updateAttributeAction = action(updateAttributeInput, async (input, actor) => {
  const u = await updateAttribute(db(), actor, input, await requestContext());
  return { ok: true, message: u.changed ? 'Saved.' : 'No changes.' };
});
export const setAttributeActiveAction = action(setAttributeActiveInput, async (input, actor) => {
  await setAttributeActive(db(), actor, input, await requestContext());
  return { ok: true, message: input.active ? 'Attribute is active: it is offered as a store filter.' : 'Attribute is inactive and hidden from the store.' };
});
export const moveAttributeAction = action(moveAttributeInput, async (input, actor) => { await moveAttribute(db(), actor, input, await requestContext()); return { ok: true }; });
export const addAttributeValueAction = action(addAttributeValueInput, async (input, actor) => {
  const v = await addAttributeValue(db(), actor, input, await requestContext());
  return { ok: true, message: `Value "${v.slug}" added.` };
});
export const renameAttributeValueAction = action(renameAttributeValueInput, async (input, actor) => {
  const r = await renameAttributeValue(db(), actor, input, await requestContext());
  return { ok: true, message: r.changed ? 'Saved.' : 'No changes.' };
});
export const moveAttributeValueAction = action(moveAttributeValueInput, async (input, actor) => { await moveAttributeValue(db(), actor, input, await requestContext()); return { ok: true }; });
export const deleteAttributeValueAction = action(attributeValueRef, async (input, actor) => {
  await deleteAttributeValue(db(), actor, input, await requestContext());
  return { ok: true, message: 'Value deleted.' };
});
