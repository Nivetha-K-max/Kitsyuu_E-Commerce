import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { discountRedemptions, discountSettings, listDiscounts, promotionTargets } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { bp, istLocal, rupeesField } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { saveDiscountAction, setDiscountActiveAction } from '../actions';
import PricingNav from '../PricingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Discounts & coupons' };
type Discount = Awaited<ReturnType<typeof listDiscounts>>[number];
type Targets = Awaited<ReturnType<typeof promotionTargets>>;

function Picks({ name, items, chosen }: { name: string; items: { id: string; label: string }[]; chosen: string[] }) {
  return (
    <div className="check-grid">{items.map(i => (
      <label key={i.id} className="check"><input type="checkbox" name={`${name}[]`} value={i.id} defaultChecked={chosen.includes(i.id)} /><span>{i.label}</span></label>
    ))}</div>
  );
}

function DiscountFields({ d, t }: { d?: Discount; t: Targets }) {
  return (
    <>
      {d && <Hidden name="discountId" value={d.id} />}
      <div className="cols">
        <Field name="name" label="Name" defaultValue={d?.name} required hint="Shown to staff; an automatic discount also shows it to customers." />
        <Field name="code" label="Coupon code" defaultValue={d?.code ?? ''} hint="Leave empty for an automatic discount (no code needed)." />
        <Select name="kind" label="Type" defaultValue={d?.kind ?? 'percent'} options={[{ value: 'percent', label: 'Percentage off' }, { value: 'fixed', label: 'Fixed amount off (₹)' }]} />
        <Field name="value" label="Value" defaultValue={d ? (d.kind === 'percent' ? String(d.value / 100) : rupeesField(d.value)) : ''} required hint="Percent (e.g. 10) or rupees." />
        <Select name="scope" label="Applies to" defaultValue={d?.scope ?? 'order'} options={[{ value: 'order', label: 'The whole order' }, { value: 'products', label: 'Chosen products' },
          { value: 'categories', label: 'Chosen categories' }, { value: 'collections', label: 'Chosen collections' }]} />
        <Field name="minOrder" label="Minimum order (₹)" defaultValue={rupeesField(d?.min_order_paise)} />
        <Field name="maxDiscount" label="Maximum discount (₹)" defaultValue={rupeesField(d?.max_discount_paise)} hint="Caps a percentage discount." />
        <Field name="usageLimit" label="Total uses" defaultValue={d?.usage_limit ? String(d.usage_limit) : ''} hint="Empty = no limit." />
        <Field name="perCustomerLimit" label="Uses per customer" defaultValue={d?.per_customer_limit ? String(d.per_customer_limit) : ''} />
        <Field name="startsAt" label="Starts (India time)" type="datetime-local" defaultValue={istLocal(d?.starts_at as Date | null)} />
        <Field name="endsAt" label="Ends (India time)" type="datetime-local" defaultValue={istLocal(d?.ends_at as Date | null)} />
        <Select name="campaignId" label="Campaign" defaultValue={d?.campaign_id ?? ''} options={[{ value: '', label: 'None' }, ...t.campaigns.map(c => ({ value: c.id, label: c.name }))]} />
      </div>
      <details><summary className="btn ghost sm">Products ({d?.product_ids.length ?? 0} chosen)</summary>
        <Picks name="productIds" items={t.products.map(p => ({ id: p.id, label: `${p.name} · ${p.sku}` }))} chosen={d?.product_ids ?? []} /></details>
      <details><summary className="btn ghost sm">Categories ({d?.category_ids.length ?? 0} chosen)</summary>
        <Picks name="categoryIds" items={t.categories.map(c => ({ id: c.id, label: c.label }))} chosen={d?.category_ids ?? []} /></details>
      <details><summary className="btn ghost sm">Collections ({d?.collection_ids.length ?? 0} chosen)</summary>
        <Picks name="collectionIds" items={t.collections.map(c => ({ id: c.id, label: c.label }))} chosen={d?.collection_ids ?? []} /></details>
      <Checkbox name="active" label="Active" defaultChecked={d?.is_active ?? false} hint="Customers only get it while it is active, inside its dates, and discounts are switched on in Settings." />
    </>
  );
}

/* ERP module 1: discounts and coupon codes. They take effect only while Configuration → Discounts → "Discounts and coupons" is
   on (off at launch). When several apply, Configuration → "More than one discount" decides (largest only by default). */
export default async function DiscountsPage() {
  const actor = await requireActor();
  if (!can(actor, 'pricing.read')) return <><PageHead title="Discounts & coupons" /><Forbidden permission="pricing.read" /></>;
  const [rows, settings, targets, recent] = await Promise.all([listDiscounts(db(), actor), discountSettings(db()), promotionTargets(db(), actor), discountRedemptions(db(), actor, undefined, 25)]);
  const manage = can(actor, 'pricing.manage');
  return (
    <Workspace name="pricing-discounts" title="Pricing & discounts" summary={settings.enabled ? `Discounts are ON · ${settings.stacking === 'all' ? 'all applicable discounts combine' : 'only the largest discount applies'}` : 'Discounts are OFF (Configuration → Discounts): nothing below is applied at checkout.'}>
      <PricingNav current="/pricing/discounts" />
      {rows.length === 0 ? <Empty title="No discounts yet" kind="discounts">Create a coupon code or an automatic discount below.</Empty> : (
        <div className="table-wrap"><table data-discounts-table>
          <thead><tr><th>Discount</th><th>Value</th><th>Applies to</th><th>Dates</th><th className="num">Uses</th><th className="num">Given</th><th>Status</th>{manage && <th>Actions</th>}</tr></thead>
          <tbody>{rows.map(d => (
            <tr key={d.id} data-discount={d.code ?? d.name}>
              <td><b>{d.name}</b><div className="note mono">{d.code ?? 'automatic'}</div>{d.campaign_name && <div className="note">Campaign: {d.campaign_name}</div>}</td>
              <td>{d.kind === 'percent' ? bp(d.value) : formatPaise(d.value)}{d.min_order_paise ? <div className="note">min {formatPaise(d.min_order_paise)}</div> : null}
                {d.max_discount_paise ? <div className="note">max {formatPaise(d.max_discount_paise)}</div> : null}</td>
              <td>{d.scope === 'order' ? 'Whole order' : `${d.scope}: ${(d.scope === 'products' ? d.product_ids : d.scope === 'categories' ? d.category_ids : d.collection_ids).length}`}</td>
              <td className="note">{d.starts_at ? formatDateTime(d.starts_at as Date) : 'now'} → {d.ends_at ? formatDateTime(d.ends_at as Date) : 'no end'}</td>
              <td className="num">{d.uses}{d.usage_limit ? ` / ${d.usage_limit}` : ''}</td><td className="num money">{formatPaise(d.given_paise)}</td>
              <td><span className={`badge ${d.state === 'active' ? 'active' : d.state === 'scheduled' ? 'scheduled' : 'inactive'}`}>{d.state}</span></td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveDiscountAction} submitLabel="Save" className="form compact row-edit-form" id={`discount-${d.id}`} label={`Edit ${d.name}`}><DiscountFields d={d} t={targets} /></ActionForm></details>
                <ActionForm action={setDiscountActiveAction} submitLabel={d.is_active ? 'Switch off' : 'Switch on'} variant={d.is_active ? 'danger' : 'ghost'} className="inline-form" id={`discount-active-${d.id}`} label="Switch discount">
                  <Hidden name="discountId" value={d.id} /><Hidden name="active" value={d.is_active ? 'false' : 'true'} /></ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="nd-h" data-section="new-discount">
          <h2 id="nd-h">New discount or coupon</h2>
          <ActionForm action={saveDiscountAction} submitLabel="Create" id="create-discount-form" label="Create discount" resetOnSuccess><DiscountFields t={targets} /></ActionForm>
        </section>
      )}
      <section className="card" aria-labelledby="dr-h" data-section="redemptions">
        <h2 id="dr-h">Recent redemptions</h2>
        {recent.length === 0 ? <Empty compact title="No discount has been used yet" /> : (
          <div className="table-wrap"><table data-redemptions-table>
            <thead><tr><th>When</th><th>Discount</th><th>Order</th><th className="num">Off</th><th className="num">Order total</th></tr></thead>
            <tbody>{recent.map(r => (
              <tr key={r.id}><td className="nowrap">{formatDateTime(r.created_at as Date)}</td><td>{r.discount_name}{r.code && <div className="note mono">{r.code}</div>}</td>
                <td className="mono">{can(actor, 'orders.read') ? <Link href={`/orders/${r.order_id}`}>{r.order_number}</Link> : r.order_number} <span className="note">{r.order_status}</span></td>
                <td className="num money">{formatPaise(r.amount_paise)}</td><td className="num money">{formatPaise(r.total_paise)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </Workspace>
  );
}
