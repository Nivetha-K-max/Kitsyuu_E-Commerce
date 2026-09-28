'use server';
/* M18: two-factor sign-in for the signed-in staff member. Enrolment shows the secret once; confirmation shows the
   recovery codes once. Nothing secret is ever written to the page afterwards. */
import { revalidatePath } from 'next/cache';
import { confirmStaffMfa, disableStaffMfa, startStaffMfa } from '@kitsyuu/auth';
import { db, requestContext, requireActor } from '@/lib/server';

export type MfaState = { step?: 'scan' | 'codes' | 'off'; secret?: string; uri?: string; codes?: string[]; error?: string };

export async function startMfaAction(): Promise<MfaState> {
  const actor = await requireActor();
  const r = await startStaffMfa(db(), actor, actor.email);
  if (!r.ok) return { error: r.error === 'unavailable' ? 'Two-factor sign-in is not set up on this server (MFA_ENCRYPTION_KEY).' : 'Two-factor sign-in is already on.' };
  return { step: 'scan', secret: r.secret, uri: r.uri };
}

export async function confirmMfaAction(prev: MfaState, form: FormData): Promise<MfaState> {
  const actor = await requireActor();
  const code = String(form.get('code') ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { ...prev, error: 'Enter the 6-digit code from your authenticator app.' };
  const r = await confirmStaffMfa(db(), actor, code, await requestContext());
  if (!r.ok) return { ...prev, error: r.error === 'bad_code' ? 'That code is not valid. Check the time on your phone and try the current code.' : 'Start again: the enrolment is no longer pending.' };
  revalidatePath('/account');
  return { step: 'codes', codes: r.recoveryCodes };
}

export async function disableMfaAction(_: MfaState, form: FormData): Promise<MfaState> {
  const actor = await requireActor();
  const r = await disableStaffMfa(db(), actor, String(form.get('password') ?? ''), await requestContext());
  if (!r.ok) return { error: 'Your password is not correct. Two-factor sign-in is still on.' };
  revalidatePath('/account');
  return { step: 'off' };
}
