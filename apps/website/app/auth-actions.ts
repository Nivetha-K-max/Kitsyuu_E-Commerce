'use server';
/* Signed-out customer flows (M6). Messages never reveal whether an email address has an account: signup, password reset
   and "resend confirmation" answer the same way for every address, and a failed login always reads the same. */
import { redirect } from 'next/navigation';
import { loginInput, resetPasswordInput, resetRequestInput, signupInput, type ActionState } from '@kitsyuu/contracts';
import { loginCustomer, logoutCustomer, requestCustomerPasswordReset, resendCustomerVerification, resetCustomerPassword, signupCustomer } from '@kitsyuu/auth';
import { handle } from '@/lib/actions';
import { safeNext } from '@/lib/auth/next';
import { supabasePasswordCheck } from '@/lib/legacy-auth';
import { clearSessionCookie, db, mailer, requestContext, resetUrl, sessionToken, setSessionCookie, verifyUrl } from '@/lib/server';

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  let next = '';
  const result = await handle(loginInput, form, async input => {
    const r = await loginCustomer(db(), mailer(), input, { ...(await requestContext()), verifyUrl }, supabasePasswordCheck);
    if (!r.ok) return { ok: false, message:
      r.error === 'throttled' ? `Too many attempts. For your security, try again in ${r.retryAfterMinutes} minutes, or reset your password.`
      : r.error === 'unverified' ? 'Please confirm your email address first. We have sent a new confirmation link to your inbox.'
      : 'The email or password is incorrect.' };
    await setSessionCookie(r.token, r.expiresAt);
    next = safeNext(String(form.get('next') ?? ''));
    return { ok: true };
  });
  if (result.ok && next) redirect(next);
  return result;
}

export async function signupAction(_: ActionState, form: FormData): Promise<ActionState> {
  return handle(signupInput, form, async input => {
    await signupCustomer(db(), mailer(), input, { ...(await requestContext()), verifyUrl });
    return { ok: true, message: `Almost there. Check ${input.email} for a confirmation link and open it to activate your account. If you already have an account with this email, log in or reset your password instead.` };
  });
}

export async function resendVerificationAction(_: ActionState, form: FormData): Promise<ActionState> {
  return handle(resetRequestInput, form, async input => {
    await resendCustomerVerification(db(), mailer(), input, { ...(await requestContext()), verifyUrl });
    return { ok: true, message: 'If that address has an account waiting for confirmation, a new link is on its way.' };
  });
}

export async function forgotPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  return handle(resetRequestInput, form, async input => {
    await requestCustomerPasswordReset(db(), mailer(), input, { ...(await requestContext()), resetUrl });
    return { ok: true, message: 'If an account uses that email, we have sent it a link to reset the password. The link works once.' };
  });
}

export async function resetPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  let done = false;
  const result = await handle(resetPasswordInput, form, async input => {
    const r = await resetCustomerPassword(db(), input, await requestContext());
    if (!r.ok) return { ok: false, message: 'This reset link is invalid, already used, or expired. Request a new one below.' };
    done = true;
    return { ok: true };
  });
  if (done) { await clearSessionCookie(); redirect('/login?reason=reset'); }
  return result;
}

export async function logoutAction(): Promise<void> {
  const token = await sessionToken();
  if (token) {
    try { await logoutCustomer(db(), token, await requestContext()); }
    catch (e) { console.error('[logout]', e); }                    // the cookie is cleared regardless
  }
  await clearSessionCookie();
  redirect('/login?reason=loggedout');
}
