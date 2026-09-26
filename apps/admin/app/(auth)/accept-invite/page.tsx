import type { Metadata } from 'next';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { acceptInviteAction } from '../actions';

export const metadata: Metadata = { title: 'Accept invitation' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AcceptInvitePage({ searchParams }: { searchParams: SP }) {
  const t = (await searchParams).token;
  const token = (Array.isArray(t) ? t[0] : t) ?? '';
  return (
    <>
      <h1>Set up your account</h1>
      <p className="lead">You have been invited to the KITSYUU admin. Choose a password of at least 12 characters; the link works once.</p>
      <ActionForm action={acceptInviteAction} submitLabel="Create my account" pendingLabel="Creating…">
        <Hidden name="token" value={token} />
        <Field name="fullName" label="Your name" autoComplete="name" required />
        <Field name="password" label="Password" type="password" autoComplete="new-password" required />
        <Field name="confirm" label="Repeat password" type="password" autoComplete="new-password" required />
      </ActionForm>
    </>
  );
}
