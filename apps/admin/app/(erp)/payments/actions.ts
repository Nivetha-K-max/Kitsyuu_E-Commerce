'use server';
import { revalidatePath } from 'next/cache';
import { recordManualRefundInput, type ActionState } from '@kitsyuu/contracts';
import { recordManualRefund } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { formatPaise } from '@/lib/format';
import { db, requestContext, requireActor } from '@/lib/server';

/** Records that money received for a cancelled order must be refunded by hand. No payment provider is called. */
export async function recordManualRefundAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(recordManualRefundInput, form, async input => {
    const res = await recordManualRefund(db(), actor, input, await requestContext());
    return { ok: true, message: `${res.orderNumber}: manual refund of ${formatPaise(res.amountPaise)} recorded. Pay it back outside the system.` };
  });
  if (r.ok) { revalidatePath('/payments'); revalidatePath('/orders', 'layout'); revalidatePath('/dashboard'); }
  return r;
}
