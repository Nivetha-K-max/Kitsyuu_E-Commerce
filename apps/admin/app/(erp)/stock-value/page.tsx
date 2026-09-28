import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { stockValue } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { setVariantCostAction } from './actions';

export const metadata: Metadata = { title: 'Stock value' };
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

/* M15: stock value for staff with costs.read. No costing method is decided, so garments are valued only where a unit
   cost has been entered; materials at their last purchase price. Nothing is estimated beyond that. */
export default async function StockValuePage() {
  const actor = await requireActor();
  if (!can(actor, 'costs.read')) return <><PageHead section="Catalogue" title="Stock value" /><Forbidden permission="costs.read" /></>;
  const v = await stockValue(db(), actor);
  const edit = can(actor, 'costs.manage');
  return (
    <>
      <PageHead section="Catalogue" title="Stock value" eyebrow={`Finished pieces ${rupees(v.totals.garmentsPaise)} · materials ${rupees(v.totals.materialsPaise)}`} />
      <p className="note lead-note">Pieces are valued at the unit cost entered for each size (no costing method has been chosen yet, so nothing is
        calculated). Materials are valued at their last purchase price. Sizes or materials without a cost are not included in the totals
        ({v.totals.garmentsWithoutCost} size(s), {v.totals.materialsWithoutCost} material(s) in stock without one).</p>
      <section className="card" aria-labelledby="g-h" data-section="garments">
        <SectionTitle id="g-h">Finished pieces</SectionTitle>
        <div className="table-wrap"><table data-value-garments>
          <thead><tr><th>Piece</th><th className="num">In stock</th><th className="num">Unit cost</th><th className="num">Value</th>{edit && <th>Set cost</th>}</tr></thead>
          <tbody>{v.garments.map(g => (
            <tr key={g.id} data-variant={g.sku}>
              <td>{g.name}<div className="note mono">{g.sku} · {g.size}</div></td>
              <td className="num">{g.stock_qty}</td>
              <td className="num">{g.unit_cost_paise === null ? <span className="note">not set</span> : rupees(g.unit_cost_paise)}</td>
              <td className="num">{g.valuePaise === null ? '—' : rupees(g.valuePaise)}</td>
              {edit && <td><ActionForm action={setVariantCostAction} submitLabel="Save" className="form inline" id={`cost-${g.id}`} label={`Unit cost of ${g.sku}`}>
                <Hidden name="variantId" value={g.id} />
                <Field name="unitCost" label="₹" defaultValue={g.unit_cost_paise === null ? '' : String(g.unit_cost_paise / 100)} hint="Empty clears it." />
              </ActionForm></td>}
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      <section className="card" aria-labelledby="m-h" data-section="materials-value">
        <SectionTitle id="m-h">Materials</SectionTitle>
        <div className="table-wrap"><table data-value-materials>
          <thead><tr><th>Material</th><th className="num">In stock</th><th className="num">Last purchase price</th><th className="num">Value</th></tr></thead>
          <tbody>{v.materials.map(m => (
            <tr key={m.id} data-material={m.code}>
              <td>{m.name}<div className="note mono">{m.code}</div></td>
              <td className="num">{fmt(m.stock)} {m.unit}</td>
              <td className="num">{m.last_cost_paise === null ? <span className="note">no priced purchase</span> : `${rupees(m.last_cost_paise)} / ${m.unit}`}</td>
              <td className="num">{m.valuePaise === null ? '—' : rupees(m.valuePaise)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </>
  );
}
