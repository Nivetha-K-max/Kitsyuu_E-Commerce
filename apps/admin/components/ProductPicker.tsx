'use client';
/* Choosing several products at once (2026-10-01: the finished products a vendor supplies). A searchable list of
   checkboxes posted as <name>[]; "Select shown" / "Clear" act on the filtered rows. The server checks every id again. */
import { useMemo, useState } from 'react';

type Product = { id: string; sku: string; name: string; status: string };

export default function ProductPicker({ products, selected, name = 'productIds[]', idPrefix }: { products: Product[]; selected: string[]; name?: string; idPrefix: string }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState(() => new Set(selected));
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => products.filter(p => !needle || `${p.sku} ${p.name}`.toLowerCase().includes(needle)), [products, needle]);
  const visible = useMemo(() => new Set(shown.map(p => p.id)), [shown]);
  const toggle = (id: string, on: boolean) => setChosen(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  return (
    <div className="product-picker" data-product-picker>
      <div className="actions">
        <label className="sr-only" htmlFor={`${idPrefix}-q`}>Search products</label>
        <input id={`${idPrefix}-q`} className="input" type="search" placeholder="Search by SKU or name" value={q} onChange={e => setQ(e.currentTarget.value)} />
        <button type="button" className="btn ghost sm" onClick={() => setChosen(s => new Set([...s, ...shown.map(p => p.id)]))}>Select shown</button>
        <button type="button" className="btn ghost sm" onClick={() => setChosen(s => { const n = new Set(s); shown.forEach(p => n.delete(p.id)); return n; })}>Clear shown</button>
        <span className="note" data-picker-count>{chosen.size} selected</span>
      </div>
      <ul className="picker-list plain">{products.map(p => (
        <li key={p.id} hidden={!visible.has(p.id)}>
          <label className="inline-label"><input type="checkbox" checked={chosen.has(p.id)} onChange={e => toggle(p.id, e.currentTarget.checked)} data-pick={p.sku} />
            <span><b>{p.name}</b> <span className="note mono">{p.sku}</span>{p.status !== 'active' && <span className="note"> · {p.status}</span>}</span></label>
        </li>
      ))}</ul>
      {[...chosen].map(id => <input key={id} type="hidden" name={name} value={id} />)}
    </div>
  );
}
