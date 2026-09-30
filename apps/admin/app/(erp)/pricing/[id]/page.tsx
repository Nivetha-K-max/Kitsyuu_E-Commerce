import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getProductPricing } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { rupeesField } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { cancelPriceChangeAction, schedulePriceAction, setPricingAction } from '../actions';

export const metadata: Metadata = { title: 'Product pricing' };

export default async function ProductPricingPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pricing', label: 'Pricing' }];
  if (!can(actor, 'pricing.read')) return <><PageHead title="Product pricing" crumbs={crumbs} /><Forbidden permission="pricing.read" /></>;
  const { id } = await params;
  let data;
  try { data = await getProductPricing(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { product: p, variants, changes, history } = data;
  const manage = can(actor, 'pricing.manage');
  const money = (v: number | null) => (v === null ? '—' : formatPaise(v));
  return (
    <>
      <PageHead title={p.name} crumbs={crumbs} eyebrow={`${p.sku} · price ${formatPaise(p.price_paise)}${p.compare_at_paise ? ` · was ${formatPaise(p.compare_at_paise)}` : ''}`} />
      <div className="grid-2">
        <section className="card" aria-labelledby="pp-h" data-section="product-price">
          <h2 id="pp-h">Product price</h2>
          {manage ? (
            <ActionForm action={setPricingAction} submitLabel="Save price" id="product-price-form" label="Product price">
              <Hidden name="productId" value={p.id} />
              <div className="cols">
                <Field name="price" label="Price (₹)" defaultValue={rupeesField(p.price_paise)} required />
                <Field name="compareAt" label="Compare-at price (₹)" defaultValue={rupeesField(p.compare_at_paise)} hint="Optional “was” price; must be above the price." />
              </div>
            </ActionForm>
          ) : <p>{formatPaise(p.price_paise)}{p.compare_at_paise ? ` (was ${formatPaise(p.compare_at_paise)})` : ''}</p>}
        </section>
        <section className="card" aria-labelledby="ps-h" data-section="schedule-price">
          <h2 id="ps-h">Schedule a change</h2>
          {manage ? (
            <ActionForm action={schedulePriceAction} submitLabel="Schedule" id="schedule-price-form" label="Schedule a price change" resetOnSuccess>
              <Hidden name="productId" value={p.id} />
              <Select name="variantId" label="For" options={[{ value: '', label: 'The product (all sizes without their own price)' }, ...variants.map(v => ({ value: v.id, label: `Size ${v.size}` }))]} />
              <div className="cols">
                <Field name="price" label="New price (₹)" hint="Leave empty to keep the price." />
                <Field name="compareAt" label="New compare-at (₹)" />
              </div>
              <Checkbox name="clearCompareAt" label="Remove the compare-at price (end a sale)" />
              <Field name="effectiveAt" label="From (India time)" type="datetime-local" required />
              <TextArea name="note" label="Note (staff only)" rows={2} />
            </ActionForm>
          ) : <p className="note">You can view scheduled changes; changing them needs pricing.manage.</p>}
        </section>
      </div>
      <section className="card" aria-labelledby="sz-h" data-section="size-prices">
        <h2 id="sz-h">Sizes</h2>
        <p className="note">A size with no price of its own sells at the product price.</p>
        <div className="table-wrap"><table data-size-prices>
          <thead><tr><th>Size</th><th>SKU</th><th className="num">Own price</th><th className="num">Compare-at</th>{manage && <th>Edit</th>}</tr></thead>
          <tbody>{variants.map(v => (
            <tr key={v.id} data-size={v.size}>
              <td>{v.size}{!v.is_active && <span className="badge inactive">inactive</span>}</td><td className="mono">{v.sku}</td>
              <td className="num money">{v.price_paise === null ? <span className="muted">product price</span> : formatPaise(v.price_paise)}</td>
              <td className="num money">{money(v.compare_at_paise)}</td>
              {manage && <td><details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                <ActionForm action={setPricingAction} submitLabel="Save" className="form compact row-edit-form" id={`size-price-${v.id}`} label={`Price of size ${v.size}`}>
                  <Hidden name="productId" value={p.id} /><Hidden name="variantId" value={v.id} />
                  <Field name="price" label="Own price (₹)" defaultValue={rupeesField(v.price_paise)} hint="Empty = the product price." />
                  <Field name="compareAt" label="Compare-at (₹)" defaultValue={rupeesField(v.compare_at_paise)} />
                </ActionForm></details></td>}
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      <section className="card" aria-labelledby="sc-h" data-section="scheduled">
        <h2 id="sc-h">Scheduled changes</h2>
        {changes.length === 0 ? <Empty compact title="No scheduled changes" /> : (
          <div className="table-wrap"><table data-scheduled-table>
            <thead><tr><th>From</th><th>For</th><th className="num">Price</th><th className="num">Compare-at</th><th>Status</th><th>By</th>{manage && <th />}</tr></thead>
            <tbody>{changes.map(c => (
              <tr key={c.id}>
                <td className="nowrap">{formatDateTime(c.effective_at as Date)}</td><td>{c.size ? `Size ${c.size}` : 'Product'}</td>
                <td className="num">{money(c.new_price_paise)}</td><td className="num">{c.clear_compare_at ? 'remove' : money(c.new_compare_at_paise)}</td>
                <td><StatusBadge status={c.status} />{c.failure_reason && <div className="note">{c.failure_reason}</div>}</td><td>{c.created_by_email ?? '—'}</td>
                {manage && <td>{c.status === 'scheduled' && <ActionForm action={cancelPriceChangeAction} submitLabel="Cancel" variant="danger" className="inline-form" id={`cancel-${c.id}`} label="Cancel scheduled change">
                  <Hidden name="changeId" value={c.id} /></ActionForm>}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="card" aria-labelledby="ph-h" data-section="history">
        <h2 id="ph-h">Price history</h2>
        {history.length === 0 ? <Empty compact title="No price changes recorded yet" /> : (
          <div className="table-wrap"><table data-history-table>
            <thead><tr><th>When</th><th>What</th><th className="num">From</th><th className="num">To</th><th>How</th><th>By</th></tr></thead>
            <tbody>{history.map(h => (
              <tr key={h.id}><td className="nowrap">{formatDateTime(h.created_at as Date)}</td><td>{h.field === 'price' ? 'Price' : 'Compare-at'}{h.size ? `, size ${h.size}` : ''}</td>
                <td className="num">{money(h.old_paise)}</td><td className="num">{money(h.new_paise)}</td><td>{h.source}</td><td>{h.staff_email ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
