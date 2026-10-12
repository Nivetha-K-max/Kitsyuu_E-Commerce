'use server';
import { revalidatePath } from 'next/cache';
import { refundInput, returnActionInput, returnItemInput, settleRefundInput, type ActionState } from '@kitsyuu/contracts';
import { notifyReturn, refundReturn, returnAction, settlePendingRefund, updateReturnItem } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { refundProvider } from '@/lib/payments';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const storeUrl = () => process.env.STORE_URL || null;
const done = (r: ActionState) => { if (r.ok) { revalidatePath('/returns', 'layout'); revalidatePath('/orders', 'layout'); revalidatePath('/payments', 'layout'); revalidatePath('/inventory'); } return r; };

export async function returnStepAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(returnActionInput, form, async input => {
    const r = await returnAction(db(), actor, input, await requestContext());
    // The customer is emailed (when switched on) for the steps they need to know about.
    const mail = ['approved', 'rejected', 'info_requested', 'completed'].includes(r.to) ? await notifyReturn(db(), mailer(), input.returnId, 'status', { storeUrl: storeUrl() }) : null;
    return { ok: true, message: `${r.number}: ${r.from.replace(/_/g, ' ')} → ${r.to.replace(/_/g, ' ')}.${mail?.sent ? ' The customer was emailed.' : ''}` };
  }));
}

export async function returnItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(returnItemInput, form, async input => {
    const r = await updateReturnItem(db(), actor, input, await requestContext());
    return { ok: true, message: !r.changed ? 'No change.' : 'restocked' in r ? `${r.restocked} unit(s) put back into stock.` : 'Replacement size saved.' };
  }));
}

export async function refundAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(refundInput, form, async input => {
    const r = await refundReturn(db(), actor, input.mode === 'provider' ? refundProvider() : null, { ...input, amount: input.amount! }, await requestContext());
    const mail = r.status === 'processed' ? await notifyReturn(db(), mailer(), input.returnId, 'refund', { storeUrl: storeUrl() }) : null;
    return { ok: true, message: r.status === 'processed'
      ? `Refund recorded as made.${mail?.sent ? ' The customer was emailed.' : ''}`
      : 'The payment provider accepted the refund; it is pending until the provider completes it.' };
  }));
}

/** 2026-10-12: a provider refund that stayed pending is settled with what staff found at the provider (core checks the
    permission, that it is still pending and old enough, and records who said so). No provider is called. */
export async function settleRefundAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(settleRefundInput, form, async input => {
    const r = await settlePendingRefund(db(), actor, input, await requestContext());
    const mail = r.status === 'processed' && r.returnId ? await notifyReturn(db(), mailer(), r.returnId, 'refund', { storeUrl: storeUrl() }) : null;
    return { ok: true, message: r.status === 'processed'
      ? `Refund recorded as made by the provider.${mail?.sent ? ' The customer was emailed.' : ''}`
      : 'Refund recorded as not made. The amount can be refunded again.' };
  }));
}
