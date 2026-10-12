/* Purchasing → Materials (2026-10-08: on the shared workspace frame).
   What production uses (fabric, trims, labels…) and, since 2026-10-12, packaging (courier bags, cartons, tissue, tags…)
   as a second list of the same view: ?kind=packaging. Both are rows of one table on one ledger. Stock is one quantity per
   item, kept by its own ledger (material_movements, written only by adjust_material_stock): it rises when a purchase
   order is received, falls when production records material used or staff record packaging used, and otherwise changes
   only through a recorded correction or write-off. Stock is not kept per location (that is how the platform models it);
   a packaging item only names the place it is usually kept.
   The list shows the figures; an item opens on its own page with its ledger, where stock is corrected and use recorded. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listMaterials, materialPlaces } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveMaterialAction } from './actions';

export const metadata: Metadata = { title: 'Materials' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const SHOW = { all: 'All', low: 'At or below reorder level', incoming: 'On order', inactive: 'Inactive' } as const;
type Show = keyof typeof SHOW;
const SORT = { name: 'Name', stock: 'Lowest stock first', order: 'Most to order first' } as const;
type Sort = keyof typeof SORT;
const PAGE_SIZE = 50;

export default async function MaterialsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Materials" /><Forbidden permission="procurement.read" /></>;
  const sp = await searchParams;
  const packaging = one(sp.kind) === 'packaging';
  const everything = await listMaterials(db(), actor);
  const all = everything.filter(m => (m.kind === 'packaging') === packaging);
  const manage = can(actor, 'procurement.manage'), costs = can(actor, 'costs.read');
  const places = packaging && manage ? await materialPlaces(db(), actor) : null;
  const q = (one(sp.q) ?? '').trim().slice(0, 80).toLowerCase();
  const show: Show = (one(sp.show) ?? '') in SHOW ? one(sp.show) as Show : 'all';
  const sort: Sort = (one(sp.sort) ?? '') in SORT ? one(sp.sort) as Sort : 'name';
  const matching = all.filter(m => (!q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (packaging && (m.vendor_name ?? '').toLowerCase().includes(q)))
    && (show === 'all' || (show === 'low' && m.low && m.is_active) || (show === 'incoming' && m.incoming > 0) || (show === 'inactive' && !m.is_active)));
  if (sort === 'stock') matching.sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
  if (sort === 'order') matching.sort((a, b) => b.toOrder - a.toOrder || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(one(sp.page) ?? '1', 10) || 1));
  const materials = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const filtered = !!(q || show !== 'all');
  const low = all.filter(m => m.is_active && m.low).length;
  const home = packaging ? '/materials?kind=packaging' : '/materials';
  const url = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const v = { kind: packaging ? 'packaging' : undefined, q: one(sp.q)?.trim() || undefined, show: show === 'all' ? undefined : show, sort: sort === 'name' ? undefined : sort, ...over };
    for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== '') p.set(k, String(x));
    return p.size ? `/materials?${p}` : '/materials';
  };
  const noun = packaging ? 'packaging item' : 'material';
  return (
    <Workspace name="materials" title="Materials" summary={`${formatNumber(all.filter(m => m.is_active).length)} active${packaging ? ' packaging items' : ''}${low ? ` · ${formatNumber(low)} at or below reorder level` : ''}`}
      actions={!manage ? undefined : packaging ? (
        <Drawer trigger="New packaging item" name="new-packaging" scope="ord" title="New packaging item" description="A packaging item starts with no stock. Stock arrives when a purchase order for it is received.">
          <ActionForm action={saveMaterialAction} submitLabel="Add packaging item" id="create-packaging-form" label="Add packaging item" resetOnSuccess>
            <Hidden name="kind" value="packaging" />
            <Field name="code" label="Code" required hint="e.g. PKG-BAG-M. Cannot be changed later." />
            <Field name="name" label="Name" required />
            <Field name="unit" label="Unit" required hint="As you buy it: pcs, rolls, sheets, m…" />
            <Field name="reorderLevel" label="Reorder at (optional)" hint="At or below this, the item is shown as low." />
            <Select name="vendorId" label="Usual supplier (optional)" options={[{ value: '', label: 'Not set' }, ...places!.vendors.map(v => ({ value: v.id, label: v.name }))]} />
            <Select name="locationId" label="Kept at (optional)" options={[{ value: '', label: 'Not set' }, ...places!.locations.map(l => ({ value: l.id, label: l.name }))]} />
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </Drawer>
      ) : (
        <Drawer trigger="New material" name="new-material" scope="ord" title="New material" description="A material starts with no stock. Stock arrives when a purchase order for it is received.">
          <ActionForm action={saveMaterialAction} submitLabel="Add material" id="create-material-form" label="Add material" resetOnSuccess>
            <Field name="code" label="Code" required hint="e.g. FAB-DENIM-12OZ. Cannot be changed later." />
            <Field name="name" label="Name" required />
            <Field name="unit" label="Unit" required hint="As you buy it: m, kg, pcs, cones…" />
            <Field name="reorderLevel" label="Reorder at (optional)" />
            <TextArea name="notes" label="Notes (optional)" rows={2} />
          </ActionForm>
        </Drawer>
      )}>
      <ModuleViews module="purchasing" label="Purchasing" current="/materials" />
      <div data-material-kinds>
        <ViewTabs label="Materials: what is listed" current={packaging ? 'packaging' : 'material'} items={[
          { id: 'material', label: 'Production materials', href: '/materials', count: everything.filter(m => m.kind !== 'packaging' && m.is_active).length },
          { id: 'packaging', label: 'Packaging', href: '/materials?kind=packaging', count: everything.filter(m => m.kind === 'packaging' && m.is_active).length }]} />
      </div>
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label={`Filter ${noun}s`} data-material-filters>
          {packaging && <input type="hidden" name="kind" value="packaging" />}
          <label className="sr-only" htmlFor="m-q">Search</label>
          <input id="m-q" name="q" className="input" placeholder={packaging ? 'Search code, name or supplier' : 'Search code or name'} defaultValue={one(sp.q) ?? ''} />
          <label className="sr-only" htmlFor="m-show">Show</label>
          <select id="m-show" name="show" className="input" defaultValue={show === 'all' ? '' : show}>
            <option value="">{packaging ? 'All packaging' : 'All materials'}</option><option value="low">{SHOW.low}</option><option value="incoming">{SHOW.incoming}</option><option value="inactive">{SHOW.inactive}</option>
          </select>
          {packaging && <>
            <label className="sr-only" htmlFor="m-sort">Sort</label>
            <select id="m-sort" name="sort" className="input" defaultValue={sort === 'name' ? '' : sort}>
              <option value="">{SORT.name}</option><option value="stock">{SORT.stock}</option><option value="order">{SORT.order}</option>
            </select>
          </>}
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href={home} data-clear-filters>Clear</FilterLink>}
      </div>
      {materials.length === 0 ? (
        <StateBlock title={filtered ? `No matching ${noun}s` : packaging ? 'No packaging items yet' : 'No materials yet'} name={packaging ? 'packaging' : 'materials'} action={filtered ? <Link className="btn ghost sm" href={home}>Show all {noun}s</Link> : undefined}>
          {filtered ? `No ${noun} matches these filters.` : packaging ? (manage ? 'Add the courier bags, cartons, tissue, tags and other packaging you buy and use when packing orders.' : 'Packaging items appear here once they are added.')
            : manage ? 'Add the fabric, trims and other materials you buy and use in production.' : 'Materials appear here once they are added.'}
        </StateBlock>
      ) : packaging ? (
        <div className="table-wrap ord-table" data-fresh key={`p|${q}|${show}|${sort}|${page}`}><table data-packaging-table>
          <thead><tr><th>Packaging item</th><th className="num">In stock</th><th className="num">On order</th><th className="num">Reorder at</th><th className="num">To order</th><th>Supplier</th><th>Kept at</th>{costs && <th className="num">Last cost</th>}<th>Status</th><th>Open</th></tr></thead>
          <tbody>{materials.map(m => (
            <tr key={m.id} data-packaging={m.code}>
              <td className="ord-who"><NavLink className="row-link" href={`/materials/${m.id}`}>{m.name}</NavLink><div className="ord-no">{m.code}</div></td>
              <td className="num ord-amount" data-material-stock>{fmt(m.stock)} {m.unit}</td>
              <td className="num ord-extra" data-label="On order">{m.incoming ? `${fmt(m.incoming)} ${m.unit}` : '—'}</td>
              <td className="num ord-extra" data-label="Reorder at">{m.reorderLevel === null ? '—' : `${fmt(m.reorderLevel)} ${m.unit}`}</td>
              <td className="num ord-extra" data-label="To order" data-to-order>{m.toOrder ? `${fmt(m.toOrder)} ${m.unit}` : '—'}</td>
              <td className="ord-extra" data-label="Supplier">{m.vendor_name ?? '—'}</td>
              <td className="ord-extra" data-label="Kept at">{m.location_name ?? '—'}</td>
              {costs && <td className="num ord-extra" data-label="Last cost" data-last-cost>{m.last_cost_paise === null ? '—' : formatPaise(m.last_cost_paise)}</td>}
              <td className="ord-stage">{!m.is_active ? <span className="badge disabled">Inactive</span> : m.low ? <span className="badge low_stock" data-low>Low</span> : m.stock <= 0 ? <span className="badge as-written">None in stock</span> : <span className="badge active as-written">In stock</span>}</td>
              <td className="ord-next"><Link className="btn ghost sm" href={`/materials/${m.id}`} data-link="material-ledger" aria-label={`Ledger of ${m.code}`}>Ledger</Link></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={`${q}|${show}|${page}`}><table data-materials-table>
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
      {pages > 1 && (
        <nav className="pager" aria-label="Pages" data-pager>
          {page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={url({ page: page === 2 ? undefined : page - 1 })}>← Previous</FilterLink> : <span />}
          <span className="pager-page">Page {formatNumber(page)} of {formatNumber(pages)}</span>
          {page < pages ? <FilterLink className="btn ghost sm" group="page" current={false} href={url({ page: page + 1 })}>Next →</FilterLink> : <span />}
        </nav>
      )}
      {packaging ? (
        <p className="note section-foot" data-material-definitions>In stock is what the ledger holds; On order is what is still to come on purchase orders sent to a vendor; To order is what is missing to be back at the reorder level, counting what is on order.
          Packaging stock changes when goods are received, when use is recorded on the item&apos;s page, or by a recorded correction there. Packing an order does not take packaging from stock by itself.</p>
      ) : (
        <p className="note section-foot" data-material-definitions>In stock is what the material ledger holds; On order is what is still to come on purchase orders sent to a vendor.
          Material stock changes when goods are received, when production records material used, or by a recorded correction on the material&apos;s page. Materials are not kept per location.</p>
      )}
    </Workspace>
  );
}
