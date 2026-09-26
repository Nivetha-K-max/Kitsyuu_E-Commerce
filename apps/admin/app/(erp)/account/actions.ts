'use server';
import { changePasswordInput, type ActionState } from '@kitsyuu/contracts';
import { changeStaffPassword } from '@kitsyuu/auth';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return handle(changePasswordInput, form, async input => {
    const r = await changeStaffPassword(db(), actor, input, await requestContext());
    if (!r.ok) return { ok: false, fieldErrors: { current: 'Your current password is not correct.' }, message: 'Nothing was changed.' };
    return { ok: true, message: 'Password changed. Your other sessions have been signed out.' };
  });
}
