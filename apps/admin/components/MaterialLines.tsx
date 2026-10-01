'use client';
/* The item rows of a new purchase order (client change request; 2026-10-01: finished products too). Every product size and
   every active material, searchable, with a quantity and (for staff who see costs) a unit price. Rows left empty are not
   ordered. Posted as items[] ("v:<size id>" / "m:<material id>") / qtys[] / costs[]; the server checks everything again. */
import { useMemo, useState } from 'react';

type Material = { id: string; code: string; name: string; unit: string; stock: number };
export type ProductSize = { id: string; sku: string; label: string; stock: number; supplied: boolean };

export default function MaterialLines({ materials, products = [], showCosts }: { materials: Material[]; products?: ProductSize[]; showCosts: boolean }) {
  const [q, setQ] = useState('');
  const [onlySupplied, setOnlySupplied] = useState(products.some(p => p.supplied));
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => [
    ...products.map(p => ({ key: `v:${p.id}`, kind: 'product' as const, code: p.sku, name: p.label, unit: 'pcs', stock: p.stock, supplied: p.supplied })),
    ...materials.map(m => ({ key: `m:${m.id}`, kind: 'material' as const, code: m.code, name: m.name, unit: m.unit, stock: m.stock, supplied: true })),
  ], [products, materials]);
  const visible = useMemo(() => new Set(rows.filter(r => (!needle || `${r.code} ${r.name}`.toLowerCase().includes(needle)) && (r.kind === 'material' || !onlySupplied || r.supplied))
    .map(r => r.key)), [rows, needle, onlySupplied]);
  const chosen = rows.filter(r => Number(qty[r.key]) > 0);
  const total = chosen.reduce((n, r) => n + Number(qty[r.key]) * (Number(cost[r.key]) || 0), 0);
  return (
    <div className="po-lines" data-po-lines>
      <div className="actions">
        <label className="sr-only" htmlFor="po-search">Search products and materials</label>
        <input id="po-search" className="input" type="search" placeholder="Search products (SKU or name) and materials" value={q} onChange={e => setQ(e.currentTarget.value)} />
        {products.some(p => p.supplied) && <label className="inline-label"><input type="checkbox" checked={onlySupplied} onChange={e => setOnlySupplied(e.currentTarget.checked)} data-po-only-supplied /> Only what this vendor supplies</label>}
        <span className="note" data-po-chosen>{chosen.length} item{chosen.length === 1 ? '' : 's'} chosen{showCosts && chosen.length ? ` · ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th className="num">In stock</th><th>Quantity</th>{showCosts && <th>Unit price (₹)</th>}{showCosts && <th className="num">Line total</th>}</tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.key} hidden={!visible.has(r.key) && !(Number(qty[r.key]) > 0)} {...(r.kind === 'material' ? { 'data-po-material': r.code } : { 'data-po-product': r.code })}>
            <td><b>{r.name}</b><div className="note mono">{r.kind === 'product' ? `Product · ${r.code}` : `Material · ${r.code}`}</div>
              <input type="hidden" name="items[]" value={r.key} />{!showCosts && <input type="hidden" name="costs[]" value="" />}</td>
            <td className="num">{r.stock} {r.unit}</td>
            <td><input name="qtys[]" className="input qty" inputMode={r.kind === 'product' ? 'numeric' : 'decimal'} aria-label={`Quantity of ${r.name} (${r.unit})`} placeholder={r.unit}
              value={qty[r.key] ?? ''} onChange={e => { const v = e.currentTarget.value; setQty(s => ({ ...s, [r.key]: v })); }} /></td>
            {showCosts ? <td><input name="costs[]" className="input qty" inputMode="decimal" aria-label={`Unit price of ${r.name}`}
              value={cost[r.key] ?? ''} onChange={e => { const v = e.currentTarget.value; setCost(s => ({ ...s, [r.key]: v })); }} /></td> : null}
            {showCosts && <td className="num">{Number(qty[r.key]) > 0 && Number(cost[r.key]) >= 0 ? `₹${(Number(qty[r.key]) * (Number(cost[r.key]) || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}</td>}
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
