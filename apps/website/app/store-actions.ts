'use server';
/* Cart and wishlist changes of a signed-in customer (M7). Next.js only runs server actions for same-origin requests, and
   every action re-checks the session, validates the input and lets the service resolve prices and stock from the database.
   Errors written for customers are shown; anything else is logged with a reference. */
import { randomUUID } from 'node:crypto';
import { cartLineInput, cartLineKey, DomainError, guestMergeInput, wishlistInput } from '@kitsyuu/contracts';
import { addCartLine, mergeGuestCart, mergeGuestWishlist, removeCartLine, setCartLineQty, setWishlisted } from '@kitsyuu/core';
import { currentCustomer, db } from '@/lib/server';
import { customerStore } from '@/lib/store-state';
import type { StoreResult } from '@/lib/types';

const SIGNED_OUT: StoreResult = { ok: false, message: 'Your session has ended. Log in again to keep using your saved cart.' };

async function run(work: (me: NonNullable<Awaited<ReturnType<typeof currentCustomer>>>) => Promise<Partial<StoreResult> | void>): Promise<StoreResult> {
  let me;
  try { me = await currentCustomer(); } catch (e) { return fail(e); }
  if (!me) return SIGNED_OUT;
  try {
    const extra = (await work(me)) ?? {};
    return { ok: true, ...extra, store: await customerStore(me) };
  } catch (e) {
    const r = fail(e);
    try { r.store = await customerStore(me); } catch {}
    return r;
  }
}
function fail(e: unknown): StoreResult {
  if (e instanceof DomainError) return { ok: false, message: e.message };
  const ref = randomUUID().slice(0, 8);
  console.error(`[store action] ref=${ref}`, e);
  return { ok: false, message: `We could not update your cart right now. Please try again. (Reference ${ref})` };
}
const invalid = (e: { issues: { message: string }[] }): StoreResult => ({ ok: false, message: e.issues[0]?.message ?? 'That change is not valid.' });

export async function addToCartAction(raw: unknown): Promise<StoreResult> {
  const input = cartLineInput.safeParse(raw);
  if (!input.success) return invalid(input.error);
  return run(async me => addCartLine(db(), me, input.data));
}
export async function setCartQtyAction(raw: unknown): Promise<StoreResult> {
  const input = cartLineInput.safeParse(raw);
  if (!input.success) return invalid(input.error);
  return run(async me => { await setCartLineQty(db(), me, input.data); });
}
export async function removeCartLineAction(raw: unknown): Promise<StoreResult> {
  const input = cartLineKey.safeParse(raw);
  if (!input.success) return invalid(input.error);
  return run(async me => { await removeCartLine(db(), me, input.data); });
}
export async function setWishlistedAction(raw: unknown, saved: boolean): Promise<StoreResult> {
  const input = wishlistInput.safeParse(raw);
  if (!input.success) return invalid(input.error);
  return run(async me => { await setWishlisted(db(), me, input.data.productId, saved === true); });
}
/** After login: the browser's guest cart and wishlist join the customer's saved ones. */
export async function mergeGuestStoreAction(raw: unknown): Promise<StoreResult> {
  const input = guestMergeInput.safeParse(raw);
  if (!input.success) return invalid(input.error);
  return run(async me => {
    await mergeGuestCart(db(), me, input.data.cart);
    await mergeGuestWishlist(db(), me, input.data.wishlist);
  });
}
