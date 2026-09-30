/* A from / to date filter for report pages (GET, so the range is in the URL). */
export default function RangeForm({ from, to, children, label = 'Period' }: { from: string; to: string; children?: React.ReactNode; label?: string }) {
  return (
    <form method="get" className="filter-bar actions" aria-label={label} data-range-form>
      <label className="sr-only" htmlFor="rg-from">From</label>
      <input id="rg-from" name="from" type="date" className="input" defaultValue={from} aria-label="From" />
      <label className="sr-only" htmlFor="rg-to">To</label>
      <input id="rg-to" name="to" type="date" className="input" defaultValue={to} aria-label="To" />
      <button className="btn ghost" type="submit">Show</button>
      {children}
    </form>
  );
}
