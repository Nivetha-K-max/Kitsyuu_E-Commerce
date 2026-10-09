import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { LOCATION_KINDS, getLocationStock, listAdjustmentReasons } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';
import { Empty, Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { adjustLocationStockAction, saveLocationAction } from '../actions';

export const metadata: Metadata = { title: 'Location' };
type Params = Promise<{ id: string }>;
type Search = Promise<{ q?: string; all?: string; tab?: string }>;

const KIND_OPTIONS = Object.entries(LOCATION_KINDS).map(([value, label]) => ({ value, label }));

export default async function LocationPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/locations', label: 'Locations' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Location" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const { id } = await params, sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const q = (sp.q ?? '').trim().slice(0, 80), all = sp.all === '1';
  const { location: l, rows, movements, units } = await getLocationStock(db(), actor, { locationId: id, q: q || undefined, inStockOnly: !all && !q })
    .catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const adjust = can(actor, 'inventory.adjust') && l.is_active;
  const reasons = adjust ? await listAdjustmentReasons(db(), actor, { retail: l.kind === 'retail' && !l.is_online }) : [];
  // The form offers every size (with what is here now), not only the sizes already in stock here: a new branch receives its
  // first stock from this page too.
  const formRows = !adjust ? [] : (!all && !q) ? (await getLocationStock(db(), actor, { locationId: id, inStockOnly: false })).rows : rows;
  /* 2026-10-09: on the shared entity frame. Tabs: Stock (what is here, changing it, its recent movements and the location's own
     details: the working view, all on one surface so the approved "Edit location" link still lands on its form) · Activity. */
  const seeAudit = can(actor, 'audit.read');
  const tab = sp.tab === 'activity' && seeAudit ? 'activity' : 'stock';
  const self = `/locations/${l.id}`;
  return (
    <Entity module={{ href: '/locations', label: 'Locations' }} name="location" title={l.name} status={<StatusBadge status={l.is_active ? 'active' : 'inactive'} />}
      factsAttr="data-location-facts"
      facts={[
        { label: 'Code', value: <span className="mono">{l.code}</span> },
        { label: 'Kind', value: `${LOCATION_KINDS[l.kind as keyof typeof LOCATION_KINDS] ?? l.kind}${l.is_online ? ' · Online store stock' : ''}` },
        { label: 'Units shown', value: formatNumber(units), attr: 'units' },
      ]}
      tabs={[{ id: 'stock', label: 'Stock' }, ...(seeAudit ? [{ id: 'activity', label: 'Activity' }] : [])]} current={tab} tabHref={t => (t === 'stock' ? self : `${self}?tab=${t}`)}
      actions={<div className="ord-head-actions">
        {/* Phase 8: from a location to its stock in Inventory and to its rows of the stock ledger. */}
        <Link className="btn ghost" href={`/inventory?location=${l.id}`} data-link="location-stock">In Stock</Link>
        <Link className="btn ghost" href={`/inventory/movements?location=${l.id}`} data-link="location-movements">All movements</Link>
        {can(actor, 'locations.manage') && tab === 'stock' && <a className="btn ghost" href="#edit-location" data-edit-location>Edit location</a>}
      </div>}>
      {tab === 'activity' && (
        <Section id="lact-h" title="Activity" name="activity" wide hint="Changes to this location's details, from the audit log. Its stock changes are rows of the stock ledger (All movements).">
          <RecordActivity entityType="locations" entityId={l.id} name="location" empty="Changes to this location are listed here as they are made." />
        </Section>
      )}
      {tab === 'stock' && <>
      {l.is_online && <p className="note">This is the online location: its stock is what the store sells, and orders take stock from here.</p>}

      <section className="card" aria-labelledby="ls-h" data-section="location-stock">
        <SectionTitle id="ls-h">Stock here</SectionTitle>
        <form className="toolbar" method="get" role="search" aria-label="Find a piece">
          <input className="input" name="q" defaultValue={q} placeholder="Product name or SKU" aria-label="Product name or SKU" />
          <label className="check"><input type="checkbox" name="all" value="1" defaultChecked={all} /><span>Include sizes with no stock here</span></label>
          <button className="btn ghost" type="submit">Show</button>
        </form>
        {rows.length === 0 ? <Empty compact title={q ? 'Nothing matches' : 'No stock at this location'}>{q ? 'Try another name or SKU.' : 'Stock arrives here through transfers or adjustments.'}</Empty> : (
          <div className="table-wrap"><table data-location-stock>
            <thead><tr><th>Piece</th><th>SKU</th><th className="num">Quantity</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.variant_id} data-sku={r.sku}>
                <td><Link href={`/products/${r.product_id}?tab=variants`}>{r.label}</Link></td>
                <td className="mono">{r.sku}</td>
                <td className="num">{r.qty}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {adjust && formRows.length > 0 && (
        <section className="card form-panel" aria-labelledby="la-h" data-section="location-adjust">
          <h2 id="la-h">Change stock here</h2>
          <p className="note">For deliveries, damage, corrections{reasons.some(r => r.code === 'retail_sale') ? ' and in-store sales (Retail sale)' : ''}. Transfers between locations are made under <Link href="/transfers">Transfers</Link>.</p>
          <ActionForm action={adjustLocationStockAction} submitLabel="Update stock" id="location-adjust-form" label="Change stock at this location" resetOnSuccess
            confirmText={`Record this stock change at ${l.name}? It is written to the stock ledger and cannot be edited afterwards (a mistake is corrected with another change).`}>
            <Hidden name="locationId" value={l.id} />
            <Select name="variant" label="Size" required options={[{ value: '', label: 'Choose a size…' }, ...formRows.map(r => ({ value: `${r.variant_id}:${r.qty}`, label: `${r.label} (${r.sku}) · ${r.qty} here` }))]} />
            <Field name="delta" label="Change" required hint="e.g. 5 to add, -2 to take away" />
            <Select name="reason" label="Reason" required options={[{ value: '', label: 'Choose a reason…' }, ...reasons.map(r => ({ value: r.code, label: r.label }))]} />
            <Field name="note" label="Note (optional)" hint='e.g. "Received 20 units from supplier."' />
            <Field name="unitCost" label="Unit cost, ₹ (optional, stock coming in)" hint="What one unit cost, kept with this delivery in the stock history." />
          </ActionForm>
        </section>
      )}

      <section className="card" aria-labelledby="lm-h" data-section="location-movements">
        <SectionTitle id="lm-h">Recent movements here</SectionTitle>
        <p className="note">The latest {movements.length} rows of the stock ledger for this location. <Link href={`/inventory/movements?location=${l.id}`}>Search and filter all of them</Link>.</p>
        {movements.length === 0 ? <Empty compact title="No movements yet" /> : (
          <div className="table-wrap"><table data-location-movements>
            <thead><tr><th>When</th><th>Item</th><th>Reason</th><th className="num">Before</th><th className="num">Change</th><th className="num">After</th><th className="num">Unit cost</th><th>By</th></tr></thead>
            <tbody>{movements.map(m => (
              <tr key={String(m.id)}>
                <td>{formatDateTime(m.created_at as Date)}</td>
                <td>{m.product_name}<div className="note mono">{m.sku}</div></td>
                <td>{m.reason_label ?? m.reason}{m.transfer_id ? <> · <Link href={`/transfers/${m.transfer_id}`}>{m.transfer_number}</Link></> : null}{m.order_id && can(actor, 'orders.read') ? <> · <Link href={`/orders/${m.order_id}?tab=items`}>order</Link></> : null}{m.note ? <div className="note">{m.note}</div> : null}</td>
                <td className="num">{m.balance_before}</td>
                <td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                <td className="num">{m.balance_after}</td>
                <td className="num">{m.unit_cost_paise != null ? formatPaise(m.unit_cost_paise) : '—'}</td>
                <td>{m.staff_email ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {can(actor, 'locations.manage') && (
        <section className="card form-panel" id="edit-location" aria-labelledby="le-h" data-section="edit-location">
          <h2 id="le-h">Edit location</h2>
          <ActionForm action={saveLocationAction} submitLabel="Save location" id="edit-location-form" label="Edit location">
            <Hidden name="locationId" value={l.id} />
            <Field name="name" label="Name" required defaultValue={l.name} />
            <Field name="code" label="Code" required defaultValue={l.code} />
            <Select name="kind" label="Kind" options={KIND_OPTIONS} defaultValue={l.kind} required />
            <TextArea name="address" label="Address (optional)" rows={2} defaultValue={l.address ?? ''} />
            <Checkbox name="active" label="Active" defaultChecked={l.is_active} hint={l.is_online ? 'The online location stays active.' : 'Only a location with no stock and no open transfers can be deactivated.'} />
          </ActionForm>
        </section>
      )}
      </>}
    </Entity>
  );
}
