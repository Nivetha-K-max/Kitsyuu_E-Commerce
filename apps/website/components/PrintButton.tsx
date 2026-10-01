'use client';
/* Opens the browser's print dialog (save as PDF there). */
export default function PrintButton({ label = 'Print' }: { label?: string }) {
  return <button className="button" type="button" onClick={() => window.print()} data-print>{label}</button>;
}
