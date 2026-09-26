/* Shown while a signed-in page loads its data from the server: a quiet skeleton of a page header and a table. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" data-loading className="skeleton-page">
      <span className="sr-only">Loading the latest data…</span>
      <div className="sk sk-title" aria-hidden="true" />
      <div className="sk sk-line" aria-hidden="true" />
      <div className="sk-card" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <div className="sk sk-row" key={i} />)}
      </div>
    </div>
  );
}
