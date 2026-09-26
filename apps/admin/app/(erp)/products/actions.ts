'use server';
/* Product, price and stock mutations. The actor always comes from the session; core services check permissions,
   lock the row, and write the audit record in the same transaction as the change. */
import { revalidatePath } from 'next/cache';
import { adjustStockInput, paiseToRupees, setProductStatusInput, updatePriceInput, updateProductInput, type ActionState } from '@kitsyuu/contracts';
import { adjustStock, setProductStatus, updateProduct, updateProductPrice } from '@kitsyuu/core';
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
