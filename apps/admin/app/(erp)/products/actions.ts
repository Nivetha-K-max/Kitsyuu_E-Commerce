'use server';
/* Product, price and stock mutations. The actor always comes from the session; core services check permissions,
   lock the row, and write the audit record in the same transaction as the change. */
import { revalidatePath } from 'next/cache';
import { adjustStockInput, bulkProductStatusInput, paiseToRupees, productMinPriceInput, setProductAttributesInput, setProductStatusInput, updatePriceInput, updateProductInput, type ActionState } from '@kitsyuu/contracts';
import { adjustStock, bulkSetProductStatus, setProductAttributes, setProductMinPrice, setProductStatus, updateProduct, updateProductPrice } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (productId?: string) => { revalidatePath('/products', 'layout'); revalidatePath('/inventory'); if (productId) revalidatePath(`/products/${productId}`); };

export async function updateProductAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateProductInput, form, async input => {
    const { changed } = await updateProduct(db(), actor, input, await requestContext());
    return { ok: true, message: changed ? `Saved ${changed} change${changed === 1 ? '' : 's'}.` : 'No changes to save.' };
  });
  if (r.ok) refresh(String(form.get('productId')));
  return r;
}

export async function updatePriceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updatePriceInput, form, async input => {
    const res = await updateProductPrice(db(), actor, input, await requestContext());
    return { ok: true, message: res.changed ? `Price changed from ₹${paiseToRupees(res.beforePaise)} to ₹${paiseToRupees(res.afterPaise)}.` : 'The price is unchanged.' };
  });
  if (r.ok) refresh(String(form.get('productId')));
  return r;
}

export async function setProductStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setProductStatusInput, form, async input => {
    await setProductStatus(db(), actor, input, await requestContext());
    return { ok: true, message: input.status === 'active' ? 'Product is active and visible in the store.' : `Product is now ${input.status} and hidden from the store.` };
  });
  if (r.ok) refresh(String(form.get('productId')));
  return r;
}

export async function adjustStockAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(adjustStockInput, form, async input => {
    const res = await adjustStock(db(), actor, input, await requestContext());
    return { ok: true, message: `${res.sku}: ${res.before} → ${res.after} (${res.delta > 0 ? '+' : ''}${res.delta}).` };
  });
  if (r.ok) refresh(String(form.get('productId') ?? ''));
  return r;
}

/** The product's store-filter values: one checkbox per value, named values[] with "attributeId:slug". */
export async function setProductAttributesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const values = form.getAll('values[]').map(v => String(v).split(':')).map(([attributeId, slug]) => ({ attributeId, slug }));
  const r = await handle(setProductAttributesInput, form, async input => {
    const { changed } = await setProductAttributes(db(), actor, input, await requestContext());
    return { ok: true, message: changed ? 'Store filters saved.' : 'No changes to save.' };
  }, { values });
  if (r.ok) refresh(String(form.get('productId')));
  return r;
}

/** M11: status for many products at once (each checked and audited as on its own page). */
export async function bulkStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(bulkProductStatusInput, form, async input => {
    const { done, failed } = await bulkSetProductStatus(db(), actor, input, await requestContext());
    return { ok: failed.length === 0, message: `${done.length} product${done.length === 1 ? '' : 's'} updated.${failed.length ? ` Not changed: ${failed.map(f => `${f.productId} (${f.reason})`).join('; ')}` : ''}` };
  });
  refresh();
  return r;
}

/** The product's minimum price after a staff discount (2026-10-01). Empty removes it. */
export async function setMinPriceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(productMinPriceInput, form, async input => {
    await setProductMinPrice(db(), actor, { productId: input.productId, minPricePaise: input.minPrice }, await requestContext());
    return { ok: true, message: input.minPrice === null ? 'Minimum price removed.' : `Minimum price set to ₹${paiseToRupees(input.minPrice)}.` };
  });
  if (r.ok) revalidatePath(`/products/${String(form.get('productId'))}`);
  return r;
}
