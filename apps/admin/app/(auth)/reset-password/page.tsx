import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { resetPasswordAction } from '../actions';

export const metadata: Metadata = { title: 'Choose a new password' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ResetPasswordPage({ searchParams }: { searchParams: SP }) {
  const t = (await searchParams).token;
  const token = (Array.isArray(t) ? t[0] : t) ?? '';
  return (
    <>
      <h1>Choose a new password</h1>
      <p className="lead">At least 12 characters. A long passphrase is best. Every signed-in session will be signed out.</p>
      <ActionForm action={resetPasswordAction} submitLabel="Set new password" pendingLabel="Saving…">
        <Hidden name="token" value={token} />
        <Field name="password" label="New password" type="password" autoComplete="new-password" required />
        <Field name="confirm" label="Repeat new password" type="password" autoComplete="new-password" required />
      </ActionForm>
      <p className="auth-links"><Link href="/forgot-password">Request a new link</Link></p>
    </>
  );
}
