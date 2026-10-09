import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listCouriers } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { saveCourierAction } from '../actions';
import ShippingNav from '../ShippingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Couriers' };
type Courier = Awaited<ReturnType<typeof listCouriers>>[number];

function CourierFields({ c }: { c?: Courier }) {
  return (
    <>
      {c ? <Hidden name="code" value={c.code} /> : <Field name="code" label="Code" required hint="Lower-case letters, digits or _, e.g. delhivery. Cannot change later." />}
      <Field name="name" label="Name" defaultValue={c?.name} required />
      <Select name="mode" label="How shipments are booked" defaultValue={c?.mode ?? 'manual'} options={[{ value: 'manual', label: 'Manually (staff type the tracking number)' },
        { value: 'api', label: 'Courier API (needs an integration and its keys in the environment)' }]} />
      <Field name="trackingUrlTemplate" label="Tracking link" defaultValue={c?.tracking_url_template ?? ''} hint="Optional: an https:// address containing {tracking}." />
      <TextArea name="notes" label="Notes (staff only)" defaultValue={c?.notes ?? ''} rows={2} />
      <Checkbox name="active" label="Active (can be chosen when shipping)" defaultChecked={c?.is_active ?? true} />
    </>
  );
}

/* ERP module 2: couriers. No courier API is connected: no credentials exist, and none are ever stored in the database.
   An "api" courier stays manual until an integration and its keys are added to the deployment. */
export default async function CouriersPage() {
  const actor = await requireActor();
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipping" /><Forbidden permission="shipping.read" /></>;
  const couriers = await listCouriers(db(), actor);
  const manage = can(actor, 'shipping.manage');
  return (
    <Workspace name="shipping-couriers" title="Shipping" summary="Couriers staff can choose when shipping an order. Labels and pickups are booked on the courier’s own site; no courier API is connected.">
      <ShippingNav current="/shipping/couriers" />
      <div className="table-wrap"><table data-couriers-table>
        <thead><tr><th>Courier</th><th>Booking</th><th>Tracking link</th><th className="num">Shipments</th><th>Status</th>{manage && <th />}</tr></thead>
        <tbody>{couriers.map(c => (
          <tr key={c.code} data-courier={c.code}>
            <td><b>{c.name}</b><div className="note mono">{c.code}</div>{c.notes && <div className="note">{c.notes}</div>}</td>
            <td>{c.mode === 'api' ? 'API (not connected)' : 'Manual'}</td><td className="note mono">{c.tracking_url_template ?? '—'}</td>
            <td className="num">{c.shipments}</td><td><span className={`badge ${c.is_active ? 'active' : 'inactive'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
            {manage && <td><details className="row-edit"><summary className="btn ghost sm">Edit</summary>
              <ActionForm action={saveCourierAction} submitLabel="Save" className="form compact row-edit-form" id={`courier-${c.code}`} label={`Edit ${c.name}`}><CourierFields c={c} /></ActionForm></details></td>}
          </tr>
        ))}</tbody>
      </table></div>
      {manage && <section className="card form-panel" aria-labelledby="nc-h" data-section="new-courier">
        <h2 id="nc-h">New courier</h2>
        <ActionForm action={saveCourierAction} submitLabel="Add courier" id="create-courier-form" label="Add courier" resetOnSuccess><CourierFields /></ActionForm>
      </section>}
    </Workspace>
  );
}
