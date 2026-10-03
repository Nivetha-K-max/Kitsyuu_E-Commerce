'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { draftAddressesInput, draftConfirmInput, draftCreateInput, draftDiscountInput, draftIdInput, draftItemInput, draftNoteInput, type ActionState } from '@kitsyuu/contracts';
import { cancelDraftOrder, confirmDraftOrder, createDraftOrder, notifyPaymentRequest, sendOrderPlacedEmail, setDraftAddresses, setDraftDiscount, setDraftItem, setDraftNote, settingsShipping } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => { revalidatePath('/drafts'); if (id) revalidatePath(`/drafts/${id}`); revalidatePath('/customers', 'layout'); };
/** Delivery charges come from Configuration → Shipping, exactly as at checkout. */
const config = () => ({ shipping: settingsShipping(() => db()), discounts: [] });

export async function createDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(draftCreateInput, form, async input => {
    let customerId = input.customerId ?? null;
    // Staff can also find the customer by email.
    const email = String(form.get('customerEmail') ?? '').trim().toLowerCase();
    if (!customerId && email) {
      const c = await db().selectFrom('customers').select('id').where('email', '=', email).executeTakeFirst();
      if (!c) return { ok: false, fieldErrors: { customerEmail: 'No customer account uses this email.' }, message: 'Check the highlighted fields.' };
      customerId = c.id;
    }
    id = (await createDraftOrder(db(), actor, { channel: input.channel, customerId, locationId: input.locationId ?? null,
      contact: { name: input.contactName, phone: input.contactPhone, email: input.contactEmail }, note: input.note }, await requestContext())).id;
  });
  if (id) { refresh(); redirect(`/drafts/${id}`); }
  return r;
}

export async function setDraftItemAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(draftItemInput, form, async input => {
    await setDraftItem(db(), actor, input, await requestContext());
    return { ok: true, message: input.qty === 0 ? 'Item removed.' : 'Item saved.' };
  });
  if (r.ok) refresh(String(form.get('draftId')));
  return r;
}

export async function setDraftAddressesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(draftAddressesInput, form, async input => {
    await setDraftAddresses(db(), actor, input, await requestContext());
    return { ok: true, message: 'Addresses saved.' };
  });
  if (r.ok) refresh(String(form.get('draftId')));
  return r;
}

export async function setDraftDiscountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(draftDiscountInput, form, async input => {
    await setDraftDiscount(db(), actor, { draftId: input.draftId, percent: input.percent, reason: input.reason }, await requestContext());
    return { ok: true, message: input.percent > 0 ? `Discount of ${input.percent}% saved.` : 'Discount removed.' };
  });
  if (r.ok) refresh(String(form.get('draftId')));
  return r;
}

export async function setDraftNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(draftNoteInput, form, async input => { await setDraftNote(db(), actor, input, await requestContext()); return { ok: true, message: 'Note saved.' }; });
  if (r.ok) refresh(String(form.get('draftId')));
  return r;
}

export async function cancelDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(draftIdInput, form, async input => { await cancelDraftOrder(db(), actor, input, await requestContext()); return { ok: true, message: 'Draft cancelled.' }; });
  if (r.ok) refresh(String(form.get('draftId')));
  return r;
}

/** Creates the order. Online payment: the customer pays from their account (and gets the link by email when that email is on). */
export async function confirmDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let orderId = '';
  const r = await handle(draftConfirmInput, form, async input => {
    const res = await confirmDraftOrder(db(), actor, input, await requestContext(), config());
    orderId = res.orderId;
    const store = process.env.STORE_URL || null;
    if (res.payment === 'online') await notifyPaymentRequest(db(), mailer(), res.orderId, store);
    // Cash on delivery or paid in the store: the order is placed now, so the customer gets the "order confirmed" email (when
    // they have an email address; a walk-in customer may have none — the order is placed either way). Logged, sent once.
    else await sendOrderPlacedEmail(db(), mailer(), res.orderNumber, { orderUrl: store ? new URL(`/account/orders/${encodeURIComponent(res.orderNumber)}`, store).toString() : '' });
  });
  if (orderId) { refresh(String(form.get('draftId'))); revalidatePath('/orders'); redirect(`/orders/${orderId}?created=1`); }
  return r;
}
