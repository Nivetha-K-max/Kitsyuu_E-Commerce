/* Shown while a signed-in page loads its data from the server: a quiet skeleton of the page header, the toolbar and a
   table, laid out like the real page so nothing jumps when it arrives. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" data-loading className="skeleton-page">
      <span className="sr-only">Loading the latest data…</span>
      <div className="sk sk-title" aria-hidden="true" />
      <div className="sk sk-line" aria-hidden="true" />
      <div className="sk-toolbar" aria-hidden="true"><div className="sk" /><div className="sk" /><div className="sk" /></div>
      <div className="sk-card" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div className="sk-trow" key={i}><div className="sk sk-thumb" /><div className="sk sk-text" /><div className="sk sk-short" /><div className="sk sk-short" /></div>
        ))}
      </div>
    </div>
  );
}
