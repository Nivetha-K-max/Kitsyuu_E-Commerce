import type { Metadata } from 'next';
import { ForgotPasswordForm, ResendVerificationForm } from '@/components/AuthForms';
import { Crumbs } from '@/components/ui';

export const metadata: Metadata = { title: 'Reset your password', robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <div className="st-wrap st-auth">
      <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Log in', href: '/login' }, { label: 'Reset password' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title">Reset your password</h1>
        <div className="st-plp-aside"><p className="st-result-count">Account</p><p>Enter the email you use for KITSYUU. We will send a link to choose a new password.</p></div>
      </header>
      <ForgotPasswordForm />
      <section className="st-form-group st-auth-secondary" aria-labelledby="st-resend-title">
        <h2 id="st-resend-title">Did not get the confirmation email?</h2>
        <p>New accounts are activated from a link we email. Ask for a new one here.</p>
        <ResendVerificationForm />
      </section>
    </div>
  );
}
