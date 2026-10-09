'use client';
/* Server error while loading a signed-in page. Details stay in the server log; the digest lets staff quote it.
   Shown inside the page shell (sidebar and top bar stay), in the shared state shape of the ERP frame. */
export default function ErpError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="gate state state-error" role="alert" data-gate="error" data-state="error">
      <p className="eyebrow">Something went wrong</p>
      <h2>This page could not be loaded.</h2>
      <p className="note">Nothing was changed. Try again in a moment; if it keeps happening, send an administrator the reference <span className="mono">{error.digest ?? 'n/a'}</span>.</p>
      <div className="actions"><button type="button" className="btn" onClick={reset}>Try again</button></div>
    </section>
  );
}
