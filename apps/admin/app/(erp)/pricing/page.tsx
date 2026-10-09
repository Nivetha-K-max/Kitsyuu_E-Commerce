import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { applyDuePriceChanges, discountSettings, listProductPrices, pricingOverview } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Select } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { bulkPriceAction } from './actions';
import PricingNav from './PricingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Pricing' };
const FILTERS = [['all', 'All products'], ['sale', 'On sale (compare-at set)'], ['scheduled', 'With a scheduled change'], ['overrides', 'With size prices']] as const;

/* ERP module 1: product prices. Changing a price here affects carts priced from then on; orders keep the price they were
   placed at. Scheduled changes that are due are applied when this page opens (and by the scheduled job). */
export default async function PricingPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'pricing.read')) return <><PageHead title="Pricing & discounts" /><Forbidden permission="pricing.read" /></>;
  const applied = await applyDuePriceChanges(db()).catch(e => { console.error('[pricing] apply due changes', e); return { applied: 0, failed: 0 }; });
  const sp = await searchParams;
  const filter = (FILTERS.find(f => f[0] === one(sp.filter))?.[0] ?? 'all') as typeof FILTERS[number][0];
  const page = pageOf(sp.page);
  const q = one(sp.q).trim().slice(0, 60) || undefined;
  const [overview, list, ds] = await Promise.all([pricingOverview(db(), actor), listProductPrices(db(), actor, { q, filter, page }), discountSettings(db())]);
  const manage = can(actor, 'pricing.manage');
  const qs = (p: number) => `/pricing?filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ''}&page=${p}`;
  return (
    <Workspace name="pricing" title="Pricing & discounts" summary="Product prices, compare-at (sale) prices, scheduled changes, discounts and coupons.">
      <PricingNav current="/pricing" />
      {applied.applied + applied.failed > 0 && <p className="msg ok" role="status">{applied.applied} scheduled change{applied.applied === 1 ? '' : 's'} applied{applied.failed ? `, ${applied.failed} failed (see Scheduled changes)` : ''}.</p>}
      <dl className="report-kpis" data-pricing-kpis>
        <div><dt>Products on sale</dt><dd>{formatNumber(overview.onSale)}</dd></div>
        <div><dt>Scheduled changes</dt><dd>{formatNumber(overview.scheduled)}</dd></div>
        <div><dt>Active discounts</dt><dd>{formatNumber(overview.activeDiscounts)}<small>{ds.enabled ? 'Discounts are switched on' : 'Switched off in Configuration → Discounts'}</small></dd></div>
        <div><dt>Discount given (30 days)</dt><dd>{formatPaise(overview.discount30dPaise)}<small>{formatNumber(overview.redemptions30d)} orders</small></dd></div>
      </dl>
      <FilterForm className="actions" role="search" aria-label="Filter products" data-pricing-filters>
        <label className="sr-only" htmlFor="pr-q">Search</label>
        <input id="pr-q" name="q" className="input" placeholder="Name or SKU" defaultValue={q ?? ''} />
        <label className="sr-only" htmlFor="pr-f">Show</label>
        <select id="pr-f" name="filter" className="input" defaultValue={filter}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No products match" kind="pricing" /> : (
        <ActionForm action={bulkPriceAction} submitLabel="Apply to selected" className="form form-wide" id="bulk-price-form" label="Bulk price change"
          confirmText="Change the price of the selected products?" hideSubmit={!manage}>
          <div className="table-wrap"><table data-pricing-table>
            <thead><tr>{manage && <th><span className="sr-only">Select</span></th>}<th>Product</th><th className="num">Price</th><th className="num">Compare-at</th><th className="num">Sizes</th><th>Notes</th></tr></thead>
            <tbody>{list.rows.map(p => (
              <tr key={p.id} data-pricing-row={p.sku}>
                {manage && <td><input type="checkbox" name="productIds[]" value={p.id} aria-label={`Select ${p.name}`} /></td>}
                <td><Link className="row-link" href={`/products/${p.id}?tab=pricing`}><b>{p.name}</b></Link><div className="note mono">{p.sku} · {p.status}</div></td>
                <td className="num money">{formatPaise(p.price_paise)}</td>
                <td className="num money">{p.compare_at_paise ? <span className="strike">{formatPaise(p.compare_at_paise)}</span> : '—'}</td>
                <td className="num">{p.sizes}</td>
                <td>{p.overrides > 0 && <span className="badge info">{p.overrides} size price{p.overrides === 1 ? '' : 's'}</span>}{p.scheduled > 0 && <span className="badge scheduled">{p.scheduled} scheduled</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {manage && (
            <fieldset className="fieldset" data-bulk-fields>
              <legend>Bulk change for the selected products</legend>
              <div className="cols">
                <Select name="mode" label="Change" options={[{ value: 'decrease_percent', label: 'Decrease by %' }, { value: 'increase_percent', label: 'Increase by %' },
                  { value: 'decrease_amount', label: 'Decrease by ₹' }, { value: 'increase_amount', label: 'Increase by ₹' }, { value: 'set', label: 'Set to ₹' }]} />
                <Field name="amount" label="Amount" hint="A percentage (e.g. 10) or rupees." required />
              </div>
              <Checkbox name="keepCompareAt" label="Sale: show the current price as the compare-at (was) price" hint="Otherwise a compare-at price that would no longer be above the new price is cleared." />
            </fieldset>
          )}
        </ActionForm>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={qs(page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(page + 1)}>Next</Link>}
      </nav>
    </Workspace>
  );
}
