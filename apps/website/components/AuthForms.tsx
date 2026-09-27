'use client';
/* Customer sign-in, sign-up and password forms (M6). All checks happen in the server actions (app/auth-actions.ts); the
   forms only collect input and show the server's answer. */
import Link from 'next/link';
import { ActionForm, Field, Hidden } from './forms';
import { forgotPasswordAction, loginAction, logoutAction, resendVerificationAction, resetPasswordAction, signupAction } from '@/app/auth-actions';

const NOTICES: Record<string, { text: string; ok: boolean }> = {
  session: { text: 'Your session has ended. Please log in again.', ok: false },
  link: { text: 'That link is invalid, already used, or has expired. Log in to get a new confirmation link, or request a new reset link.', ok: false },
  reset: { text: 'Your password has been changed and you have been signed out everywhere. Log in with the new password.', ok: true },
  loggedout: { text: 'You have logged out.', ok: true },
};

const withNext = (path: string, next?: string) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

export function LoginForm({ next, reason }: { next?: string; reason?: string }) {
  const notice = reason ? NOTICES[reason] : undefined;
  return (
    <>
      {notice && <div className={notice.ok ? 'st-form-ok' : 'st-form-alert'} role="status" data-notice={reason}>{notice.text}</div>}
      <ActionForm action={loginAction} submitLabel="Log in" pendingLabel="Logging in…" label="Log in"
        footer={<>
          <p className="st-auth-alt"><Link href="/forgot-password">Forgot your password?</Link></p>
          <p className="st-auth-alt">New to KITSYUU? <Link href={withNext('/signup', next)}>Create an account</Link></p>
        </>}>
        {next && <Hidden name="next" value={next} />}
        <Field name="email" label="Email" type="email" autoComplete="email" required />
        <Field name="password" label="Password" type="password" autoComplete="current-password" required />
      </ActionForm>
    </>
  );
}

export function SignupForm({ next }: { next?: string }) {
  return (
    <ActionForm action={signupAction} submitLabel="Create account" pendingLabel="Creating account…" label="Create an account"
      footer={<p className="st-auth-alt">Already have an account? <Link href={withNext('/login', next)}>Log in</Link></p>}>
      <Field name="fullName" label="Full name" autoComplete="name" required />
      <Field name="email" label="Email" type="email" autoComplete="email" required />
      <Field name="password" label="Password" type="password" autoComplete="new-password" required hint="At least 12 characters. A few unrelated words make a strong, memorable password." />
      <Field name="confirm" label="Repeat password" type="password" autoComplete="new-password" required />
    </ActionForm>
  );
}

export function ForgotPasswordForm() {
  return (
    <ActionForm action={forgotPasswordAction} submitLabel="Send reset link" pendingLabel="Sending…" label="Reset your password" id="st-forgot-form"
      footer={<p className="st-auth-alt">Remembered it? <Link href="/login">Log in</Link></p>}>
      <Field name="email" label="Email" type="email" autoComplete="email" required />
    </ActionForm>
  );
}

export function ResendVerificationForm() {
  return (
    <ActionForm action={resendVerificationAction} submitLabel="Resend confirmation link" pendingLabel="Sending…" label="Resend the confirmation email"
      id="st-resend-form" buttonClass="button button-outline st-place">
      <Field name="email" label="Email" type="email" autoComplete="email" required />
    </ActionForm>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  return (
    <ActionForm action={resetPasswordAction} submitLabel="Set new password" pendingLabel="Saving…" label="Choose a new password"
      footer={<p className="st-auth-alt">Link not working? <Link href="/forgot-password">Request a new one</Link></p>}>
      <Hidden name="token" value={token} />
      <Field name="password" label="New password" type="password" autoComplete="new-password" required hint="At least 12 characters." />
      <Field name="confirm" label="Repeat new password" type="password" autoComplete="new-password" required />
    </ActionForm>
  );
}

/** A real form posting to the logout server action (works without JavaScript too). */
export function LogoutButton({ className = 'button button-outline' }: { className?: string }) {
  return <form action={logoutAction}><button className={className} type="submit" data-logout>Log out</button></form>;
}
