'use client';
/* A header checkbox that ticks or clears every checkbox with the given name in the same form (bulk selection). */
export default function SelectAll({ name, label }: { name: string; label: string }) {
  return (
    <label className="check">
      <input type="checkbox" aria-label={label} data-select-all onChange={e => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>(`input[type=checkbox][name="${name}"]`).forEach(b => { b.checked = e.currentTarget.checked; });
      }} />
    </label>
  );
}
