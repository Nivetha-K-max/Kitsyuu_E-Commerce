'use server';
/* ERP modules 3 and 5, customer side: return requests and support tickets. The session is re-checked here; the services
   scope every read and write to the signed-in customer and check that returns are switched on. */
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cancelReturnInput, customerTicketInput, customerTicketReplyInput, DomainError, returnRequestInput, type ActionState } from '@kitsyuu/contracts';
import { cancelReturnByCustomer, openCustomerTicket, replyAsCustomer, requestReturn } from '@kitsyuu/core';
import { GENERIC_ERROR, handle } from '@/lib/actions';
import { db, requestContext, requireCustomer } from '@/lib/server';

export async function requestReturnAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/orders');
  // Quantities come as qty_<order line id>; the schema checks them (and at least one).
  const items = [...form.keys()].filter(k => k.startsWith('qty_')).map(k => ({ orderItemId: k.slice(4), qty: String(form.get(k) ?? '0') }));
  const parsed = returnRequestInput.safeParse({ orderNumber: form.get('orderNumber'), reasonCode: form.get('reasonCode'), description: form.get('description') ?? '', items });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue?.path[0] === 'items' ? 'Choose at least one item and quantity.' : issue?.path[0] === 'reasonCode' ? 'Choose a reason.' : 'Check the form.' };
  }
  let number = '';
  try {
    number = (await requestReturn(db(), me, parsed.data, await requestContext())).number;
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    const ref = randomUUID().slice(0, 8);
    console.error(`[website action] ref=${ref}`, e);
    return { ok: false, message: `${GENERIC_ERROR} (Reference ${ref})` };
  }
  revalidatePath('/account', 'layout');
  redirect(`/account/returns/${number}?sent=1`);
}

export async function cancelReturnAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/returns');
  const r = await handle(cancelReturnInput, form, async input => { await cancelReturnByCustomer(db(), me, input, await requestContext()); return { ok: true, message: 'Your return request is cancelled.' }; });
  if (r.ok) revalidatePath('/account', 'layout');
  return r;
}

export async function openTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/support/new');
  let number = '';
  const r = await handle(customerTicketInput, form, async input => { number = (await openCustomerTicket(db(), me, input, await requestContext())).number; });
  if (number) { revalidatePath('/account', 'layout'); redirect(`/account/support/${number}?sent=1`); }
  return r;
}

export async function replyTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/support');
  const r = await handle(customerTicketReplyInput, form, async input => { await replyAsCustomer(db(), me, input, await requestContext()); return { ok: true, message: 'Message sent.' }; });
  if (r.ok) revalidatePath('/account', 'layout');
  return r;
}
