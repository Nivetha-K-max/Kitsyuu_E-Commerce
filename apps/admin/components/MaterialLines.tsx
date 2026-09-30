'use client';
/* The item rows of a new purchase order (client change request): every active material, searchable, with a quantity and
   (for staff who see costs) a unit price. Rows left empty are not ordered. Posted as materialIds[] / qtys[] / costs[];
   the server checks everything again. */
import { useMemo, useState } from 'react';

type Material = { id: string; code: string; name: string; unit: string; stock: number };

export default function MaterialLines({ materials, showCosts }: { materials: Material[]; showCosts: boolean }) {
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const needle = q.trim().toLowerCase();
  const visible = useMemo(() => new Set(materials.filter(m => !needle || `${m.code} ${m.name}`.toLowerCase().includes(needle)).map(m => m.id)), [materials, needle]);
  const chosen = materials.filter(m => Number(qty[m.id]) > 0);
  const total = chosen.reduce((n, m) => n + Number(qty[m.id]) * (Number(cost[m.id]) || 0), 0);
  return (
    <div className="po-lines" data-po-lines>
      <div className="actions">
        <label className="sr-only" htmlFor="po-search">Search materials</label>
        <input id="po-search" className="input" type="search" placeholder="Search materials by code or name" value={q} onChange={e => setQ(e.currentTarget.value)} />
        <span className="note" data-po-chosen>{chosen.length} item{chosen.length === 1 ? '' : 's'} chosen{showCosts && chosen.length ? ` · ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Material</th><th className="num">In stock</th><th>Quantity</th>{showCosts && <th>Unit price (₹)</th>}{showCosts && <th className="num">Line total</th>}</tr></thead>
        <tbody>{materials.map(m => (
          <tr key={m.id} hidden={!visible.has(m.id) && !(Number(qty[m.id]) > 0)} data-po-material={m.code}>
            <td><b>{m.name}</b><div className="note mono">{m.code}</div><input type="hidden" name="materialIds[]" value={m.id} />{!showCosts && <input type="hidden" name="costs[]" value="" />}</td>
            <td className="num">{m.stock} {m.unit}</td>
            <td><input name="qtys[]" className="input qty" inputMode="decimal" aria-label={`Quantity of ${m.name} (${m.unit})`} placeholder={m.unit}
              value={qty[m.id] ?? ''} onChange={e => { const v = e.currentTarget.value; setQty(s => ({ ...s, [m.id]: v })); }} /></td>
            {showCosts ? <td><input name="costs[]" className="input qty" inputMode="decimal" aria-label={`Unit price of ${m.name}`}
              value={cost[m.id] ?? ''} onChange={e => { const v = e.currentTarget.value; setCost(s => ({ ...s, [m.id]: v })); }} /></td> : null}
            {showCosts && <td className="num">{Number(qty[m.id]) > 0 && Number(cost[m.id]) >= 0 ? `₹${(Number(qty[m.id]) * (Number(cost[m.id]) || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}</td>}
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}
