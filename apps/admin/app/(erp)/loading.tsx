/* Shown while a signed-in page loads its data from the server. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" data-loading>
      <p className="eyebrow">Loading</p>
      <p className="note">Fetching the latest data…</p>
    </div>
  );
}
