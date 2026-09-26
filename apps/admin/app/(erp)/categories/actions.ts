'use server';
import { revalidatePath } from 'next/cache';
import { createCategoryInput, moveCategoryInput, setCategoryActiveInput, updateCategoryInput, type ActionState } from '@kitsyuu/contracts';
import { createCategory, moveCategory, setCategoryActive, updateCategory } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = () => { revalidatePath('/categories'); revalidatePath('/products', 'layout'); };

export async function createCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(createCategoryInput, form, async input => {
    const c = await createCategory(db(), actor, input, await requestContext());
    return { ok: true, message: `Category ${c.id} created${c.isActive ? '' : ' (inactive, because its parent is inactive)'}.` };
  });
  if (r.ok) refresh();
  return r;
}

export async function updateCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateCategoryInput, form, async input => {
    const u = await updateCategory(db(), actor, input, await requestContext());
    return { ok: true, message: u.changed ? 'Saved.' : 'No changes.' };
  });
  if (r.ok) refresh();
  return r;
}

export async function setCategoryActiveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setCategoryActiveInput, form, async input => {
    await setCategoryActive(db(), actor, input, await requestContext());
    return { ok: true, message: input.active ? 'Category is active and shown in the store.' : 'Category is inactive and hidden from the store.' };
  });
  if (r.ok) refresh();
  return r;
}

export async function moveCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(moveCategoryInput, form, async input => { await moveCategory(db(), actor, input, await requestContext()); return { ok: true }; });
  if (r.ok) refresh();
  return r;
}
