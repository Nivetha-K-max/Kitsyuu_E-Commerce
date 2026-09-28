'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createPurchaseOrderInput, poLineInput, poStatusInput, receiveGoodsInput, removePoLineInput, type ActionState } from '@kitsyuu/contracts';
import { createPurchaseOrder, receiveGoods, removePoLine, setPoLine, setPurchaseOrderStatus } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => { revalidatePath('/purchase-orders'); if (id) revalidatePath(`/purchase-orders/${id}`); revalidatePath('/materials'); };

export async function createPurchaseOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(createPurchaseOrderInput, form, async input => { id = (await createPurchaseOrder(db(), actor, input, await requestContext())).id; });
  if (id) { refresh(); redirect(`/purchase-orders/${id}`); }
  return r;
}
export async function setPoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(poLineInput, form, async input => { await setPoLine(db(), actor, input, await requestContext()); return { ok: true, message: 'Line saved.' }; });
  if (r.ok) refresh(String(form.get('purchaseOrderId')));
  return r;
}
export async function removePoLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(removePoLineInput, form, async input => { await removePoLine(db(), actor, input, await requestContext()); return { ok: true, message: 'Line removed.' }; });
  if (r.ok) refresh(String(form.get('purchaseOrderId')));
  return r;
}
export async function poStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(poStatusInput, form, async input => {
    await setPurchaseOrderStatus(db(), actor, input, await requestContext());
    return { ok: true, message: input.status === 'ordered' ? 'Order placed.' : 'Order cancelled.' };
  });
  if (r.ok) refresh(String(form.get('purchaseOrderId')));
  return r;
}
export async function receiveGoodsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  // One quantity field per line, named received:<lineId>; empty fields mean "nothing arrived".
  const lines = [...form.entries()].filter(([k]) => k.startsWith('received:')).map(([k, v]) => ({ lineId: k.slice(9), qty: String(v).trim() }))
    .filter(l => l.qty !== '');
  const r = await handle(receiveGoodsInput, form, async input => {
    const res = await receiveGoods(db(), actor, input, await requestContext());
    return { ok: true, message: res.status === 'received' ? 'Delivery recorded. The order is fully received.' : 'Delivery recorded. Some items are still to come.' };
  }, { lines });
  if (r.ok) refresh(String(form.get('purchaseOrderId')));
  return r;
}
