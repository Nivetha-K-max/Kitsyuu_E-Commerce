'use server';
/* Signed-out flows. Messages never reveal whether an email address has a staff account. */
import { redirect } from 'next/navigation';
import { acceptInviteInput, loginInput, resetPasswordInput, resetRequestInput, type ActionState } from '@kitsyuu/contracts';
import { acceptStaffInvite, loginStaff, logoutStaff, requestStaffPasswordReset, resetStaffPassword } from '@kitsyuu/auth';
import { handle } from '@/lib/actions';
import { clearSessionCookie, db, mailer, requestContext, resetUrl, safeNext, sessionToken, setSessionCookie } from '@/lib/server';

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  let next = '';
  const result = await handle(loginInput, form, async input => {
    const r = await loginStaff(db(), input, await requestContext());
    if (!r.ok) return { ok: false, message: r.error === 'throttled'
      ? `Too many failed sign-in attempts. Try again in ${r.retryAfterMinutes} minutes.`
      : 'Email or password is incorrect.' };
    await setSessionCookie(r.token, r.expiresAt);
    next = safeNext(form.get('next'));
    return { ok: true };
  });
  if (result.ok && next) redirect(next);
  return result;
}

export async function logoutAction(): Promise<void> {
  const token = await sessionToken();
  if (token) await logoutStaff(db(), token, await requestContext());
  await clearSessionCookie();
  redirect('/login?reason=signed_out');
}

export async function forgotPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  return handle(resetRequestInput, form, async input => {
    await requestStaffPasswordReset(db(), mailer(), input, { ...(await requestContext()), resetUrl });
    return { ok: true, message: 'If an active staff account uses that email, a reset link has been sent to it.' };
  });
}

export async function resetPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  let done = false;
  const result = await handle(resetPasswordInput, form, async input => {
    const r = await resetStaffPassword(db(), input, await requestContext());
    if (!r.ok) return { ok: false, message: 'This reset link is invalid, already used, or expired. Request a new one.' };
    done = true;
    return { ok: true };
  });
  if (done) redirect('/login?reason=reset');
  return result;
}

export async function acceptInviteAction(_: ActionState, form: FormData): Promise<ActionState> {
  let done = false;
  const result = await handle(acceptInviteInput, form, async input => {
    const r = await acceptStaffInvite(db(), input, await requestContext());
    if (!r.ok) return { ok: false, message: 'This invitation link is invalid, already used, or expired. Ask for a new invitation.' };
    await setSessionCookie(r.token, r.expiresAt);
    done = true;
    return { ok: true };
  });
  if (done) redirect('/dashboard');
  return result;
}
