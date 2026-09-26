import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, Field } from '@/components/forms';
import { forgotPasswordAction } from '../actions';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1>Reset password</h1>
      <p className="lead">Enter your staff email. If it belongs to an active account, we will send a one-time reset link.</p>
      <ActionForm action={forgotPasswordAction} submitLabel="Send reset link" pendingLabel="Sending…">
        <Field name="email" label="Email" type="email" autoComplete="username" required />
      </ActionForm>
      <p className="auth-links"><Link href="/login">Back to sign in</Link></p>
    </>
  );
}
