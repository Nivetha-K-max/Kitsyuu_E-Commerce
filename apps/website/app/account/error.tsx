'use client';
/* Account pages could not load (e.g. the database is unreachable). Details stay in the server log; the reference lets
   support find them. No internal error text is shown. */
export default function AccountError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="st-empty" role="alert" data-error="account">
      <p className="eyebrow"><span></span>ACCOUNT UNAVAILABLE</p>
      <h1>Something went wrong.</h1>
      <p>We could not load your account just now. Nothing was changed. Please try again in a moment.{error.digest ? ` (Reference ${error.digest})` : ''}</p>
      <button className="button" type="button" onClick={reset}>Try again</button>
    </section>
  );
}
