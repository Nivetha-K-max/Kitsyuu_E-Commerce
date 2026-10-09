'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { codCancelInput, codCollectInput, orderEditInput, orderEditRefundInput, packingStateInput, paiseToRupees, shipmentTrackingInput, updateOrderStatusInput, uuid, type ActionState } from '@kitsyuu/contracts';
import { cancelCodOrder, createStaffReturn, editOrder, notifyOrderDelivered, notifyOrderPacked, notifyOrderStatus, notifyOrderTracking, recordCodCollected, refundOrderEdit, setPackingState, settingsShipping, updateOrderStatus, updateShipmentTracking } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { refundProvider } from '@/lib/payments';
import { STATUS_LABEL } from '@/lib/format';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

export async function updateOrderStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateOrderStatusInput, form, async input => {
    const res = await updateOrderStatus(db(), actor, input, await requestContext());
    const stock = res.released.length ? ` Returned ${res.released.reduce((n, x) => n + x.qty, 0)} unit(s) to stock.` : '';
    // M17: the customer email (when switched on in Configuration) goes out after the change is committed; a failure is logged, never undone.
    const event = res.to === 'shipped' ? 'order.shipped' : res.to === 'cancelled' ? 'order.cancelled' : null;
    const mail = event ? await notifyOrderStatus(db(), mailer(), input.orderId, event, { storeUrl: process.env.STORE_URL || null })
      : res.to === 'delivered' ? await notifyOrderDelivered(db(), mailer(), input.orderId, { storeUrl: process.env.STORE_URL || null }) : null;   // ERP module 8
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
    // 2026-10-01: the "order packed" email (Configuration → Customer emails; off by default). Never blocks the change.
    if (res.packingState === 'packed') await notifyOrderPacked(db(), mailer(), input.orderId, process.env.STORE_URL || null);
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
    // 2026-10-08: the tracking email (Configuration → Customer emails; off by default). One per tracking number; never blocks the change.
    const mail = await notifyOrderTracking(db(), mailer(), input.orderId, process.env.STORE_URL || null);
    return { ok: true, message: `${res.orderNumber}: tracking details saved.${mail.sent ? ' The customer was emailed.' : ''}` };
  });
  if (r.ok) { revalidatePath('/orders', 'layout'); revalidatePath('/dashboard'); }
  return r;
}

// ---------------------------------------------------------------- client change request, second pass
const rupees = (p: number) => `₹${paiseToRupees(p)}`;
const refresh = () => { revalidatePath('/orders', 'layout'); revalidatePath('/inventory'); revalidatePath('/dashboard'); revalidatePath('/payments', 'layout'); };

/** Edits an order before it ships (sizes, quantities, delivery address); amounts are worked out again on the server. */
export async function editOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(orderEditInput, form, async input => {
    const res = await editOrder(db(), actor, input, await requestContext(), { shipping: settingsShipping(() => db()) });
    const money = res.cod ? ` The customer pays ${rupees(res.totalAfter)} on delivery.` : res.refundDuePaise > 0 ? ` Refund due: ${rupees(res.refundDuePaise)} (see Order edits).` : '';
    return { ok: true, message: `${res.orderNumber} edited: total ${rupees(res.totalBefore)} → ${rupees(res.totalAfter)}.${money}` };
  });
  if (r.ok) refresh();
  return r;
}

/** Refunds the difference an edit left: through the payment provider, or recorded as paid outside the platform. */
export async function refundOrderEditAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(orderEditRefundInput, form, async input => {
    const res = await refundOrderEdit(db(), actor, input.mode === 'provider' ? refundProvider() : null, input, await requestContext());
    return { ok: true, message: res.status === 'processed' ? 'Refund made.' : 'Refund sent to the payment provider; it shows as pending until the provider confirms it.' };
  });
  if (r.ok) refresh();
  return r;
}

/** Cash on delivery: the cash was collected. */
export async function codCollectAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(codCollectInput, form, async input => {
    const res = await recordCodCollected(db(), actor, { orderId: input.orderId, amountPaise: input.amount, reference: input.reference, note: input.note }, await requestContext());
    return { ok: true, message: `${res.orderNumber}: cash collected; the order is paid.` };
  });
  if (r.ok) refresh();
  return r;
}

/** Cash on delivery: cancel before dispatch, or record that the customer refused the parcel. */
export async function codCancelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(codCancelInput, form, async input => {
    const res = await cancelCodOrder(db(), actor, input, await requestContext());
    // The same "shop cancelled your order" email as other cancellations (only when switched on in Configuration).
    const mail = input.kind === 'cancel' ? await notifyOrderStatus(db(), mailer(), input.orderId, 'order.cancelled', { storeUrl: process.env.STORE_URL || null }) : null;
    const note = mail?.sent ? ' The customer was emailed.' : '';
    return { ok: true, message: `${res.orderNumber} cancelled.${res.unitsReturned ? ` Returned ${res.unitsReturned} unit(s) to stock.` : ''}${note}` };
  });
  if (r.ok) refresh();
  return r;
}

// ---------------------------------------------------------------- order control centre (2026-10-07)
const startReturnInput = z.object({ orderId: uuid, reasonCode: z.string().trim().min(1, 'Choose a reason.'), description: z.string().trim().max(2000).optional() });
/** Opens a return or exchange for this order on the customer's behalf, from the order's Returns tab. The rules are the
    return workflow's own (createStaffReturn: returns switched on, a delivered order inside the window, units still returnable). */
export async function startReturnAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '', orderId = '';
  const r = await handle(startReturnInput, form, async input => {
    const items = [...form.keys()].filter(k => k.startsWith('qty_')).map(k => ({ orderItemId: k.slice(4), qty: parseInt(String(form.get(k) ?? '0'), 10) || 0 })).filter(i => i.qty > 0);
    if (!items.length) return { ok: false, message: 'Enter the quantity being returned for at least one item.' };
    orderId = input.orderId;
    id = (await createStaffReturn(db(), actor, { orderId: input.orderId, reasonCode: input.reasonCode, description: input.description || null, items }, await requestContext())).id;
  });
  if (id) { revalidatePath('/orders', 'layout'); revalidatePath('/returns', 'layout'); redirect(`/orders/${orderId}?tab=returns&return=${id}`); }
  return r;
}
