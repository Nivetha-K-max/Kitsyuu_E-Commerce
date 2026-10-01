import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listDraftOrders } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { createDraftAction } from './actions';

export const metadata: Metadata = { title: 'Draft orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const TABS = [['open', 'Open'], ['confirmed', 'Became orders'], ['cancelled', 'Cancelled'], ['all', 'All']] as const;

/* Draft orders (2026-10-01): orders staff prepare for a customer — by phone, in a branch, or for someone who finds the
   website hard — before they are final. A draft holds no stock; confirming it creates the real order. */
export default async function DraftsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead title="Draft orders" /><Forbidden permission="orders.read" /></>;
  const sp = await searchParams;
  const status = (TABS.find(t => t[0] === one(sp.status))?.[0] ?? 'open') as 'open' | 'confirmed' | 'cancelled' | 'all';
  const create = can(actor, 'orders.create');
  const [drafts, branches, preset] = await Promise.all([
    listDraftOrders(db(), actor, { status }),
    db().selectFrom('locations').select(['id', 'name']).where('is_online', '=', false).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
    /^[0-9a-f-]{36}$/i.test(one(sp.customer)) ? db().selectFrom('customers').select(['id', 'email', 'full_name']).where('id', '=', one(sp.customer)).executeTakeFirst() : null,
  ]);
  return (
    <>
      <PageHead title="Draft orders" eyebrow="Orders prepared by staff before they are final. A draft holds no stock." />
      <nav className="tabs actions" aria-label="Draft order status" data-draft-tabs>
        {TABS.map(([k, label]) => <Link key={k} className={`btn ${k === status ? '' : 'ghost'} sm`} href={`/drafts?status=${k}`} aria-current={k === status ? 'page' : undefined}>{label}</Link>)}
      </nav>
      <section className="card" aria-labelledby="dl-h" data-section="drafts">
        <SectionTitle id="dl-h">{TABS.find(t => t[0] === status)![1]}</SectionTitle>
        {drafts.length === 0 ? <Empty compact title="No draft orders here" kind="drafts" /> : (
          <div className="table-wrap"><table data-drafts-table>
            <thead><tr><th>Draft</th><th>Customer</th><th>Where</th><th className="num">Units</th><th>Discount</th><th>By</th><th>Updated</th><th>Status</th></tr></thead>
            <tbody>{drafts.map(d => {
              const contact = (d.contact ?? {}) as { name?: string | null; phone?: string | null };
              return (
                <tr key={d.id} data-draft={d.number}>
                  <td><Link href={`/drafts/${d.id}`}>{d.number}</Link></td>
                  <td>{d.customer_name ?? d.customer_email ?? contact.name ?? contact.phone ?? '—'}{d.customer_email && d.customer_name ? <div className="note">{d.customer_email}</div> : null}</td>
                  <td>{d.channel === 'retail' ? `In store · ${d.location_name}` : 'Online (delivered)'}</td>
                  <td className="num">{formatNumber(d.units)}</td>
                  <td>{d.discount_bp ? `${d.discount_bp / 100}%` : '—'}</td>
                  <td>{d.owner_email ?? '—'}</td>
                  <td>{formatDateTime(d.updated_at as Date)}</td>
                  <td><StatusBadge status={d.status === 'confirmed' ? 'processed' : d.status === 'open' ? 'draft' : 'cancelled'} />{d.order_id ? <> · <Link href={`/orders/${d.order_id}`}>{d.order_number}</Link></> : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
      {create && (
        <section className="card form-panel" aria-labelledby="dn-h" data-section="new-draft">
          <h2 id="dn-h">New draft order</h2>
          <p className="note"><b>Online</b>: delivered to the customer, who pays from their account (or cash on delivery where allowed). <b>In a branch</b>: the customer is in the store,
            pays there and takes the items; the stock comes from that branch{branches.length ? '' : ' (add a retail location under Locations first)'}.</p>
          <ActionForm action={createDraftAction} submitLabel="Create draft" id="new-draft-form" label="New draft order">
            <Select name="channel" label="Where" required defaultValue={preset ? 'online' : ''} options={[{ value: '', label: 'Choose…' }, { value: 'online', label: 'Online (delivered to the customer)' }, ...(branches.length ? [{ value: 'retail', label: 'In a branch (paid and collected in the store)' }] : [])]} />
            {preset
              ? <><Hidden name="customerId" value={preset.id} /><p className="note" data-draft-customer>Customer: <b>{preset.full_name ?? preset.email}</b> ({preset.email})</p></>
              : <Field name="customerEmail" label="Customer account email" hint="Needed for online orders. Optional in a branch (for a walk-in customer, give a name or phone below)." autoComplete="off" />}
            {branches.length > 0 && <Select name="locationId" label="Branch (in-store orders)" options={[{ value: '', label: '—' }, ...branches.map(b => ({ value: b.id, label: b.name }))]} />}
            <Field name="contactName" label="Walk-in customer name (no account)" autoComplete="off" />
            <Field name="contactPhone" label="Walk-in customer phone" autoComplete="off" />
            <Field name="contactEmail" label="Walk-in customer email (optional)" autoComplete="off" />
            <TextArea name="note" label="Note (optional)" rows={2} />
          </ActionForm>
        </section>
      )}
    </>
  );
}
