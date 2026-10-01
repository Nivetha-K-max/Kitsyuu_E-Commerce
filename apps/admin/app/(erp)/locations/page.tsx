import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { LOCATION_KINDS, listLocations } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
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
  return (
    <>
      <PageHead section="Catalogue" title="Locations" eyebrow="Where stock is kept. The online location's stock is what the store sells.">
        <Link className="btn ghost" href="/transfers">Transfers</Link>
        <Link className="btn ghost" href="/locations/report">Report</Link>
      </PageHead>
      {locations.length === 0 ? <Empty title="No locations yet" kind="locations">Add the first location below.</Empty> : (
        <div className="table-wrap"><table data-locations-table>
          <thead><tr><th>Location</th><th>Kind</th><th className="num">Units</th><th className="num">Sizes in stock</th><th>Status</th></tr></thead>
          <tbody>{locations.map(l => (
            <tr key={l.id} data-location={l.code}>
              <td><Link href={`/locations/${l.id}`} className="row-link mono-strong">{l.name}</Link>
                <div className="note"><span className="mono">{l.code}</span>{l.is_online ? ' · Online store stock' : ''}{l.address ? ` · ${l.address}` : ''}</div></td>
              <td>{LOCATION_KINDS[l.kind as keyof typeof LOCATION_KINDS] ?? l.kind}</td>
              <td className="num">{formatNumber(l.units)}</td>
              <td className="num">{formatNumber(l.sizes)}</td>
              <td><StatusBadge status={l.is_active ? 'active' : 'inactive'} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {can(actor, 'locations.manage') && (
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
    </>
  );
}
