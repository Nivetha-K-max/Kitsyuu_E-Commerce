/* One vendor (2026-10-08: on the shared entity frame).

     header  name, active / inactive, contact, what is open with them; New purchase order
     tabs    Overview · Purchase orders · Products supplied · Activity

   A vendor is the one record purchase orders refer to (never deleted, made inactive instead). It supplies finished
   products (chosen here, several at once) and / or materials; nothing here assumes it supplies only one kind. The
   purchase orders and their quantities are read from the orders themselves; this page keeps no figures of its own. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { sql } from '@kitsyuu/db';
import { listVendors, vendorProducts } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Entity, Facts, Figures, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import ProductPicker from '@/components/ProductPicker';
import RecordActivity from '@/components/RecordActivity';
import { ProductStatusPill } from '@/components/StatusPill';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatDay, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveVendorAction, setVendorActiveAction, setVendorProductsAction } from '../actions';
import { VendorFields } from '../fields';

export const metadata: Metadata = { title: 'Vendor' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['overview', 'Overview'], ['orders', 'Purchase orders'], ['products', 'Products supplied'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const OPEN = ['approved', 'ordered', 'partially_received'];

export default async function VendorPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/vendors', label: 'Vendors' }];
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Vendor" crumbs={crumbs} /><Forbidden permission="procurement.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = (await listVendors(db(), actor)).find(x => x.id === id);
  if (!v) notFound();
  const manage = can(actor, 'procurement.manage'), costs = can(actor, 'costs.read'), seeProducts = can(actor, 'products.read'), seeAudit = can(actor, 'audit.read');
  const tabs = TABS.filter(t => t[0] !== 'activity' || seeAudit);
  const tab: Tab = tabs.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const self = `/vendors/${v.id}`;
  const href = (t: string) => (t === 'overview' ? self : `${self}?tab=${t}`);
  // The vendor's purchase orders with their quantities, from the orders' own lines (read-only).
  const orders = (await db().selectFrom('purchase_orders as p').leftJoin('locations as l', 'l.id', 'p.location_id')
    .select(['p.id', 'p.po_number', 'p.status', 'p.expected_on', 'p.created_at', 'l.name as location',
      sql<string>`(select coalesce(sum(ln.qty_ordered), 0)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('ordered'),
      sql<string>`(select coalesce(sum(ln.qty_received), 0)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('received'),
      sql<string | null>`(select sum(ln.qty_ordered * ln.unit_cost_paise)::text from public.purchase_order_lines ln where ln.purchase_order_id = p.id)`.as('value')])
    .where('p.vendor_id', '=', v.id).orderBy('p.created_at', 'desc').limit(200).execute())
    .map(o => ({ ...o, ordered: Number(o.ordered), received: Number(o.received) }));
  const openOrders = orders.filter(o => OPEN.includes(o.status));
  const toCome = orders.filter(o => o.status === 'ordered' || o.status === 'partially_received').reduce((n, o) => n + Math.max(0, o.ordered - o.received), 0);
  const products = tab === 'products' ? await vendorProducts(db(), actor, v.id) : null;

  const orderTable = (rows: typeof orders) => (
    <div className="table-wrap"><table data-vendor-orders>
      <thead><tr><th>Order</th><th>Expected</th><th>Receive at</th><th className="num">Received</th><th className="num">To come</th>{costs && <th className="num">Order value</th>}<th>Status</th></tr></thead>
      <tbody>{rows.map(o => {
        const counting = !['draft', 'approved', 'cancelled'].includes(o.status), left = Math.max(0, +(o.ordered - o.received).toFixed(3));
        return (
          <tr key={o.id} data-vendor-order={o.po_number}>
            <td><NavLink href={`/purchase-orders/${o.id}`} className="row-link mono-strong">{o.po_number}</NavLink><div className="note">{formatDateTime(o.created_at as Date)}</div></td>
            <td className="nowrap">{o.expected_on ? formatDay(o.expected_on) : '—'}</td><td>{o.location ?? 'Online stock'}</td>
            <td className="num">{counting ? `${fmt(o.received)} of ${fmt(o.ordered)}` : <span className="note">{fmt(o.ordered)} ordered</span>}</td>
            <td className="num">{o.status === 'ordered' || o.status === 'partially_received' ? <b>{fmt(left)}</b> : '—'}</td>
            {costs && <td className="num">{o.value === null ? '—' : formatPaise(Math.round(Number(o.value)))}</td>}
            <td><StatusBadge status={o.status} /></td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );

  return (
    <Entity module={{ href: '/vendors', label: 'Vendors' }} name="vendor" title={v.name}
      status={<span className={`badge ${v.is_active ? 'active' : 'disabled'}`} data-vendor-status>{v.is_active ? 'Active' : 'Inactive'}</span>}
      factsAttr="data-vendor-facts"
      facts={[
        ...(v.contact || v.phone ? [{ label: 'Contact', value: [v.contact, v.phone].filter(Boolean).join(' · ') }] : []),
        { label: 'Open orders', value: formatNumber(openOrders.length), attr: 'open-orders' },
        { label: 'Products supplied', value: formatNumber(v.products), attr: 'products' },
      ]}
      actions={<div className="ord-head-actions">
        {manage && v.is_active && <Link className="btn sm" href={`/purchase-orders/new?vendor=${v.id}`} data-link="new-po">New purchase order</Link>}
        {manage && (
          <Drawer trigger="Edit details" triggerClass="btn ghost sm" name="edit-vendor" scope="ord" title={`Edit ${v.name}`}>
            <ActionForm action={saveVendorAction} submitLabel="Save" id={`vendor-edit-${v.id}`} label={`Edit ${v.name}`}><VendorFields v={v} /></ActionForm>
          </Drawer>
        )}
      </div>}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'orders' ? orders.length : tid === 'products' ? v.products : undefined }))} current={tab} tabHref={href}
      notice={!v.is_active ? <p className="msg" role="status" data-vendor-inactive>This vendor is inactive: no new purchase order can be placed with it. Its past orders are kept.</p> : undefined}>

      {tab === 'overview' && <>
        <Section id="vo-h" title="Open with this vendor" name="open" wide hint="Orders approved or sent and not yet fully received.">
          <Figures items={[
            { label: 'Open orders', value: formatNumber(openOrders.length), note: orders.length ? `${formatNumber(orders.length)} in all` : 'none placed yet' },
            { label: 'Still to come', value: fmt(+toCome.toFixed(3)), note: 'on orders sent to the vendor' },
            { label: 'Products supplied', value: formatNumber(v.products) },
          ]} />
          {openOrders.length > 0 ? orderTable(openOrders) : <p className="note" data-empty="vendor-open">Nothing is open with this vendor.</p>}
        </Section>
        <Section id="vd-h" title="Details" name="details">
          <Facts attr="data-vendor-details" items={[
            { label: 'Name', value: v.name }, { label: 'Contact person', value: v.contact ?? '—' }, { label: 'Email', value: v.email ?? '—' }, { label: 'Phone', value: v.phone ?? '—' },
            { label: 'GSTIN', value: v.gstin ? <span className="mono">{v.gstin}</span> : '—' }, { label: 'Address', value: v.address ?? '—' }, { label: 'Notes (staff only)', value: v.notes ?? '—' },
          ]} />
        </Section>
        {manage ? (
          <Section id="va-h" title={v.is_active ? 'Make inactive' : 'Make active'} name="vendor-active"
            hint={v.is_active ? 'An inactive vendor is kept for its history but cannot be chosen for a new purchase order.' : 'An active vendor can be chosen for purchase orders again.'}>
            <ActionForm action={setVendorActiveAction} submitLabel={v.is_active ? 'Deactivate' : 'Activate'} variant={v.is_active ? 'danger' : 'ghost'} className="inline-form"
              id={`vendor-active-${v.id}`} label={`${v.is_active ? 'Deactivate' : 'Activate'} ${v.name}`} confirmText={v.is_active ? `Make ${v.name} inactive?` : undefined}>
              <Hidden name="vendorId" value={v.id} /><Hidden name="active" value={v.is_active ? 'false' : 'true'} />
            </ActionForm>
          </Section>
        ) : <p className="note" data-readonly="vendor">Changing a vendor needs the procurement.manage permission.</p>}
      </>}

      {tab === 'orders' && (
        <Section id="vp-h" title="Purchase orders" name="orders" wide meta={orders.length ? `${orders.length}` : undefined} hint="Every order placed with this vendor, newest first.">
          {orders.length ? orderTable(orders) : <StateBlock title="No purchase orders yet" name="vendor-orders"
            action={manage && v.is_active ? <Link className="btn ghost sm" href={`/purchase-orders/new?vendor=${v.id}`}>New purchase order</Link> : undefined}>Orders placed with this vendor are listed here.</StateBlock>}
        </Section>
      )}

      {tab === 'products' && products && <>
        <Section id="vs-h" title="Products supplied" name="supplied" wide meta={products.linked.length ? `${products.linked.length}` : undefined}
          hint="The finished products this vendor supplies. A new purchase order shows these first. Materials are not tied to a vendor.">
          {products.linked.length ? <div className="table-wrap"><table data-vendor-supplied>
            <thead><tr><th>Product</th><th>Status</th></tr></thead>
            <tbody>{products.linked.map(p => (
              <tr key={p.id} data-supplied={p.sku}><td>{seeProducts ? <NavLink className="row-link" href={`/products/${p.id}`}>{p.name}</NavLink> : p.name}<div className="note mono">{p.sku}</div></td>
                <td><ProductStatusPill status={p.status} /></td></tr>))}</tbody>
          </table></div> : <StateBlock title="No products chosen" name="vendor-products">{manage ? 'Choose the products this vendor supplies below.' : 'No product has been chosen for this vendor.'}</StateBlock>}
        </Section>
        {manage && (
          <Section id="vc-h" title="Choose products" name="choose-products" hint="Tick every product this vendor supplies and save; the change is recorded with what was added and removed.">
            <ActionForm action={setVendorProductsAction} submitLabel="Save products" className="form compact" id={`vendor-products-${v.id}`} label={`Products ${v.name} supplies`}>
              <Hidden name="vendorId" value={v.id} />
              <ProductPicker products={products.all} selected={products.linked.map(p => p.id)} idPrefix={`vp-${v.id}`} />
            </ActionForm>
          </Section>
        )}
      </>}

      {tab === 'activity' && (
        <Section id="vact-h" title="Activity" name="activity" wide hint="Changes to this vendor, from the audit log. Its purchase orders keep their own activity.">
          <RecordActivity entityType="vendors" entityId={v.id} name="vendor" empty="Changes to this vendor are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
