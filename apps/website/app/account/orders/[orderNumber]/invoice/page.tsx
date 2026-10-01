import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { getCustomerInvoice } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import PrintButton from '@/components/PrintButton';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, rupees } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Invoice', robots: { index: false } };
type Params = Promise<{ orderNumber: string }>;
type Json = Record<string, string | null | undefined>;
const METHOD: Record<string, string> = { online: 'Online payment', cod: 'Cash on delivery', cash: 'Cash in store', card: 'Card in store', upi: 'UPI in store' };
const line = (a: Json) => [a.name, a.line1, a.line2, [a.city, a.state, a.pin].filter(Boolean).join(' ')].filter(Boolean).join(', ');

/* The customer's tax invoice (2026-10-01): the same issued invoice staff print (numbering, tax and amounts are the Finance
   module's). Print or save it as PDF with the browser. Online and in-store orders alike. */
export default async function InvoicePage({ params }: { params: Params }) {
  const orderNumber = decodeURIComponent((await params).orderNumber);
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(orderNumber)}/invoice`);
  if (!orderNumberInput.safeParse({ orderNumber }).success) notFound();
  const { order: o, invoice: i, items } = await getCustomerInvoice(db(), me, orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const seller = (i.seller_details ?? {}) as Json, bill = (i.billing_address ?? {}) as Json, ship = (i.shipping_address ?? {}) as Json;
  const split = (i.tax_split ?? {}) as { type?: string; cgst?: number; sgst?: number; igst?: number };
  const codFee = i.total_paise - (i.subtotal_paise - i.discount_paise + i.shipping_paise + (i.prices_include_tax ? 0 : i.tax_paise));
  return (
    <>
      <Crumbs list={[{ label: 'Orders', href: '/account/orders' }, { label: o.orderNumber, href: `/account/orders/${encodeURIComponent(o.orderNumber)}` }, { label: 'Invoice' }]} />
      <div className="st-no-print st-order-actions"><PrintButton label="Print / save as PDF" /><Link className="text-link" href={`/account/orders/${encodeURIComponent(o.orderNumber)}`}>Back to the order</Link></div>
      <article className="st-invoice" data-invoice>
        <header className="st-plp-head">
          <h1 id="st-page-title">Tax invoice</h1>
          <div className="st-plp-aside"><p className="st-result-count" data-invoice-number>{i.invoice_number}</p><p>Date {formatDate(i.issued_at as Date)} · Order {o.orderNumber} ({formatDate(i.order_date as Date)})</p></div>
        </header>
        <div className="st-invoice-parties">
          <section><h2>Sold by</h2><p>{seller.legalName ?? 'KITSYUU'}{seller.address ? <><br />{seller.address}</> : null}{seller.gstin ? <><br />GSTIN {seller.gstin}</> : null}</p></section>
          <section data-invoice-bill-to><h2>Bill to</h2><p>{line(bill) || '—'}{bill.email ? <><br />{bill.email}</> : null}{bill.phone ? <><br />{bill.phone}</> : null}</p></section>
          <section data-invoice-ship-to><h2>{o.channel === 'retail' ? 'Bought at' : 'Ship to'}</h2><p>{o.channel === 'retail' ? (o.branch ?? '—') : line(ship) || '—'}</p></section>
          <section><h2>Payment</h2><p>{METHOD[i.payment_method] ?? i.payment_method} · {i.payment_status ? PAYMENT_STATUS_LABEL[i.payment_status] ?? i.payment_status : '—'}<br />Order: {ORDER_STATUS_LABEL[i.order_status] ?? i.order_status}{i.place_of_supply ? <><br />Place of supply: {i.place_of_supply}</> : null}</p></section>
        </div>
        <div className="st-table-wrap"><table data-invoice-items>
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Tax</th><th className="num">Amount</th></tr></thead>
          <tbody>{items.map((it, n) => (
            <tr key={n}><td>{it.description}<br /><small>{it.sku}{it.hsn_code ? ` · HSN ${it.hsn_code}` : ''}</small></td><td className="num">{it.qty}</td>
              <td className="num">{rupees(it.unit_price_paise)}</td><td className="num">{it.tax_rate_bp ? `${it.tax_rate_bp / 100}% · ${rupees(it.tax_paise)}` : '—'}</td><td className="num">{rupees(it.line_total_paise)}</td></tr>
          ))}</tbody>
        </table></div>
        <div className="st-invoice-totals" data-invoice-totals>
          <div><span>Subtotal</span><span>{rupees(i.subtotal_paise)}</span></div>
          {i.discount_paise > 0 && (o.discounts.length > 0
            ? o.discounts.map((d, n) => <div key={n} data-invoice-discount={d.code}><span>{d.label}</span><span>−{rupees(d.amountPaise)}</span></div>)
            : <div data-invoice-discount><span>Discount</span><span>−{rupees(i.discount_paise)}</span></div>)}
          {o.channel !== 'retail' && <div data-invoice-delivery><span>{o.delivery ? `${o.delivery.pickup ? 'Store pickup' : 'Delivery'}: ${o.delivery.label}` : 'Delivery'}</span><span>{rupees(i.shipping_paise)}</span></div>}
          {codFee > 0 && <div><span>Cash on delivery fee</span><span>{rupees(codFee)}</span></div>}
          {split.type === 'intra' && <><div><span>CGST</span><span>{rupees(split.cgst ?? 0)}</span></div><div><span>SGST</span><span>{rupees(split.sgst ?? 0)}</span></div></>}
          {split.type === 'inter' && <div><span>IGST</span><span>{rupees(split.igst ?? 0)}</span></div>}
          {split.type !== 'intra' && split.type !== 'inter' && i.tax_paise > 0 && <div><span>Tax{i.prices_include_tax ? ' (included)' : ''}</span><span>{rupees(i.tax_paise)}</span></div>}
          <div className="grand"><span>Total</span><span data-invoice-total>{rupees(i.total_paise)}</span></div>
        </div>
      </article>
    </>
  );
}
