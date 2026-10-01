import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getInvoice, pricingView } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import PrintButton from '@/components/PrintButton';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { bp } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { createNoteAction, voidInvoiceAction } from '../../actions';

export const metadata: Metadata = { title: 'Invoice' };
type Json = Record<string, string | null | undefined>;

/* A printable GST invoice. Seller details are the snapshot taken when it was issued; missing details are left out. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/finance/invoices', label: 'Invoices' }];
  if (!can(actor, 'finance.read')) return <><PageHead title="Invoice" crumbs={crumbs} /><Forbidden permission="finance.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let data;
  try { data = await getInvoice(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { invoice: i, items, notes } = data;
  const seller = (i.seller_details ?? {}) as Json;
  const bill = (i.billing_address ?? {}) as Json;
  const ship = (i.shipping_address ?? {}) as Json;
  const pv = pricingView(i.pricing);
  const split = (i.tax_split ?? {}) as { type?: string; cgst?: number; sgst?: number; igst?: number; note?: string | null };
  // Second pass: the invoice total is the order total, which includes a cash-on-delivery fee when there is one.
  const codFee = i.total_paise - (i.subtotal_paise - i.discount_paise + i.shipping_paise + (i.prices_include_tax ? 0 : i.tax_paise));
  const manage = can(actor, 'finance.manage');
  return (
    <>
      <div className="no-print">
        <PageHead title={`Invoice ${i.invoice_number ?? ''}`} crumbs={crumbs} eyebrow={`Order ${i.order_number ?? '—'}`}><PrintButton /></PageHead>
        {i.status === 'void' && <p className="msg error" role="status">Void: {i.void_reason} ({formatDateTime(i.voided_at as Date)})</p>}
      </div>
      <article className="slip card" data-invoice>
        <header className="slip-head">
          <div>
            <p className="slip-brand">{seller.legalName ?? 'KITSYUU'}</p>
            {seller.address && <p className="msg-body">{seller.address}</p>}
            {seller.gstin && <p>GSTIN {seller.gstin}</p>}{seller.state && <p>State: {seller.state}</p>}
          </div>
          <div>
            <h2>Tax invoice</h2>
            <p className="mono">{i.invoice_number}</p><p>Date: {formatDateTime(i.issued_at as Date)}</p><p>Order: {i.order_number}</p>
            <p>Place of supply: {i.place_of_supply ?? '—'}</p><p><StatusBadge status={i.status} /></p>
          </div>
        </header>
        <div className="grid two slip-parties">
          <section><h3>Bill to</h3><p>{[bill.name, bill.line1, bill.line2, bill.city, bill.state, bill.pin].filter(Boolean).join(', ')}</p>{bill.email && <p>{bill.email}</p>}{bill.phone && <p>{String(bill.phone)}</p>}</section>
          <section data-invoice-ship-to><h3>Ship to</h3><p>{[ship.name, ship.line1, ship.line2, ship.city, ship.state, ship.pin].filter(Boolean).join(', ') || '—'}</p></section>
        </div>
        <div className="table-wrap"><table data-invoice-items>
          <thead><tr><th>Item</th><th>HSN</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Tax rate</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
          <tbody>{items.map(it => (
            <tr key={it.id}><td>{it.description}<div className="note mono">{it.sku}</div></td><td>{it.hsn_code ?? '—'}</td><td className="num">{it.qty}</td>
              <td className="num money">{formatPaise(it.unit_price_paise)}</td><td className="num">{bp(it.tax_rate_bp)}</td><td className="num money">{formatPaise(it.tax_paise)}</td>
              <td className="num money">{formatPaise(it.line_total_paise)}</td></tr>
          ))}</tbody>
        </table></div>
        <table className="totals"><tbody>
          <tr><td>Subtotal</td><td className="num money">{formatPaise(i.subtotal_paise)}</td></tr>
          {i.discount_paise > 0 && (pv.discounts.length > 0
            ? pv.discounts.map((d, n) => <tr key={n} data-invoice-discount={d.code}><td>{d.label}</td><td className="num money">−{formatPaise(d.amountPaise)}</td></tr>)
            : <tr><td>Discount</td><td className="num money">−{formatPaise(i.discount_paise)}</td></tr>)}
          <tr><td>{pv.delivery ? `${pv.delivery.pickup ? 'Store pickup' : 'Delivery'}: ${pv.delivery.label}` : 'Delivery'}</td><td className="num money">{formatPaise(i.shipping_paise)}</td></tr>
          {codFee > 0 && <tr><td>Cash on delivery fee</td><td className="num money">{formatPaise(codFee)}</td></tr>}
          {split.type === 'intra' && <><tr><td>CGST</td><td className="num money">{formatPaise(split.cgst ?? 0)}</td></tr><tr><td>SGST</td><td className="num money">{formatPaise(split.sgst ?? 0)}</td></tr></>}
          {split.type === 'inter' && <tr><td>IGST</td><td className="num money">{formatPaise(split.igst ?? 0)}</td></tr>}
          {split.type === 'unknown' && <tr><td>Tax{i.prices_include_tax ? ' (included in the prices)' : ''}</td><td className="num money">{formatPaise(i.tax_paise)}</td></tr>}
          <tr><td><b>Total</b></td><td className="num money"><b>{formatPaise(i.total_paise)}</b></td></tr>
        </tbody></table>
        {split.type === 'unknown' && <p className="note">{split.note}</p>}
        {i.prices_include_tax && <p className="note">Prices include tax.</p>}
        <dl className="facts" data-invoice-payment>
          <dt>Payment method</dt><dd>{i.payment_method === 'cod' ? 'Cash on delivery' : i.payment_method ? 'Online' : '—'}</dd>
          <dt>Payment status</dt><dd>{i.payment_status ? i.payment_status.replace(/_/g, ' ') : '—'}</dd>
          <dt>Order status</dt><dd>{i.order_status ? i.order_status.replace(/_/g, ' ') : '—'}</dd>
          {(i.loyalty_points_used ?? 0) > 0 && <><dt>Loyalty points used</dt><dd>{i.loyalty_points_used} (−{formatPaise(i.loyalty_discount_paise ?? 0)}, included in the discount)</dd></>}
        </dl>
      </article>
      <div className="no-print">
        <section className="card" aria-labelledby="nt-h" data-section="invoice-notes">
          <h2 id="nt-h">Credit and debit notes</h2>
          {notes.length === 0 ? <p className="note">None.</p> : (
            <table><tbody>{notes.map(n => <tr key={n.id}><td>{n.kind} note {n.number ?? '(draft)'}</td><td>{n.reason}</td><td className="num money">{formatPaise(n.amount_paise)}</td><td><StatusBadge status={n.status} /></td></tr>)}</tbody></table>
          )}
          {manage && i.status === 'issued' && (
            <ActionForm action={createNoteAction} submitLabel="Save draft note" id="note-form" label="New note" resetOnSuccess>
              <Hidden name="invoiceId" value={i.id} />
              <div className="cols">
                <Select name="kind" label="Kind" options={[{ value: 'credit', label: 'Credit note (reduces what is owed)' }, { value: 'debit', label: 'Debit note (increases it)' }]} />
                <Field name="amount" label="Amount incl. tax (₹)" required />
                <Field name="tax" label="Of which tax (₹)" />
                <Field name="reason" label="Reason" required />
              </div>
            </ActionForm>
          )}
        </section>
        {manage && i.status === 'issued' && (
          <section className="card" aria-labelledby="vd-h"><h2 id="vd-h">Void this invoice</h2>
            <ActionForm action={voidInvoiceAction} submitLabel="Void invoice" variant="danger" id="void-invoice-form" label="Void invoice" confirmText="Void this invoice? Its number stays used.">
              <Hidden name="invoiceId" value={i.id} /><Field name="reason" label="Reason" required />
            </ActionForm></section>
        )}
      </div>
    </>
  );
}
