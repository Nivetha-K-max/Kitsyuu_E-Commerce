import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { customerReturnOptions, getCustomerOrder } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import { OrderItems, OrderSums } from '@/components/OrderSummary';
import { CancelOrderButton } from '@/components/AccountForms';
import { paymentProvider } from '@/lib/commerce';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, formatDateTime, NEXT_STEP, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, rupees } from '@/lib/account-format';
import { RETURN_STATUS_LABEL } from '@/lib/erp-format';

export const metadata: Metadata = { title: 'Order' };
const IN_STORE: Record<string, string> = { cash: 'Cash in store', card: 'Card in store', upi: 'UPI in store' };
/* Delivery steps the customer follows (packing is part of processing; it shows once staff mark the parcel packed). */
const STEPS = [['processing', 'Processing'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['delivered', 'Delivered']] as const;
const SHIPMENT_LABEL: Record<string, string> = { shipped: 'Shipped', in_transit: 'On the way', delivered: 'Delivered', failed_delivery: 'Delivery attempt failed', cancelled: 'Cancelled', packed: 'Packed', processing: 'Processing', pending: 'Pending' };
type Params = Promise<{ orderNumber: string }>;

export default async function OrderPage({ params }: { params: Params }) {
  const { orderNumber: raw } = await params;
  const orderNumber = decodeURIComponent(raw);
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(orderNumber)}`);
  const parsed = orderNumberInput.safeParse({ orderNumber });
  if (!parsed.success) notFound();
  // Another customer's order number behaves exactly like one that does not exist.
  const o = await getCustomerOrder(db(), me, parsed.data.orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const s = o.shipping;
  const canPay = o.canPay && !!paymentProvider();
  // ERP module 3: a return can be requested only while the business has returns switched on (off by default).
  const returns = await customerReturnOptions(db(), me, o.orderNumber).catch(() => null);
  const sh = o.shipment;
  const reached = o.status === 'delivered' ? 3 : o.status === 'shipped' ? 2 : sh?.packingState === 'packed' ? 1 : o.status === 'processing' || o.status === 'paid' ? 0 : -1;
  return (
    <>
      <Crumbs list={[{ label: 'Orders', href: '/account/orders' }, { label: o.orderNumber }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title" className="st-order-title">Order {o.orderNumber}</h1>
        <div className="st-plp-aside"><p className="st-result-count" data-order-status={o.status}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</p><p>Placed {formatDateTime(o.createdAt)}.</p></div>
      </header>
      <p className="st-order-next" role="status">{NEXT_STEP[o.status]}{o.paymentExpiresAt && <> Items are held until {formatDateTime(o.paymentExpiresAt)}.</>}</p>
      {(canPay || o.canCancel) && (
        <div className="st-order-actions">
          {canPay && <Link className="button" href={`/checkout/pay/${encodeURIComponent(o.orderNumber)}`} data-pay-order>Pay {rupees(o.totalPaise)}</Link>}
          {o.canCancel && <CancelOrderButton orderNumber={o.orderNumber} />}
        </div>
      )}

      <section className="st-form-group" aria-labelledby="st-ord-items">
        <h2 id="st-ord-items">Items</h2>
        <OrderItems o={o} />
        <OrderSums o={o} />
      </section>

      <div className="st-order-columns">
        <section className="st-form-group" aria-labelledby="st-ord-pay">
          <h2 id="st-ord-pay">Payment</h2>
          <dl className="st-account-dl">
            <dt>Status</dt><dd data-payment-status={o.paymentStatus ?? 'none'}>{o.paymentStatus ? PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus : 'Not started'}</dd>
            {IN_STORE[o.paymentMethod] && <><dt>Method</dt><dd data-payment-method={o.paymentMethod}>{IN_STORE[o.paymentMethod]}{o.branch ? ` · ${o.branch}` : ''}</dd></>}
            {o.paymentMethod === 'cod' && <><dt>Method</dt><dd data-payment-method="cod">Cash on delivery{o.codStatus === 'to_collect' && o.status !== 'cancelled' ? ` · pay ${rupees(o.totalPaise)} when it arrives` : o.codStatus === 'collected' ? ' · paid' : ''}</dd></>}
            {o.pointsUsed > 0 && <><dt>Points used</dt><dd>{o.pointsUsed} ({rupees(o.pointsDiscountPaise)} off)</dd></>}
            <dt>Paid on</dt><dd>{formatDate(o.paidAt)}</dd>
          </dl>
          {o.staffDiscount && <p className="st-note" data-order-staff-discount>Includes a discount of {rupees(o.staffDiscount.amountPaise)} from our team{o.staffDiscount.reason ? `: ${o.staffDiscount.reason}` : ''}.</p>}
          {o.invoice && <p><Link className="text-link" href={`/account/orders/${encodeURIComponent(o.orderNumber)}/invoice`} data-order-invoice>View / print invoice {o.invoice.number}</Link></p>}
        </section>
        <section className="st-form-group" aria-labelledby="st-ord-ship">
          <h2 id="st-ord-ship">{o.channel === 'retail' ? 'Bought in store' : 'Delivery'}</h2>
          {o.channel === 'retail' ? <p data-order-branch>Collected at {o.branch ?? 'our store'}.</p> : s.line1 ? <address className="st-address-text">{s.name}<br />{s.line1}{s.line2 && <><br />{s.line2}</>}<br />{[s.city, s.state, s.pin].filter(Boolean).join(', ')}{s.country && <><br />{s.country}</>}{s.phone && <><br />{s.phone}</>}</address>
            : <p>Delivery details will appear here.</p>}
          {o.billing && <p className="st-note" data-order-billing>Billing address: {[o.billing.name, o.billing.line1, o.billing.line2, o.billing.city, o.billing.state, o.billing.pin].filter(Boolean).join(', ')}</p>}
        </section>
      </div>

      {o.channel === 'online' && reached >= 0 && o.status !== 'cancelled' && (
        <section className="st-form-group" aria-labelledby="st-ord-track" data-order-tracking>
          <h2 id="st-ord-track">Tracking</h2>
          <ol className="st-track-steps">{STEPS.map(([k, label], n) => <li key={k} data-step={k} data-done={n <= reached || undefined} aria-current={n === reached ? 'step' : undefined}>{label}</li>)}</ol>
          {sh && (sh.trackingNumber || sh.carrier) ? (
            <dl className="st-account-dl">
              {sh.carrier && <><dt>Courier</dt><dd data-tracking-carrier>{sh.carrier}</dd></>}
              {sh.trackingNumber && <><dt>Tracking number</dt><dd data-tracking-number>{sh.trackingNumber}</dd></>}
              {sh.shippedAt && <><dt>Shipped</dt><dd>{formatDateTime(sh.shippedAt)}</dd></>}
              <dt>Status</dt><dd data-tracking-status={sh.status}>{SHIPMENT_LABEL[sh.status] ?? sh.status}</dd>
            </dl>
          ) : <p className="st-note">{o.status === 'shipped' ? 'Your parcel is on its way; the courier details will appear here.' : 'Tracking details appear here once your order ships.'}</p>}
          {sh?.trackingUrl && <p><a className="button button-outline" href={sh.trackingUrl} target="_blank" rel="noopener noreferrer" data-tracking-link>Track with the courier <span aria-hidden="true">↗</span></a></p>}
          {sh && sh.events.length > 0 && <ol className="st-order-timeline" data-tracking-events>{sh.events.map((e, n) => <li key={n}><span>{SHIPMENT_LABEL[e.status] ?? e.status}{e.note ? ` · ${e.note}` : ''}</span><time dateTime={new Date(e.at).toISOString()}>{formatDateTime(e.at)}</time></li>)}</ol>}
        </section>
      )}
      {o.history.length > 0 && (
        <section className="st-form-group" aria-labelledby="st-ord-history">
          <h2 id="st-ord-history">Progress</h2>
          <ol className="st-order-timeline">{o.history.map((h, n) => <li key={n}><span>{ORDER_STATUS_LABEL[h.status] ?? h.status}</span><time dateTime={new Date(h.at).toISOString()}>{formatDateTime(h.at)}</time></li>)}</ol>
        </section>
      )}
      {returns && (returns.allowed || returns.requests.length > 0) && (
        <section className="st-form-group" aria-labelledby="st-ord-returns" data-order-returns>
          <h2 id="st-ord-returns">Returns</h2>
          {returns.requests.map(r => <p key={r.number}><Link className="text-link" href={`/account/returns/${r.number}`}>{r.number}</Link> · {RETURN_STATUS_LABEL[r.status] ?? r.status}</p>)}
          {returns.allowed && <p><Link className="button button-outline" href={`/account/orders/${encodeURIComponent(o.orderNumber)}/return`} data-request-return>Request a return</Link></p>}
        </section>
      )}
      <p className="st-account-more"><Link className="text-link" href={`/account/support/new?order=${encodeURIComponent(o.orderNumber)}`} data-order-help>Get help with this order</Link></p>
      <p className="st-account-more"><Link className="text-link" href="/account/orders">Back to orders <span aria-hidden="true">↗</span></Link></p>
    </>
  );
}
