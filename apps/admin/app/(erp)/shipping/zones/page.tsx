import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { INDIAN_STATES } from '@kitsyuu/contracts';
import { listShippingZones } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { rupeesField } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { checkQuoteAction, deleteRateAction, saveRateAction, saveZoneAction } from '../actions';
import ShippingNav from '../ShippingNav';

export const metadata: Metadata = { title: 'Delivery zones and rates' };
type Zone = Awaited<ReturnType<typeof listShippingZones>>['zones'][number];
type Rate = Zone['rates'][number];

function ZoneFields({ z }: { z?: Zone }) {
  return (
    <>
      {z && <Hidden name="zoneId" value={z.id} />}
      <Field name="name" label="Zone name" defaultValue={z?.name} required />
      <details open={!z}><summary className="btn ghost sm">States ({z?.states.length ?? 0} chosen)</summary>
        <div className="check-grid">{INDIAN_STATES.map(s => (
          <label key={s} className="check"><input type="checkbox" name="states[]" value={s} defaultChecked={z?.states.includes(s)} /><span>{s}</span></label>
        ))}</div>
      </details>
      <Field name="pinPrefixes" label="PIN prefixes" defaultValue={z?.pin_prefixes.join(', ') ?? ''} hint="Optional, e.g. 560, 5601. The longest matching prefix wins over states." />
      <Checkbox name="active" label="Active" defaultChecked={z?.is_active ?? true} />
    </>
  );
}

function RateFields({ zoneId, r }: { zoneId: string; r?: Rate }) {
  return (
    <>
      <Hidden name="zoneId" value={zoneId} />{r && <Hidden name="rateId" value={r.id} />}
      <div className="cols">
        <Field name="name" label="Name" defaultValue={r?.name ?? ''} required hint="Shown at checkout, e.g. Standard." />
        <Field name="amount" label="Charge (₹)" defaultValue={rupeesField(r?.amount_paise ?? null)} required hint="0 for free delivery." />
        <Field name="freeFrom" label="Free from (₹)" defaultValue={rupeesField(r?.free_from_paise)} />
        <Field name="minOrder" label="Only for orders from (₹)" defaultValue={rupeesField(r?.min_order_paise)} />
        <Field name="maxOrder" label="Only for orders below (₹)" defaultValue={rupeesField(r?.max_order_paise)} />
        <Field name="estMin" label="Delivery days from" defaultValue={r?.est_days_min?.toString() ?? ''} />
        <Field name="estMax" label="Delivery days to" defaultValue={r?.est_days_max?.toString() ?? ''} />
        <Field name="codFee" label="COD fee (₹)" defaultValue={rupeesField(r?.cod_fee_paise)} hint="Recorded only: cash on delivery is not offered at checkout." />
      </div>
      <Checkbox name="codAllowed" label="Cash on delivery allowed in this zone" defaultChecked={r?.cod_allowed ?? false} />
      <Checkbox name="active" label="Active" defaultChecked={r?.is_active ?? true} />
    </>
  );
}

/* ERP module 2: delivery charges by zone. They are used at checkout only when Settings → Shipping → "Delivery charge" is
   "By delivery zone"; an address in no zone cannot check out (the customer is told). */
export default async function ZonesPage() {
  const actor = await requireActor();
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipping" /><Forbidden permission="shipping.read" /></>;
  const { method, zones } = await listShippingZones(db(), actor);
  const manage = can(actor, 'shipping.manage');
  const methodText = method === 'zones' ? 'Checkout uses these zone rates.' : method === 'flat' ? 'Checkout uses the flat rate from Settings; these rates are not used.' : 'Delivery charges are not set up (Settings → Shipping); these rates are not used.';
  return (
    <>
      <PageHead title="Shipping" eyebrow={methodText} />
      <ShippingNav current="/shipping/zones" />
      {zones.length === 0 ? <Empty title="No delivery zones yet" kind="zones">Add a zone (states and/or PIN prefixes), then its rates.</Empty> : zones.map(z => (
        <section key={z.id} className="card" aria-labelledby={`z-${z.id}`} data-zone={z.name}>
          <h2 id={`z-${z.id}`}>{z.name} {!z.is_active && <span className="badge inactive">inactive</span>}</h2>
          <p className="note">{z.states.join(', ') || 'No states'}{z.pin_prefixes.length ? ` · PIN ${z.pin_prefixes.join(', ')}` : ''}</p>
          {z.rates.length === 0 ? <p className="note">No rates: addresses in this zone cannot check out while zone rates are used.</p> : (
            <div className="table-wrap"><table data-rates-table>
              <thead><tr><th>Rate</th><th className="num">Charge</th><th>Free from</th><th>Order value</th><th>Delivery</th><th>COD</th>{manage && <th />}</tr></thead>
              <tbody>{z.rates.map(r => (
                <tr key={r.id} data-rate={r.name}>
                  <td>{r.name} {!r.is_active && <span className="badge inactive">inactive</span>}</td><td className="num money">{formatPaise(r.amount_paise)}</td>
                  <td>{r.free_from_paise ? formatPaise(r.free_from_paise) : '—'}</td>
                  <td className="note">{r.min_order_paise ? `from ${formatPaise(r.min_order_paise)}` : 'any'}{r.max_order_paise ? ` · below ${formatPaise(r.max_order_paise)}` : ''}</td>
                  <td>{r.est_days_min !== null || r.est_days_max !== null ? `${r.est_days_min ?? '?'}–${r.est_days_max ?? '?'} days` : '—'}</td>
                  <td>{r.cod_allowed ? `yes${r.cod_fee_paise ? ` (+${formatPaise(r.cod_fee_paise)})` : ''}` : 'no'}</td>
                  {manage && <td><div className="actions row-actions">
                    <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                      <ActionForm action={saveRateAction} submitLabel="Save" className="form compact row-edit-form" id={`rate-${r.id}`} label="Edit rate"><RateFields zoneId={z.id} r={r} /></ActionForm></details>
                    <ActionForm action={deleteRateAction} submitLabel="Delete" variant="danger" className="inline-form" id={`rate-del-${r.id}`} label="Delete rate" confirmText={`Delete the rate "${r.name}"?`}>
                      <Hidden name="rateId" value={r.id} /></ActionForm>
                  </div></td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {manage && <div className="actions">
            <details className="row-edit"><summary className="btn ghost sm">Add a rate</summary>
              <ActionForm action={saveRateAction} submitLabel="Add rate" className="form compact row-edit-form" id={`rate-new-${z.id}`} label="Add rate" resetOnSuccess><RateFields zoneId={z.id} /></ActionForm></details>
            <details className="row-edit"><summary className="btn ghost sm">Edit zone</summary>
              <ActionForm action={saveZoneAction} submitLabel="Save zone" className="form compact row-edit-form" id={`zone-${z.id}`} label="Edit zone"><ZoneFields z={z} /></ActionForm></details>
          </div>}
        </section>
      ))}
      <div className="grid-2">
        {manage && <section className="card form-panel" aria-labelledby="nz-h" data-section="new-zone">
          <h2 id="nz-h">New zone</h2>
          <ActionForm action={saveZoneAction} submitLabel="Add zone" id="create-zone-form" label="Add zone" resetOnSuccess><ZoneFields /></ActionForm>
        </section>}
        <section className="card" aria-labelledby="cq-h" data-section="check-quote">
          <h2 id="cq-h">Check a delivery charge</h2>
          <p className="note">What a customer would be charged with the active zone rates (the same calculation as checkout).</p>
          <ActionForm action={checkQuoteAction} submitLabel="Check" id="check-quote-form" label="Check a delivery charge">
            <Select name="state" label="State" options={[{ value: '', label: 'Choose…' }, ...INDIAN_STATES.map(s => ({ value: s, label: s }))]} />
            <Field name="pin" label="PIN code" required />
            <Field name="subtotal" label="Order value (₹)" required />
          </ActionForm>
        </section>
      </div>
    </>
  );
}
