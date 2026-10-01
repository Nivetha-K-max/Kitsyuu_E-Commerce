'use client';
/* The new-product form's fields (2026-10-01, client request):
   - the store URL slug follows the name as it is typed (same rule as the server: lower case, hyphens); once edited by
     hand it stays as typed. The server still checks it and adds -2, -3… to a slug made from the name if it is taken.
   - the subcategory list shows only the chosen category's subcategories.
   - the colour is chosen from the colours defined under Attributes → Colour, or typed ("Other…").
   - sizes with their opening stock: quick buttons for the usual size runs, or any size typed; created with the product. */
import { useEffect, useRef, useState } from 'react';

type Cat = { id: string; label: string; parentId: string | null };
const slugify = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
const RUNS: { label: string; sizes: string[] }[] = [
  { label: 'XS–XXL', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  { label: 'Waist 28–36', sizes: ['28', '30', '32', '34', '36'] },
  { label: 'Free size', sizes: ['FREE'] },
];

export default function NewProductFields({ categories, colours, canStock }: { categories: Cat[]; colours: string[]; canStock: boolean }) {
  const [name, setName] = useState('');
  const marker = useRef<HTMLDivElement>(null);
  // The Name field is the form's standard field (so its error shows under it); the slug follows what is typed there.
  useEffect(() => {
    const input = marker.current?.closest('form')?.querySelector<HTMLInputElement>('[name=name]');
    if (!input) return;
    const on = () => setName(input.value);
    on(); input.addEventListener('input', on); input.addEventListener('change', on);
    return () => { input.removeEventListener('input', on); input.removeEventListener('change', on); };
  }, []);
  const [slug, setSlug] = useState(''), [slugEdited, setSlugEdited] = useState(false);
  const top = categories.filter(c => !c.parentId);
  const [cat, setCat] = useState(top[0]?.id ?? '');
  const subs = categories.filter(c => c.parentId === cat);
  const [colour, setColour] = useState(''), [other, setOther] = useState('');
  const [rows, setRows] = useState<{ size: string; qty: string }[]>([{ size: '', qty: '' }]);
  const shownSlug = slugEdited ? slug : slugify(name);
  const setRow = (i: number, k: 'size' | 'qty', v: string) => setRows(r => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const addRun = (sizes: string[]) => setRows(r => {
    const have = new Set(r.map(x => x.size.trim().toUpperCase()).filter(Boolean));
    const kept = r.filter(x => x.size.trim() || x.qty.trim());
    return [...kept, ...sizes.filter(s => !have.has(s)).map(size => ({ size, qty: '' }))];
  });

  return (
    <>
      <div className="field" ref={marker}>
        <label htmlFor="np-slug">Store URL slug</label>
        {/* Sent only when typed by hand: a slug made from the name is made again on the server, which then adds -2, -3… when taken. */}
        <input id="np-slug" className="input" name={slugEdited ? 'slug' : undefined} autoComplete="off" value={shownSlug} data-slug-auto={slugEdited ? 'no' : 'yes'}
          onChange={e => { setSlugEdited(true); setSlug(e.currentTarget.value); }} />
        <p className="note">/product/{shownSlug || '…'} — filled from the name as you type; edit it if you like.
          {slugEdited && <> <button type="button" className="btn ghost sm" onClick={() => { setSlugEdited(false); setSlug(''); }}>Use the name again</button></>}
          {' '}If it is already taken, -2, -3… is added. It stays fixed after creation, so links keep working.</p>
      </div>
      <div className="field">
        <label htmlFor="np-cat">Category <span className="req" aria-hidden="true">*</span></label>
        <select id="np-cat" className="input" name="categoryId" required value={cat} onChange={e => setCat(e.currentTarget.value)}>
          {top.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="np-sub">Subcategory</label>
        <select id="np-sub" className="input" name="subcategoryId" key={cat} defaultValue="">
          <option value="">None</option>
          {subs.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <p className="note">{subs.length ? `The subcategories of ${top.find(c => c.id === cat)?.label ?? 'this category'}.` : 'This category has no subcategories.'}</p>
      </div>
      <div className="field">
        <label htmlFor="np-colour">Colour</label>
        <select id="np-colour" className="input" value={colour} onChange={e => setColour(e.currentTarget.value)} data-colour-select>
          <option value="">None</option>
          {colours.map(c => <option key={c} value={c}>{c}</option>)}
          <option value="__other">Other…</option>
        </select>
        {colour === '__other' && <input className="input" aria-label="Colour name" placeholder="e.g. Washed Indigo" value={other} onChange={e => setOther(e.currentTarget.value)} style={{ marginTop: 8 }} />}
        <input type="hidden" name="colourLabel" value={colour === '__other' ? other : colour} />
        <p className="note">{colours.length ? 'From Attributes → Colour.' : 'Add colours under Attributes → Colour to choose them here.'}</p>
      </div>

      <fieldset className="fieldset span-2" data-new-sizes>
        <legend>Sizes and opening stock</legend>
        <div className="actions">
          {RUNS.map(r => <button key={r.label} type="button" className="btn ghost sm" onClick={() => addRun(r.sizes)} data-size-run={r.label}>+ {r.label}</button>)}
          <button type="button" className="btn ghost sm" onClick={() => setRows(r => [...r, { size: '', qty: '' }])}>+ Another size</button>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Size</th><th>Opening stock</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i} data-size-row={r.size || i}>
              <td><input className="input qty" name="sizes[]" aria-label={`Size ${i + 1}`} placeholder="e.g. M" value={r.size} maxLength={8} onChange={e => setRow(i, 'size', e.currentTarget.value.toUpperCase())} /></td>
              <td><input className="input qty" name="qtys[]" inputMode="numeric" aria-label={`Opening stock for size ${r.size || i + 1}`} placeholder="0" value={r.qty}
                disabled={!canStock} onChange={e => setRow(i, 'qty', e.currentTarget.value)} /></td>
              <td><button type="button" className="btn ghost sm" aria-label={`Remove size ${r.size || i + 1}`} onClick={() => setRows(x => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ size: '', qty: '' }]))}>Remove</button></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="note">Each size's SKU is the product SKU + size (e.g. KTS-TOP-023-M). Stock goes through the stock ledger as “Opening stock”.
          {!canStock && ' Opening stock needs the inventory permission: sizes are created with 0, and stock can be added on the next screen.'}</p>
      </fieldset>
    </>
  );
}
