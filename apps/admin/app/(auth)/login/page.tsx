import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { currentActor, safeNext } from '@/lib/server';
import { loginAction } from '../actions';

export const metadata: Metadata = { title: 'Sign in' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const NOTICES: Record<string, string> = {
  expired: 'Your session has ended. Sign in again.',
  signed_out: 'You have signed out.',
  reset: 'Your password has been changed. Sign in with the new password.',
};

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(one(sp.next));
  if (await currentActor()) redirect(next);
  const notice = NOTICES[one(sp.reason)];
  return (
    <>
      <h1>Sign in</h1>
      <p className="lead">Staff access to the KITSYUU admin.</p>
      {notice && <p className="msg ok" role="status" data-notice={one(sp.reason)}>{notice}</p>}
      <ActionForm action={loginAction} submitLabel="Sign in" pendingLabel="Signing in…">
        <Hidden name="next" value={next} />
        <Field name="email" label="Email" type="email" autoComplete="username" required />
        <Field name="password" label="Password" type="password" autoComplete="current-password" required />
      </ActionForm>
      <p className="auth-links"><Link href="/forgot-password">Forgot your password?</Link></p>
    </>
  );
}
