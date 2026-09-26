'use server';
/* M4 catalogue actions: create product, New Arrivals, sizes, images. The actor always comes from the session; core
   services check permissions, lock rows, refuse stale changes and write the audit record in the same transaction. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addVariantInput, createProductInput, imageIdInput, imageMetaInput, moveImageInput, moveNewArrivalInput, moveVariantInput,
  newArrivalInput, updateImageInput, updateVariantInput, type ActionState,
} from '@kitsyuu/contracts';
import {
  addVariant, createProduct, moveImage, moveNewArrival, moveVariant, removeImage, setNewArrival, setPrimaryImage, updateImageAlt,
  updateVariant, uploadProductImage,
} from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor, storage } from '@/lib/server';

const refresh = (productId?: string) => { revalidatePath('/products', 'layout'); revalidatePath('/inventory'); if (productId) revalidatePath(`/products/${productId}`); };
const pid = (form: FormData) => String(form.get('productId') ?? '');

export async function createProductAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let productId = '';
  const r = await handle(createProductInput, form, async input => { productId = (await createProduct(db(), actor, input, await requestContext())).productId; return { ok: true }; });
  if (r.ok && productId) { refresh(); redirect(`/products/${productId}?notice=created`); }
  return r;
}

export async function newArrivalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(newArrivalInput, form, async input => {
    const res = await setNewArrival(db(), actor, input, await requestContext());
    return { ok: true, message: !res.changed ? 'No change.' : input.member ? 'Added to New Arrivals.' : 'Removed from New Arrivals.' };
  });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function moveNewArrivalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(moveNewArrivalInput, form, async input => {
    const m = await moveNewArrival(db(), actor, input, await requestContext());
    return { ok: true, message: m.moved ? 'Order changed.' : 'Already at the end of the list.' };
  });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function addVariantAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(addVariantInput, form, async input => {
    const v = await addVariant(db(), actor, input, await requestContext());
    return { ok: true, message: `Size added: ${v.sku}, 0 in stock. Add stock with a restock adjustment.` };
  });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function updateVariantAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateVariantInput, form, async input => {
    const v = await updateVariant(db(), actor, input, await requestContext());
    return { ok: true, message: v.changed ? `${v.sku}: saved.` : `${v.sku}: no changes.` };
  });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function moveVariantAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(moveVariantInput, form, async input => { await moveVariant(db(), actor, input, await requestContext()); return { ok: true }; });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function uploadImageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(imageMetaInput, form, async input => {
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, fieldErrors: { file: 'Choose an image file.' }, message: 'Nothing was uploaded.' };
    const res = await uploadProductImage(db(), storage(), actor, input, Buffer.from(await file.arrayBuffer()), await requestContext());
    return { ok: true, message: `Image uploaded (${res.width}×${res.height}, WebP)${res.isPrimary ? ' and set as the primary image' : ''}.` };
  });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function setPrimaryImageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(imageIdInput, form, async input => { await setPrimaryImage(db(), actor, input.imageId, await requestContext()); return { ok: true, message: 'Primary image changed.' }; });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function updateImageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateImageInput, form, async input => { const u = await updateImageAlt(db(), actor, input, await requestContext()); return { ok: true, message: u.changed ? 'Alt text saved.' : 'No changes.' }; });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function moveImageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(moveImageInput, form, async input => { await moveImage(db(), actor, input, await requestContext()); return { ok: true }; });
  if (r.ok) refresh(pid(form));
  return r;
}

export async function removeImageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(imageIdInput, form, async input => { await removeImage(db(), storage(), actor, input.imageId, await requestContext()); return { ok: true, message: 'Image removed.' }; });
  if (r.ok) refresh(pid(form));
  return r;
}
