/* Purchasing → Vendors (2026-10-08: on the shared workspace frame).
   The suppliers KITSYUU buys from: finished products (hoodies, jeans), and fabric, trims and other materials. A vendor is
   one record and is never deleted (purchase orders refer to it); it is made inactive instead. The list shows who they are
   and what is open with them; a vendor opens on its own page (details, purchase orders, products supplied, activity). */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listVendors } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveVendorAction } from './actions';
import { VendorFields } from './fields';

export const metadata: Metadata = { title: 'Vendors' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function VendorsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Vendors" /><Forbidden permission="procurement.read" /></>;
  const sp = await searchParams;
  const all = await listVendors(db(), actor);
  const manage = can(actor, 'procurement.manage');
  const q = (one(sp.q) ?? '').trim().slice(0, 80).toLowerCase();
  const status = one(sp.status) === 'active' || one(sp.status) === 'inactive' ? one(sp.status) as 'active' | 'inactive' : '';
  const vendors = all.filter(v => (!status || v.is_active === (status === 'active'))
    && (!q || [v.name, v.contact, v.email, v.phone, v.gstin].some(x => x?.toLowerCase().includes(q))));
  const filtered = !!(q || status);
  const activeCount = all.filter(v => v.is_active).length;
  return (
    <Workspace name="vendors" title="Vendors" summary={`${formatNumber(activeCount)} active · ${formatNumber(all.length)} in total`}
      actions={manage ? (
        <Drawer trigger="New vendor" name="new-vendor" scope="ord" title="New vendor" description="Only the name is required. The products a vendor supplies are chosen on the vendor's page.">
          <ActionForm action={saveVendorAction} submitLabel="Add vendor" id="create-vendor-form" label="Add vendor" resetOnSuccess><VendorFields /></ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="purchasing" label="Purchasing" current="/vendors" />
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter vendors" data-vendor-filters>
          <label className="sr-only" htmlFor="v-q">Search</label>
          <input id="v-q" name="q" className="input" placeholder="Search name, contact, phone or GSTIN" defaultValue={one(sp.q) ?? ''} />
          <label className="sr-only" htmlFor="v-status">Status</label>
          <select id="v-status" name="status" className="input" defaultValue={status}>
            <option value="">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/vendors" data-clear-filters>Clear</FilterLink>}
      </div>
      {vendors.length === 0 ? (
        <StateBlock title={filtered ? 'No matching vendors' : 'No vendors yet'} name="vendors" action={filtered ? <Link className="btn ghost sm" href="/vendors">Show all vendors</Link> : undefined}>
          {filtered ? 'No vendor matches these filters.' : manage ? 'Add the suppliers you buy finished products, fabric, trims and other materials from.' : 'Vendors appear here once they are added.'}
        </StateBlock>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={`${q}|${status}`}><table data-vendors-table>
          <thead><tr><th>Vendor</th><th>Contact</th><th className="num">Products supplied</th><th className="num">Open orders</th><th>Status</th></tr></thead>
          <tbody>{vendors.map(v => (
            <tr key={v.id} data-vendor={v.name}>
              <td className="ord-who"><NavLink className="row-link" href={`/vendors/${v.id}`}>{v.name}</NavLink>
                {v.gstin && <div className="ord-no">GSTIN {v.gstin}</div>}{v.address && <div className="note">{v.address}</div>}</td>
              <td className="ord-extra" data-label="Contact">{v.contact ?? '—'}{v.email && <div className="note">{v.email}</div>}{v.phone && <div className="note">{v.phone}</div>}</td>
              <td className="num ord-extra" data-label="Products supplied" data-vendor-products>{v.products ? <Link href={`/vendors/${v.id}?tab=products`}>{v.products}</Link> : <span className="note">None chosen</span>}</td>
              <td className="num ord-extra" data-label="Open orders" data-vendor-open>{v.open_orders ? <Link href={`/vendors/${v.id}?tab=orders`}>{v.open_orders}</Link> : '—'}</td>
              <td className="ord-stage"><span className={`badge ${v.is_active ? 'active' : 'disabled'}`}>{v.is_active ? 'Active' : 'Inactive'}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {!manage && <p className="note section-foot" data-readonly="vendors">Adding or changing a vendor needs the procurement.manage permission.</p>}
    </Workspace>
  );
}
