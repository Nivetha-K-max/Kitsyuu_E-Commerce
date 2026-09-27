'use server';
/* Customer account actions (M6). Every action re-checks the session on the server and passes the signed-in customer to
   the service, which scopes every query to that customer; ids in the form are only ever looked up within their rows. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { addressIdInput, addressInput, changePasswordInput, customerProfileInput, sessionIdInput, type ActionState } from '@kitsyuu/contracts';
import { changeCustomerPassword, endCustomerSession, logoutCustomerEverywhere } from '@kitsyuu/auth';
import { deleteCustomerAddress, saveCustomerAddress, setDefaultCustomerAddress, updateCustomerProfile } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { clearSessionCookie, db, requestContext, requireCustomer } from '@/lib/server';

export async function updateProfileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/profile');
  return handle(customerProfileInput, form, async input => {
    await updateCustomerProfile(db(), me, input, await requestContext());
    revalidatePath('/account', 'layout');
    return { ok: true, message: 'Your details have been saved.' };
  });
}

export async function saveAddressAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/addresses');
  let saved = '';
  const result = await handle(addressInput, form, async input => {
    await saveCustomerAddress(db(), me, input, await requestContext());
    saved = input.addressId ? 'updated' : 'added';
    return { ok: true };
  });
  if (saved) {
    revalidatePath('/account', 'layout');
    redirect(form.get('next') === '/checkout' ? '/checkout' : `/account/addresses?notice=${saved}`);   // only this one destination
  }
  return result;
}

export async function deleteAddressAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/addresses');
  return handle(addressIdInput, form, async input => {
    await deleteCustomerAddress(db(), me, input.addressId, await requestContext());
    revalidatePath('/account', 'layout');
    return { ok: true, message: 'Address removed.' };
  });
}

export async function setDefaultAddressAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/addresses');
  return handle(addressIdInput, form, async input => {
    await setDefaultCustomerAddress(db(), me, input.addressId, await requestContext());
    revalidatePath('/account', 'layout');
    return { ok: true, message: 'Default address updated.' };
  });
}

export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/security');
  return handle(changePasswordInput, form, async input => {
    const r = await changeCustomerPassword(db(), me, input, await requestContext());
    if (!r.ok) return { ok: false, fieldErrors: { current: 'That is not your current password.' }, message: 'Check the highlighted fields.' };
    revalidatePath('/account/security');
    return { ok: true, message: 'Password changed. You have been signed out on your other devices.' };
  });
}

export async function endSessionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/security');
  return handle(sessionIdInput, form, async input => {
    const ended = await endCustomerSession(db(), me, input.sessionId, await requestContext());
    revalidatePath('/account/security');
    return ended ? { ok: true, message: 'That device has been signed out.' } : { ok: false, message: 'That session had already ended.' };
  });
}

export async function logoutEverywhereAction(): Promise<void> {
  const me = await requireCustomer('/account/security');
  await logoutCustomerEverywhere(db(), me, await requestContext());
  await clearSessionCookie();
  redirect('/login?reason=loggedout');
}
