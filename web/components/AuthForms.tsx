'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { browserSupabase } from '@/lib/supabase/browser';
import { authMessage } from '@/lib/auth/messages';
import { useAuth } from './AuthProvider';

/* Only same-site paths are allowed as a post-login destination (no open redirects). */
export const safeNext = (n?: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

function Field({ id, label, type = 'text', auto, error, min }: { id: string; label: string; type?: string; auto: string; error?: string; min?: number }) {
  return (
    <div className="st-field">
      <label htmlFor={`st-a-${id}`}>{label}</label>
      <input id={`st-a-${id}`} name={id} type={type} autoComplete={auto} required minLength={min}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': `st-ae-${id}` } : {})} />
      <p className="st-field-error" id={`st-ae-${id}`} hidden={!error}>{error}</p>
    </div>
  );
}

const NOTICES: Record<string, string> = {
  session: 'Your session has ended. Please log in again.',
  link: 'That confirmation link is invalid or has expired. Log in, or sign up again to get a new link.',
  confirmed: 'Your email is confirmed. You can log in now.',
  loggedout: 'You have logged out.'
};

export function LoginForm({ next, reason }: { next?: string; reason?: string }) {
  const router = useRouter(), { refresh } = useAuth();
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false), [alert, setAlert] = useState(''), [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <form className="st-auth-form" ref={form} noValidate aria-busy={busy} onSubmit={async e => {
      e.preventDefault();
      const f = form.current!, email = (f.elements.namedItem('email') as HTMLInputElement), password = (f.elements.namedItem('password') as HTMLInputElement);
      email.value = email.value.trim();
      const bad: Record<string, string> = {};
      if (!email.checkValidity()) bad.email = 'Enter a valid email address.';
      if (!password.value) bad.password = 'Enter your password.';
      setErrors(bad); setAlert('');
      if (Object.keys(bad).length) { (f.elements.namedItem(Object.keys(bad)[0]) as HTMLInputElement).focus(); return; }
      setBusy(true);
      const { error } = await browserSupabase().auth.signInWithPassword({ email: email.value, password: password.value });
      if (error) { setBusy(false); setAlert(authMessage(error)); password.value = ''; password.focus(); return; }
      await refresh();
      router.replace(safeNext(next)); router.refresh();
    }}>
      {reason && NOTICES[reason] && !alert && <div className={reason === 'confirmed' || reason === 'loggedout' ? 'st-form-ok' : 'st-form-alert'} role="status">{NOTICES[reason]}</div>}
      <div className="st-form-alert" id="st-auth-alert" role="alert" hidden={!alert}>{alert}</div>
      <Field id="email" label="Email" type="email" auto="email" error={errors.email} />
      <Field id="password" label="Password" type="password" auto="current-password" error={errors.password} />
      <button className="button st-place" type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      <p className="st-auth-alt">New to KITSYUU? <Link href={`/signup${next ? `?next=${encodeURIComponent(safeNext(next))}` : ''}`}>Create an account</Link></p>
    </form>
  );
}

export function SignupForm({ next }: { next?: string }) {
  const router = useRouter(), { refresh } = useAuth();
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false), [alert, setAlert] = useState(''), [errors, setErrors] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState('');
  if (sentTo) {
    return (
      <div className="st-auth-form" role="status">
        <div className="st-form-ok">Almost there. We sent a confirmation link to <b>{sentTo}</b>. Open it to activate your account, then log in.</div>
        <p className="st-auth-alt">Wrong address? <button type="button" className="st-clear" onClick={() => setSentTo('')}>Start again</button></p>
      </div>
    );
  }
  return (
    <form className="st-auth-form" ref={form} noValidate aria-busy={busy} onSubmit={async e => {
      e.preventDefault();
      const f = form.current!, get = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
      const name = get('full_name'), email = get('email'), password = get('password');
      name.value = name.value.trim(); email.value = email.value.trim();
      const bad: Record<string, string> = {};
      if (!name.value) bad.full_name = 'Enter your name.';
      if (!email.checkValidity()) bad.email = 'Enter a valid email address.';
      if (password.value.length < 8) bad.password = 'Use at least 8 characters.';
      setErrors(bad); setAlert('');
      if (Object.keys(bad).length) { get(Object.keys(bad)[0]).focus(); return; }
      setBusy(true);
      /* The role is never sent: new profiles are created as 'customer' by the database trigger. */
      const { data, error } = await browserSupabase().auth.signUp({
        email: email.value, password: password.value,
        options: { data: { full_name: name.value }, emailRedirectTo: `${location.origin}/auth/confirm?next=${encodeURIComponent(safeNext(next))}` }
      });
      setBusy(false);
      if (error) { setAlert(authMessage(error)); return; }
      /* With email confirmation on, Supabase answers an existing address with a user that has no identities. */
      if (data.user && data.user.identities?.length === 0) { setAlert(authMessage({ code: 'user_already_exists' })); return; }
      if (data.session) { await refresh(); router.replace(safeNext(next)); router.refresh(); return; }
      setSentTo(email.value);
    }}>
      <div className="st-form-alert" id="st-auth-alert" role="alert" hidden={!alert}>{alert}</div>
      <Field id="full_name" label="Full name" auto="name" error={errors.full_name} />
      <Field id="email" label="Email" type="email" auto="email" error={errors.email} />
      <Field id="password" label="Password (8+ characters)" type="password" auto="new-password" min={8} error={errors.password} />
      <button className="button st-place" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      <p className="st-auth-alt">Already have an account? <Link href={`/login${next ? `?next=${encodeURIComponent(safeNext(next))}` : ''}`}>Log in</Link></p>
    </form>
  );
}

export function LogoutButton() {
  const router = useRouter(), { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <button className="button button-outline" type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      await browserSupabase().auth.signOut();
      await refresh();
      router.replace('/login?reason=loggedout'); router.refresh();
    }}>{busy ? 'Logging out…' : 'Log out'}</button>
  );
}
