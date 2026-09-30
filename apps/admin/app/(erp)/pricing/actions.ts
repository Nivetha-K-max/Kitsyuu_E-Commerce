'use server';
import { revalidatePath } from 'next/cache';
import {
  bulkPriceInput, cancelPriceChangeInput, discountInput, productPricingInput, productSaleInput, schedulePriceInput, setDiscountActiveInput, type ActionState,
} from '@kitsyuu/contracts';
import { bulkUpdatePrices, cancelPriceChange, saveDiscount, schedulePriceChange, setDiscountActive, setProductPricing, setProductSale } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/pricing', 'layout'); return r; };

export async function setPricingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(productPricingInput, form, async input => {
    const r = await setProductPricing(db(), actor, input, await requestContext());
    return { ok: true, message: r.changed ? 'Price saved. It applies to carts priced from now on; placed orders keep their price.' : 'No change.' };
  }));
}

export async function schedulePriceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(schedulePriceInput, form, async input => {
    await schedulePriceChange(db(), actor, input, await requestContext());
    return { ok: true, message: 'Price change scheduled.' };
  }));
}

export async function cancelPriceChangeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(cancelPriceChangeInput, form, async input => {
    await cancelPriceChange(db(), actor, input, await requestContext());
    return { ok: true, message: 'Scheduled change cancelled.' };
  }));
}

export async function bulkPriceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(bulkPriceInput, form, async input => {
    const r = await bulkUpdatePrices(db(), actor, input, await requestContext());
    return { ok: true, message: `${r.changed} product price${r.changed === 1 ? '' : 's'} changed.${r.sizeOverrides ? ` ${r.sizeOverrides} size${r.sizeOverrides === 1 ? ' has' : 's have'} its own price and was left as it is.` : ''}` };
  }));
}

export async function saveDiscountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(discountInput, form, async input => {
    const r = await saveDiscount(db(), actor, input, await requestContext());
    return { ok: true, message: r.created ? 'Discount created.' : 'Discount saved.' };
  }));
}

export async function setDiscountActiveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(setDiscountActiveInput, form, async input => {
    await setDiscountActive(db(), actor, input, await requestContext());
    return { ok: true, message: input.active ? 'Discount switched on.' : 'Discount switched off.' };
  }));
}

/** Client change request: the sale price (separate from the base price, which never changes). */
export async function setSaleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(productSaleInput, form, async input => {
    const r = await setProductSale(db(), actor, input, await requestContext());
    return { ok: true, message: !r.changed ? 'No change.' : input.salePrice === null ? 'Sale ended: customers pay the price.' : 'Sale price saved. The price itself is unchanged.' };
  }));
}
