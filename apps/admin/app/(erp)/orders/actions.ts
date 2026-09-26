'use server';
import { revalidatePath } from 'next/cache';
import { updateOrderStatusInput, type ActionState } from '@kitsyuu/contracts';
import { updateOrderStatus } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { STATUS_LABEL } from '@/lib/format';
import { db, requestContext, requireActor } from '@/lib/server';

export async function updateOrderStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateOrderStatusInput, form, async input => {
    const res = await updateOrderStatus(db(), actor, input, await requestContext());
    const stock = res.released.length ? ` Returned ${res.released.reduce((n, x) => n + x.qty, 0)} unit(s) to stock.` : '';
    return { ok: true, message: `${res.orderNumber}: ${STATUS_LABEL[res.from]} → ${STATUS_LABEL[res.to]}.${stock}` };
  });
  if (r.ok) { revalidatePath('/orders', 'layout'); revalidatePath('/inventory'); revalidatePath('/dashboard'); }
  return r;
}
