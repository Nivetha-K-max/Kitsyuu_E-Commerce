'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { transferCancelInput, transferCreateInput, transferIdInput, type ActionState } from '@kitsyuu/contracts';
import { cancelTransfer, createTransfer, receiveTransfer, sendTransfer } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => {
  revalidatePath('/transfers'); if (id) revalidatePath(`/transfers/${id}`);
  revalidatePath('/locations', 'layout'); revalidatePath('/inventory'); revalidatePath('/products', 'layout');
};

/** One quantity field per size, named qty:<variantId>; empty fields are skipped. */
export async function createTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const entries = [...form.entries()].filter(([k, v]) => k.startsWith('qty:') && String(v).trim() !== '');
  if (entries.some(([, v]) => !/^\d{1,6}$/.test(String(v).trim()))) return { ok: false, message: 'Quantities must be whole numbers.' };
  let id = '';
  const r = await handle(transferCreateInput, form, async input => {
    id = (await createTransfer(db(), actor, { ...input, lines: entries.map(([k, v]) => ({ variantId: k.slice(4), qty: Number(String(v).trim()) })) }, await requestContext())).id;
  });
  if (id) { refresh(); redirect(`/transfers/${id}`); }
  return r;
}

export async function sendTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(transferIdInput, form, async input => {
    const res = await sendTransfer(db(), actor, input, await requestContext());
    return { ok: true, message: `Sent: ${res.units} unit(s) left the sending location.` };
  });
  if (r.ok) refresh(String(form.get('transferId')));
  return r;
}

export async function receiveTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(transferIdInput, form, async input => {
    const res = await receiveTransfer(db(), actor, input, await requestContext());
    return { ok: true, message: `Received: ${res.units} unit(s) added to the receiving location.` };
  });
  if (r.ok) refresh(String(form.get('transferId')));
  return r;
}

export async function cancelTransferAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(transferCancelInput, form, async input => {
    const res = await cancelTransfer(db(), actor, input, await requestContext());
    return { ok: true, message: res.unitsReturned ? `Cancelled: ${res.unitsReturned} unit(s) returned to the sending location.` : 'Cancelled. No stock had moved.' };
  });
  if (r.ok) refresh(String(form.get('transferId')));
  return r;
}
