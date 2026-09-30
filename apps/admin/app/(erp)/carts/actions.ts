'use server';
import { revalidatePath } from 'next/cache';
import { cartRecoveryInput, sendCartRecoveryInput, type ActionState } from '@kitsyuu/contracts';
import { can } from '@kitsyuu/auth';
import { sendAbandonedCheckoutReminders, sendCartReminder, setCartRecovery } from '@kitsyuu/core';
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

/** Client change request: send the due abandoned-checkout reminders now (the job does the same on a schedule). */
export async function sendCheckoutRemindersAction(_: ActionState): Promise<ActionState> {
  const actor = await requireActor();
  if (!can(actor, 'carts.manage')) return { ok: false, message: 'You do not have permission to do that.' };
  const r = await sendAbandonedCheckoutReminders(db(), mailer(), { storeUrl: process.env.STORE_URL || null });
  revalidatePath('/carts', 'layout');
  if (r.skipped === 'off') return { ok: false, message: 'Reminder emails are switched off in Settings.' };
  if (r.skipped === 'no_provider') return { ok: false, message: 'No email provider is configured, so nothing was sent.' };
  return { ok: r.failed === 0, message: `${r.sent} reminder(s) sent${r.failed ? `, ${r.failed} failed (see Notifications → email outbox)` : ''}.` };
}
