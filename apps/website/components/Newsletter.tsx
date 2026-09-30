'use client';
/* Client change request: the newsletter sign-up is real. The address and the consent below are stored (one entry per
   address; signing up again is harmless). The server checks everything again. */
import { startTransition, useActionState, useRef } from 'react';
import { subscribeNewsletterAction } from '@/app/newsletter-actions';

const CONSENT = 'I agree to receive emails from KITSYUU about new products and offers. I can unsubscribe at any time.';

export default function Newsletter({ source = 'home' }: { source?: string }) {
  const [state, dispatch, pending] = useActionState(subscribeNewsletterAction, {});
  const form = useRef<HTMLFormElement>(null);
  const emailError = state.fieldErrors?.email, consentError = state.fieldErrors?.consent;
  return (
    <form ref={form} className="st-news-form" noValidate aria-busy={pending || undefined} data-newsletter-form onSubmit={e => {
      e.preventDefault();
      if (pending) return;
      const data = new FormData(e.currentTarget);
      startTransition(() => dispatch(data));
    }}>
      <input type="hidden" name="source" value={source} />
      <label htmlFor="st-news-email">Email address</label>
      <div className="st-news-row">
        <input id="st-news-email" type="email" name="email" autoComplete="email" placeholder="you@example.com" required maxLength={254}
          aria-describedby="st-news-msg" aria-invalid={emailError ? true : undefined} disabled={state.ok} />
        <button className="button" type="submit" disabled={pending || state.ok}>{pending ? 'Signing up…' : 'Sign up'}</button>
      </div>
      <label className="st-check st-news-consent">
        <input type="checkbox" name="consent" value="on" required aria-invalid={consentError ? true : undefined} disabled={state.ok} />
        <span>{CONSENT}</span>
      </label>
      <p className={`st-news-msg${state.ok ? ' is-ok' : state.message ? ' is-error' : ''}`} id="st-news-msg" role={state.ok ? 'status' : 'alert'} aria-live="polite" data-newsletter-msg>
        {state.message ?? ''}
      </p>
    </form>
  );
}
