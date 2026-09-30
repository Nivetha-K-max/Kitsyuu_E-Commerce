'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { staffTicketInput, ticketReplyInput, ticketUpdateInput, type ActionState } from '@kitsyuu/contracts';
import { notifyTicketReply, openStaffTicket, replyToTicket, updateTicket } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/support', 'layout'); return r; };

export async function replyTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ticketReplyInput, form, async input => {
    const r = await replyToTicket(db(), actor, input, await requestContext());
    const mail = r.emailCustomer ? await notifyTicketReply(db(), mailer(), input.ticketId, { storeUrl: process.env.STORE_URL || null }) : null;
    return { ok: true, message: input.internal ? 'Internal note added (not visible to the customer).'
      : `Reply added; the customer sees it in their account.${mail?.sent ? ' They were emailed.' : mail?.reason === 'off' ? ' (Reply emails are off in Settings.)' : ''}` };
  }));
}

export async function updateTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ticketUpdateInput, form, async input => {
    const r = await updateTicket(db(), actor, input, await requestContext());
    return { ok: true, message: r.changed ? 'Ticket updated.' : 'No change.' };
  }));
}

export async function openTicketAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(staffTicketInput, form, async input => { id = (await openStaffTicket(db(), actor, input, await requestContext())).id; });
  if (id) { revalidatePath('/support', 'layout'); redirect(`/support/${id}`); }
  return r;
}
