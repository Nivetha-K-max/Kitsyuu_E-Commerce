'use server';
/* The first-order offer (2026-10-12): a signed-in customer asks to use it. The action takes NO arguments: who is asking is
   the session, and which coupon it is and whether this customer may use it are the server's own records (core:
   claimFirstOrderOffer). It only puts the coupon on the customer's cart; what it takes off is worked out with the cart
   and limited again when the order is placed. */
import { revalidatePath } from 'next/cache';
import { DomainError } from '@kitsyuu/contracts';
import { claimFirstOrderOffer } from '@kitsyuu/core';
import { limited } from '@/lib/rate-limit';
import { currentCustomer, db, requestContext } from '@/lib/server';

export async function claimFirstOfferAction(): Promise<{ ok: boolean; message: string }> {
  const me = await currentCustomer();
  if (!me) return { ok: false, message: 'Sign in to use this offer.' };
  const wait = await limited('coupon', me.customerId);
  if (wait) return { ok: false, message: wait };
  try {
    const r = await claimFirstOrderOffer(db(), me, await requestContext());
    revalidatePath('/checkout'); revalidatePath('/cart');
    return { ok: true, message: `${r.already ? 'This offer is already on your cart' : 'Added to your cart'}: coupon ${r.code} is applied at checkout when your order qualifies.` };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    console.error('[offer]', (e as Error).message);
    return { ok: false, message: 'The offer could not be added right now. Nothing was changed.' };
  }
}
