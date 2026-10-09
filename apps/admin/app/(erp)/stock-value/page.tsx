/* Inventory → Stock value (2026-10-09: on the shared workspace frame; the valuation and its rule are unchanged).
   For staff with costs.read. No costing method is decided, so finished pieces are valued only where a unit cost has been
   entered for the size; materials at their last purchase price. Nothing is estimated beyond that.
   Two views of the same page: Finished pieces · Materials. */
import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { stockValue } from '@kitsyuu/core';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { setVariantCostAction } from './actions';

export const metadata: Metadata = { title: 'Stock value' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default async function StockValuePage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'costs.read')) return <><PageHead section="Catalogue" title="Stock value" /><Forbidden permission="costs.read" /></>;
  const view = (await searchParams).view === 'materials' ? 'materials' : 'pieces';
  const v = await stockValue(db(), actor);
  const edit = can(actor, 'costs.manage');
  return (
    <Workspace name="stock-value" title="Stock value" summary={`Finished pieces ${rupees(v.totals.garmentsPaise)} · materials ${rupees(v.totals.materialsPaise)}`}>
      <ModuleViews module="inventory" label="Inventory" current="/stock-value" />
      <div data-value-views>
        <ViewTabs label="Stock value: what is valued" current={view} items={[
          { id: 'pieces', label: 'Finished pieces', href: '/stock-value', count: v.garments.length },
          { id: 'materials', label: 'Materials', href: '/stock-value?view=materials', count: v.materials.length }]} />
      </div>
      <p className="note lead-note" data-value-rule>Pieces are valued at the unit cost entered for each size (no costing method has been chosen yet, so nothing is
        calculated). Materials are valued at their last purchase price. Sizes or materials without a cost are not included in the totals
        ({v.totals.garmentsWithoutCost} size(s), {v.totals.materialsWithoutCost} material(s) in stock without one).</p>
      {view === 'pieces' && (v.garments.length === 0 ? <StateBlock title="No finished pieces" name="value-garments">Sizes appear here once products exist.</StateBlock> : (
        <div className="table-wrap ord-table" data-section="garments"><table data-value-garments>
          <thead><tr><th>Piece</th><th className="num">In stock</th><th className="num">Unit cost</th><th className="num">Value</th>{edit && <th>Set cost</th>}</tr></thead>
          <tbody>{v.garments.map(g => (
            <tr key={g.id} data-variant={g.sku}>
              <td className="ord-who">{g.name}<div className="ord-no">{g.sku} · {g.size}</div></td>
              <td className="num ord-extra" data-label="In stock">{g.stock_qty}</td>
              <td className="num ord-extra" data-label="Unit cost">{g.unit_cost_paise === null ? <span className="note">not set</span> : rupees(g.unit_cost_paise)}</td>
              <td className="num ord-amount">{g.valuePaise === null ? '—' : rupees(g.valuePaise)}</td>
              {edit && <td className="ord-next"><ActionForm action={setVariantCostAction} submitLabel="Save" className="form inline" id={`cost-${g.id}`} label={`Unit cost of ${g.sku}`}>
                <Hidden name="variantId" value={g.id} />
                <Field name="unitCost" label="₹" defaultValue={g.unit_cost_paise === null ? '' : String(g.unit_cost_paise / 100)} hint="Empty clears it." />
              </ActionForm></td>}
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {view === 'materials' && (v.materials.length === 0 ? <StateBlock title="No materials" name="value-materials">Materials appear here once they are added under Purchasing.</StateBlock> : (
        <div className="table-wrap ord-table" data-section="materials-value"><table data-value-materials>
          <thead><tr><th>Material</th><th className="num">In stock</th><th className="num">Last purchase price</th><th className="num">Value</th></tr></thead>
          <tbody>{v.materials.map(m => (
            <tr key={m.id} data-material={m.code}>
              <td className="ord-who">{m.name}<div className="ord-no">{m.code}</div></td>
              <td className="num ord-extra" data-label="In stock">{fmt(m.stock)} {m.unit}</td>
              <td className="num ord-extra" data-label="Last purchase price">{m.last_cost_paise === null ? <span className="note">no priced purchase</span> : `${rupees(m.last_cost_paise)} / ${m.unit}`}</td>
              <td className="num ord-amount">{m.valuePaise === null ? '—' : rupees(m.valuePaise)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
    </Workspace>
  );
}
