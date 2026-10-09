import ModuleViews from '@/components/ModuleViews';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { LOCATION_KINDS, listLocations } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Select, TextArea } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveLocationAction } from './actions';

export const metadata: Metadata = { title: 'Locations' };

const KIND_OPTIONS = Object.entries(LOCATION_KINDS).map(([value, label]) => ({ value, label }));

/* Third pass: where stock is kept (warehouse, retail branches, …). Locations are rows staff add here; one of them is
   the online location, whose stock is what the store sells. */
export default async function LocationsPage() {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Locations" /><Forbidden permission="inventory.read" /></>;
  const locations = await listLocations(db(), actor);
  const manage = can(actor, 'locations.manage');
  return (
    <Workspace name="locations" title="Locations"
      summary={`${locations.length} location${locations.length === 1 ? '' : 's'} · ${formatNumber(locations.reduce((n, l) => n + l.units, 0))} units held`}
      actions={<>
        <Link className="btn ghost" href="/locations/report">Report</Link>
        {manage && <a className="btn" href="#nl-h" data-link="new-location">Add a location</a>}
      </>}>
      <ModuleViews module="inventory" label="Inventory" current="/locations" />
      {locations.length === 0 ? <StateBlock title="No locations yet" name="locations">{manage ? 'Add the first location below.' : 'Locations appear here once they are added.'}</StateBlock> : (
        <div className="table-wrap ord-table"><table data-locations-table>
          <thead><tr><th>Location</th><th>Kind</th><th className="num">Units</th><th className="num">Sizes in stock</th><th>Status</th>{manage && <th><span className="sr-only">Edit</span></th>}</tr></thead>
          <tbody>{locations.map(l => (
            <tr key={l.id} data-location={l.code}>
              <td className="ord-who"><Link href={`/locations/${l.id}`} className="row-link mono-strong">{l.name}</Link>
                <div className="note"><span className="mono">{l.code}</span>{l.is_online ? ' · Online store stock' : ''}{l.address ? ` · ${l.address}` : ''}</div></td>
              <td className="ord-extra" data-label="Kind">{LOCATION_KINDS[l.kind as keyof typeof LOCATION_KINDS] ?? l.kind}</td>
              {/* The units open Inventory → Stock for this location: the sizes it holds. */}
              <td className="num ord-amount" data-location-units>{l.units > 0 ? <Link href={`/inventory?location=${l.id}`} data-link="location-stock" aria-label={`Stock held at ${l.name}`}>{formatNumber(l.units)}</Link> : formatNumber(l.units)}</td>
              <td className="num ord-extra" data-label="Sizes in stock">{formatNumber(l.sizes)}</td>
              <td className="ord-stage"><StatusBadge status={l.is_active ? 'active' : 'inactive'} /></td>
              {manage && <td className="num ord-next"><Link className="btn ghost sm" href={`/locations/${l.id}#edit-location`} aria-label={`Edit ${l.name}`} data-edit-location>Edit</Link></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="nl-h" data-section="new-location">
          <h2 id="nl-h">Add a location</h2>
          <ActionForm action={saveLocationAction} submitLabel="Add location" id="new-location-form" label="Add a location">
            <Field name="name" label="Name" required hint="e.g. Retail Branch 1" />
            <Field name="code" label="Code" required hint="Short, e.g. RB-1 (capital letters, digits, hyphens)" />
            <Select name="kind" label="Kind" options={KIND_OPTIONS} defaultValue="retail" required />
            <TextArea name="address" label="Address (optional)" rows={2} />
            <Checkbox name="active" label="Active" defaultChecked />
          </ActionForm>
        </section>
      )}
      {!manage && <p className="note section-foot" data-readonly="locations">Adding or editing locations needs the locations.manage permission.</p>}
    </Workspace>
  );
}
