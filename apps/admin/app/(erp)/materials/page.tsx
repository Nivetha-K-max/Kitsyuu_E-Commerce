/* Purchasing → Materials (2026-10-08: on the shared workspace frame).
   What production uses (fabric, trims, labels, packaging…). Material stock is one quantity per material, kept by its own
   ledger (material_movements, written only by adjust_material_stock): it rises when a purchase order is received, falls
   when production records material used, and otherwise changes only through a recorded correction or write-off.
   Materials are not kept per location (that is how the platform models them), so no location is shown here.
   The list shows the figures; a material opens on its own page with its ledger, where stock is corrected. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listMaterials } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, TextArea } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveMaterialAction } from './actions';

export const metadata: Metadata = { title: 'Materials' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const SHOW = { all: 'All materials', low: 'At or below reorder level', incoming: 'On order', inactive: 'Inactive' } as const;
type Show = keyof typeof SHOW;

export default async function MaterialsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Materials" /><Forbidden permission="procurement.read" /></>;
  const sp = await searchParams;
  const all = await listMaterials(db(), actor);
  const manage = can(actor, 'procurement.manage');
  const q = (one(sp.q) ?? '').trim().slice(0, 80).toLowerCase();
  const show: Show = (one(sp.show) ?? '') in SHOW ? one(sp.show) as Show : 'all';
  const materials = all.filter(m => (!q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    && (show === 'all' || (show === 'low' && m.low && m.is_active) || (show === 'incoming' && m.incoming > 0) || (show === 'inactive' && !m.is_active)));
  const filtered = !!(q || show !== 'all');
  const low = all.filter(m => m.is_active && m.low).length;
  return (
    <Workspace name="materials" title="Materials" summary={`${formatNumber(all.filter(m => m.is_active).length)} active${low ? ` · ${formatNumber(low)} at or below reorder level` : ''}`}
      actions={manage ? (
        <Drawer trigger="New material" name="new-material" scope="ord" title="New material" description="A material starts with no stock. Stock arrives when a purchase order for it is received.">
          <ActionForm action={saveMaterialAction} submitLabel="Add material" id="create-material-form" label="Add material" resetOnSuccess>
            <Field name="code" label="Code" required hint="e.g. FAB-DENIM-12OZ. Cannot be changed later." />
            <Field name="name" label="Name" required />
            <Field name="unit" label="Unit" required hint="As you buy it: m, kg, pcs, cones…" />
            <Field name="reorderLevel" label="Reorder at (optional)" />
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="purchasing" label="Purchasing" current="/materials" />
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter materials" data-material-filters>
          <label className="sr-only" htmlFor="m-q">Search</label>
          <input id="m-q" name="q" className="input" placeholder="Search code or name" defaultValue={one(sp.q) ?? ''} />
          <label className="sr-only" htmlFor="m-show">Show</label>
          <select id="m-show" name="show" className="input" defaultValue={show === 'all' ? '' : show}>
            <option value="">{SHOW.all}</option><option value="low">{SHOW.low}</option><option value="incoming">{SHOW.incoming}</option><option value="inactive">{SHOW.inactive}</option>
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/materials" data-clear-filters>Clear</FilterLink>}
      </div>
      {materials.length === 0 ? (
        <StateBlock title={filtered ? 'No matching materials' : 'No materials yet'} name="materials" action={filtered ? <Link className="btn ghost sm" href="/materials">Show all materials</Link> : undefined}>
          {filtered ? 'No material matches these filters.' : manage ? 'Add the fabric, trims and other materials you buy and use in production.' : 'Materials appear here once they are added.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={`${q}|${show}`}><table data-materials-table>
          <thead><tr><th>Material</th><th className="num">In stock</th><th className="num">On order</th><th className="num">Reorder at</th><th>Status</th><th>Open</th></tr></thead>
          <tbody>{materials.map(m => (
            <tr key={m.id} data-material={m.code}>
              <td className="ord-who"><NavLink className="row-link" href={`/materials/${m.id}`}>{m.name}</NavLink><div className="ord-no">{m.code}</div></td>
              <td className="num ord-amount" data-material-stock>{fmt(m.stock)} {m.unit}</td>
              <td className="num ord-extra" data-label="On order">{m.incoming ? `${fmt(m.incoming)} ${m.unit}` : '—'}</td>
              <td className="num ord-extra" data-label="Reorder at">{m.reorderLevel === null ? '—' : `${fmt(m.reorderLevel)} ${m.unit}`}</td>
              <td className="ord-stage">{!m.is_active ? <span className="badge disabled">Inactive</span> : m.low ? <span className="badge low_stock" data-low>Low</span> : m.stock <= 0 ? <span className="badge as-written">None in stock</span> : <span className="badge active as-written">In stock</span>}</td>
              <td className="ord-next"><Link className="btn ghost sm" href={`/materials/${m.id}`} data-link="material-ledger" aria-label={`Ledger of ${m.code}`}>Ledger</Link></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="note section-foot" data-material-definitions>In stock is what the material ledger holds; On order is what is still to come on purchase orders sent to a vendor.
        Material stock changes when goods are received, when production records material used, or by a recorded correction on the material&apos;s page. Materials are not kept per location.</p>
    </Workspace>
  );
}
