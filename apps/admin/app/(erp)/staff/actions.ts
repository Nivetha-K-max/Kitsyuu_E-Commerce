'use server';
/* Staff mutations. The actor comes from the session cookie (never from the form); core services check permissions,
   escalation and lockout rules and write the audit record in the same transaction. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { inviteStaffInput, setStaffRolesInput, setStaffStatusInput, updateStaffInput, uuid, type ActionState, DomainError } from '@kitsyuu/contracts';
import { inviteStaff, resendInvite, revokeStaffSessions, setStaffRoles, setStaffStatus, updateStaff, resetStaffTwoFactor } from '@kitsyuu/core';
import { z } from 'zod';
import { handle } from '@/lib/actions';
import { db, inviteUrl, mailer, requestContext, requireActor } from '@/lib/server';

const ctx = async () => ({ ...(await requestContext()), inviteUrl });
const staffIdOnly = z.object({ staffId: uuid });

export async function inviteStaffAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let staffId = '';
  const result = await handle(inviteStaffInput, form, async input => {
    staffId = (await inviteStaff(db(), mailer(), actor, input, await ctx())).staffId;
    return { ok: true };
  }, { roleIds: form.getAll('roleIds').map(String) });
  if (result.ok && staffId) { revalidatePath('/staff'); redirect(`/staff/${staffId}?notice=invited`); }
  return result;
}

export async function updateStaffAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(updateStaffInput, form, async input => { await updateStaff(db(), actor, input, await ctx()); return { ok: true, message: 'Details saved.' }; });
  if (r.ok) revalidatePath('/staff', 'layout');
  return r;
}

export async function setStaffRolesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setStaffRolesInput, form, async input => { await setStaffRoles(db(), actor, input, await ctx()); return { ok: true, message: 'Roles saved.' }; },
    { roleIds: form.getAll('roleIds').map(String) });
  if (r.ok) revalidatePath('/staff', 'layout');
  return r;
}

export async function setStaffStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(setStaffStatusInput, form, async input => {
    await setStaffStatus(db(), actor, input, await ctx());
    return { ok: true, message: input.status === 'disabled' ? 'Account disabled and signed out everywhere.' : 'Account re-enabled.' };
  });
  if (r.ok) revalidatePath('/staff', 'layout');
  return r;
}

export async function resendInviteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return handle(staffIdOnly, form, async input => { await resendInvite(db(), mailer(), actor, input.staffId, await ctx()); return { ok: true, message: 'A new invitation has been sent. Earlier links no longer work.' }; });
}

export async function revokeSessionsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(staffIdOnly, form, async input => { await revokeStaffSessions(db(), actor, input.staffId, await ctx()); return { ok: true, message: 'Signed out of every other session.' }; });
  if (r.ok) revalidatePath('/staff', 'layout');
  return r;
}

/** M18: removes another staff member's two-factor sign-in (lost phone) so they can set it up again. */
export async function resetTwoFactorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const staffId = String(form.get('staffId') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(staffId)) return { ok: false, message: 'Unknown staff member.' };
  try {
    const r = await resetStaffTwoFactor(db(), actor, staffId, await requestContext());
    revalidatePath(`/staff/${staffId}`);
    return { ok: true, message: r.removed ? 'Two-factor sign-in removed. They sign in with their password and can set it up again.' : 'Two-factor sign-in was not on.' };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    throw e;
  }
}
