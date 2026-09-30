'use server';
import { revalidatePath } from 'next/cache';
import { cartRecoveryInput, sendCartRecoveryInput, type ActionState } from '@kitsyuu/contracts';
import { sendCartReminder, setCartRecovery } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, mailer, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/carts', 'layout'); return r; };

export async function cartRecoveryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(cartRecoveryInput, form, async input => { await setCartRecovery(db(), actor, input, await requestContext()); return { ok: true, message: 'Recovery status saved. The cart itself is unchanged.' }; }));
}

export async function sendReminderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(sendCartRecoveryInput, form, async input => {
    const r = await sendCartReminder(db(), actor, mailer(), input, await requestContext(), { storeUrl: process.env.STORE_URL || null });
    if (r.sent) return { ok: true, message: 'Reminder email sent.' };
    return { ok: false, message: r.reason === 'off' ? 'Reminder emails are switched off (Settings → Customer emails).' : r.reason === 'no_recipient' ? 'Nothing to send (no email address or no products still on sale).' : 'The email could not be sent (see Notifications → email outbox).' };
  }));
}
