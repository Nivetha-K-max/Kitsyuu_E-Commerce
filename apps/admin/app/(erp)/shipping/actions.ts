'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { courierInput, deleteShippingRateInput, shipmentUpdateInput, shippingRateInput, shippingZoneInput, type ActionState } from '@kitsyuu/contracts';
import { checkShippingQuote, deleteShippingRate, notifyOrderDelivered, notifyOrderTracking, saveCourier, saveShippingRate, saveShippingZone, updateShipmentStatus } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/shipping', 'layout'); return r; };

export async function saveZoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(shippingZoneInput, form, async input => { await saveShippingZone(db(), actor, input, await requestContext()); return { ok: true, message: input.zoneId ? 'Zone saved.' : 'Zone added.' }; }));
}
export async function saveRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(shippingRateInput, form, async input => { await saveShippingRate(db(), actor, input, await requestContext()); return { ok: true, message: input.rateId ? 'Rate saved.' : 'Rate added.' }; }));
}
export async function deleteRateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(deleteShippingRateInput, form, async input => { await deleteShippingRate(db(), actor, input, await requestContext()); return { ok: true, message: 'Rate deleted.' }; }));
}
export async function saveCourierAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(courierInput, form, async input => { await saveCourier(db(), actor, input, await requestContext()); return { ok: true, message: 'Courier saved.' }; }));
}
export async function updateShipmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(shipmentUpdateInput, form, async input => {
    const res = await updateShipmentStatus(db(), actor, input, await requestContext());
    // Delivered → the delivery email; in transit → the tracking email (each only when switched on, each sent once).
    const mail = res.delivered ? await notifyOrderDelivered(db(), mailer(), res.orderId, { storeUrl: process.env.STORE_URL || null })
      : res.to === 'in_transit' && res.from !== res.to ? await notifyOrderTracking(db(), mailer(), res.orderId, process.env.STORE_URL || null) : null;
    return { ok: true, message: `${res.orderNumber}: ${res.from === res.to ? 'updated' : `${res.from.replace(/_/g, ' ')} → ${res.to.replace(/_/g, ' ')}`}.${mail?.sent ? ' The customer was emailed.' : ''}` };
  });
  if (r.ok) revalidatePath('/orders', 'layout');
  return done(r);
}

const quoteInput = z.object({ state: z.string().trim().min(1, 'Choose a state.').max(60), pin: z.string().trim().regex(/^\d{6}$/, 'A 6-digit PIN.'),
  subtotal: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'An amount in rupees.').transform(v => Math.round(Number(v) * 100)) });
export async function checkQuoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return handle(quoteInput, form, async input => {
    const q = await checkShippingQuote(db(), actor, { state: input.state, pin: input.pin, subtotalPaise: input.subtotal });
    if (q.unavailable) return { ok: false, message: q.unavailable };
    if (!q.configured) return { ok: true, message: 'No zone rates are set up: nothing would be charged.' };
    return { ok: true, message: `${q.label}: ₹${(q.amountPaise / 100).toFixed(2)}${q.estimate ? ` · ${q.estimate}` : ''}` };
  });
}
