'use server';
import { revalidatePath } from 'next/cache';
import { packingStateInput, shipmentTrackingInput, updateOrderStatusInput, type ActionState } from '@kitsyuu/contracts';
import { notifyOrderStatus, setPackingState, updateOrderStatus, updateShipmentTracking } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { STATUS_LABEL } from '@/lib/format';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

export async function updateOrderStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateOrderStatusInput, form, async input => {
    const res = await updateOrderStatus(db(), actor, input, await requestContext());
    const stock = res.released.length ? ` Returned ${res.released.reduce((n, x) => n + x.qty, 0)} unit(s) to stock.` : '';
    // M17: the customer email (when switched on in Settings) goes out after the change is committed; a failure is logged, never undone.
    const event = res.to === 'shipped' ? 'order.shipped' : res.to === 'cancelled' ? 'order.cancelled' : null;
    const mail = event ? await notifyOrderStatus(db(), mailer(), input.orderId, event, { storeUrl: process.env.STORE_URL || null }) : null;
    const note = mail?.sent ? ' The customer was emailed.' : mail?.reason === 'failed' ? ' The customer email could not be sent (see System).' : '';
    return { ok: true, message: `${res.orderNumber}: ${STATUS_LABEL[res.from]} → ${STATUS_LABEL[res.to]}.${stock}${note}` };
  });
  if (r.ok) { revalidatePath('/orders', 'layout'); revalidatePath('/inventory'); revalidatePath('/dashboard'); }
  return r;
}

/** Packing progress while an order is processing (the order status does not change). */
export async function setPackingStateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(packingStateInput, form, async input => {
    const res = await setPackingState(db(), actor, input, await requestContext());
    return { ok: true, message: `${res.orderNumber}: packing is ${STATUS_LABEL[res.packingState].toLowerCase()}.` };
  });
  if (r.ok) { revalidatePath('/orders', 'layout'); revalidatePath('/dashboard'); }
  return r;
}

/** Adds or corrects the courier and tracking number of a shipped order (tracking stays optional). */
export async function updateShipmentTrackingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(shipmentTrackingInput, form, async input => {
    const res = await updateShipmentTracking(db(), actor, input, await requestContext());
    return { ok: true, message: `${res.orderNumber}: tracking details saved.` };
  });
  if (r.ok) { revalidatePath('/orders', 'layout'); revalidatePath('/dashboard'); }
  return r;
}
