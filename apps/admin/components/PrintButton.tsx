'use client';
/** Opens the browser's print dialog for the current page (documents such as packing slips). */
export default function PrintButton({ label = 'Print' }: { label?: string }) {
  return <button type="button" className="btn" onClick={() => window.print()} data-print>{label}</button>;
}
