'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  collectionMemberInput, createCollectionGroupInput, createCollectionInput, moveCollectionInput, moveCollectionMemberInput, productCollectionsInput,
  setCollectionActiveInput, updateCollectionInput, type ActionState,
} from '@kitsyuu/contracts';
import {
  createCollection, createCollectionGroup, moveCollection, moveCollectionMember, setCollectionActive, setCollectionMember, setProductCollections, updateCollection,
} from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => { revalidatePath('/collections'); if (id) revalidatePath(`/collections/${id}`); revalidatePath('/products', 'layout'); };

function action<S extends z.ZodType>(schema: S, run: (input: z.output<S>, actor: Awaited<ReturnType<typeof requireActor>>) => Promise<ActionState | void>) {
  return async (_: ActionState, form: FormData): Promise<ActionState> => {
    const actor = await requireActor();
    const r = await handle(schema, form, input => run(input, actor));
    if (r.ok) refresh(String(form.get('collectionId') ?? '') || undefined);
    return r;
  };
}

export async function createCollectionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(createCollectionInput, form, async input => { id = (await createCollection(db(), actor, input, await requestContext())).id; });
  if (id) { refresh(); redirect(`/collections/${id}?notice=created`); }
  return r;
}
export const updateCollectionAction = action(updateCollectionInput, async (input, actor) => {
  const u = await updateCollection(db(), actor, input, await requestContext());
  return { ok: true, message: u.changed ? 'Saved.' : 'No changes.' };
});
export const setCollectionActiveAction = action(setCollectionActiveInput, async (input, actor) => {
  await setCollectionActive(db(), actor, input, await requestContext());
  return { ok: true, message: input.active ? 'Collection is shown in the store menu.' : 'Collection is hidden from the store.' };
});
export const moveCollectionAction = action(moveCollectionInput, async (input, actor) => { await moveCollection(db(), actor, input, await requestContext()); return { ok: true }; });
export const addCollectionMemberAction = action(collectionMemberInput, async (input, actor) => {
  const r = await setCollectionMember(db(), actor, { ...input, member: true }, await requestContext());
  return { ok: true, message: r.changed ? 'Added.' : 'Already in this collection.' };
});
export const removeCollectionMemberAction = action(collectionMemberInput, async (input, actor) => {
  await setCollectionMember(db(), actor, { ...input, member: false }, await requestContext());
  return { ok: true, message: 'Removed.' };
});
export const createCollectionGroupAction = action(createCollectionGroupInput, async (input, actor) => {
  await createCollectionGroup(db(), actor, input, await requestContext());
  return { ok: true, message: `Group "${input.label}" added.` };
});
/** The product page's collection picker: exactly the collections ticked there. */
export const setProductCollectionsAction = action(productCollectionsInput, async (input, actor) => {
  const r = await setProductCollections(db(), actor, input, await requestContext());
  revalidatePath(`/products/${input.productId}`);
  return { ok: true, message: r.added || r.removed ? `Saved: ${r.added} added, ${r.removed} removed.` : 'No changes.' };
});
export const moveCollectionMemberAction = action(moveCollectionMemberInput, async (input, actor) => { await moveCollectionMember(db(), actor, input, await requestContext()); return { ok: true }; });
