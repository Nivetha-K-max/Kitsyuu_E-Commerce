/* Shown inside the account frame while a section loads: quiet placeholders in the shape of the cards to come. */
export default function AccountLoading() {
  return (
    <div className="st-acc-loading" role="status" aria-live="polite">
      <p className="sr-only">Loading your account…</p>
      <span className="st-acc-sk is-title" aria-hidden="true" />
      <div className="st-acc-grid" aria-hidden="true"><span className="st-acc-sk" /><span className="st-acc-sk" /><span className="st-acc-sk is-wide" /></div>
    </div>
  );
}
