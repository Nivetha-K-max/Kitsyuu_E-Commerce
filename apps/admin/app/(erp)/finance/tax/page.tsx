import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { companyDetails, companyState, listProductTax, listTaxRates } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { bp } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { productTaxAction, saveTaxRateAction } from '../actions';
import FinanceNav from '../FinanceNav';

export const metadata: Metadata = { title: 'Tax' };
type Rate = Awaited<ReturnType<typeof listTaxRates>>[number];

function RateFields({ r }: { r?: Rate }) {
  return (
    <>
      {r && <Hidden name="rateId" value={r.id} />}
      <div className="cols">
        <Field name="code" label="Code" defaultValue={r?.code} required hint="e.g. GST5" />
        <Field name="label" label="Label" defaultValue={r?.label} required />
        <Field name="ratePercent" label="Rate (%)" defaultValue={r ? String(r.rate_bp / 100) : ''} required />
        <Field name="validFrom" label="Valid from" type="date" defaultValue={r ? String(r.valid_from).slice(0, 10) : ''} required />
        <Field name="validTo" label="Valid to" type="date" defaultValue={r?.valid_to ? String(r.valid_to).slice(0, 10) : ''} />
      </div>
      <Checkbox name="inclusive" label="Included in the listed prices" defaultChecked={r?.is_inclusive ?? true} />
      <Checkbox name="active" label="Active" defaultChecked={r?.is_active ?? true} />
    </>
  );
}

/* ERP module 6: tax configuration. The business decides the rates (none are pre-set beyond the existing 0 % prototype
   rate). The store-wide rate at checkout is the active rate with the latest start date; per-product mapping is used on
   invoices, which must still equal the tax the order was charged. */
export default async function TaxPage() {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const [rates, products, company, state] = await Promise.all([listTaxRates(db(), actor), listProductTax(db(), actor), companyDetails(db()), companyState(db())]);
  const manage = can(actor, 'finance.manage');
  const rateOptions = [{ value: '', label: 'Default (store rate)' }, ...rates.map(r => ({ value: r.code, label: `${r.label} (${bp(r.rate_bp)})` }))];
  return (
    <>
      <PageHead title="Finance" eyebrow="GST rates, product tax mapping and the registered state used on invoices." />
      <FinanceNav current="/finance/tax" />
      <section className="card" aria-labelledby="co-h"><h2 id="co-h">Registered business</h2>
        <p>{company.legalName ?? <span className="muted">Legal name not entered</span>} · GSTIN {company.gstin ?? <span className="muted">not entered</span>} · State {state ?? <span className="muted">not set</span>}</p>
        <p className="note">Edit under <Link href="/settings">Configuration → Company</Link>. Without the state, invoices do not split GST into CGST/SGST or IGST.</p>
      </section>
      <section className="card" aria-labelledby="tr-h"><h2 id="tr-h">Tax rates</h2>
        <div className="table-wrap"><table data-tax-rates>
          <thead><tr><th>Code</th><th>Label</th><th className="num">Rate</th><th>In prices</th><th>Valid</th><th className="num">Products</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody>{rates.map(r => (
            <tr key={r.id}><td className="mono">{r.code}</td><td>{r.label}</td><td className="num">{bp(r.rate_bp)}</td><td>{r.is_inclusive ? 'included' : 'added'}</td>
              <td className="note">{String(r.valid_from).slice(0, 10)} → {r.valid_to ? String(r.valid_to).slice(0, 10) : 'open'}</td><td className="num">{r.products}</td>
              <td><span className={`badge ${r.is_active ? 'active' : 'inactive'}`}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
              {manage && <td><details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                <ActionForm action={saveTaxRateAction} submitLabel="Save" className="form compact row-edit-form" id={`rate-${r.id}`} label="Edit tax rate"
                  confirmText="Changing an active rate changes tax on carts priced from now on. Continue?"><RateFields r={r} /></ActionForm></details></td>}
            </tr>
          ))}</tbody>
        </table></div>
        {manage && <details className="row-edit"><summary className="btn ghost sm">Add a tax rate</summary>
          <ActionForm action={saveTaxRateAction} submitLabel="Add rate" className="form compact row-edit-form" id="new-rate" label="Add tax rate" resetOnSuccess
            confirmText="An active rate with the latest start date becomes the store rate for new carts. Continue?"><RateFields /></ActionForm></details>}
      </section>
      <section className="card" aria-labelledby="pt-h"><h2 id="pt-h">Product tax mapping</h2>
        <p className="note">Used on invoices (with the product’s HSN code). Leave “Default” to use the rate the order was charged at.</p>
        <div className="table-wrap"><table data-product-tax>
          <thead><tr><th>Product</th><th>HSN</th><th>Tax rate</th></tr></thead>
          <tbody>{products.map(p => (
            <tr key={p.id}><td>{p.name}<div className="note mono">{p.sku}</div></td><td className="mono">{p.hsn_code ?? '—'}</td>
              <td>{manage ? (
                <ActionForm action={productTaxAction} submitLabel="Save" variant="ghost" className="inline-form" id={`ptax-${p.id}`} label={`Tax rate for ${p.name}`}>
                  <Hidden name="productId" value={p.id} />
                  <Select name="taxRateCode" label="Rate" defaultValue={p.tax_rate_code ?? ''} options={rateOptions} />
                </ActionForm>) : (p.tax_rate_code ?? 'Default')}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </>
  );
}
