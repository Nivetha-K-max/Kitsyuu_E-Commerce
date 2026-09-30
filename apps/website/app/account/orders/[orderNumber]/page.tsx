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
            {o.paymentMethod === 'cod' && <><dt>Method</dt><dd data-payment-method="cod">Cash on delivery{o.codStatus === 'to_collect' && o.status !== 'cancelled' ? ` · pay ${rupees(o.totalPaise)} when it arrives` : o.codStatus === 'collected' ? ' · paid' : ''}</dd></>}
            {o.pointsUsed > 0 && <><dt>Points used</dt><dd>{o.pointsUsed} ({rupees(o.pointsDiscountPaise)} off)</dd></>}
            <dt>Paid on</dt><dd>{formatDate(o.paidAt)}</dd>
          </dl>
        </section>
        <section className="st-form-group" aria-labelledby="st-ord-ship">
          <h2 id="st-ord-ship">Delivery</h2>
          {s.line1 ? <address className="st-address-text">{s.name}<br />{s.line1}{s.line2 && <><br />{s.line2}</>}<br />{[s.city, s.state, s.pin].filter(Boolean).join(', ')}{s.country && <><br />{s.country}</>}{s.phone && <><br />{s.phone}</>}</address>
            : <p>Delivery details will appear here.</p>}
          {o.billing && <p className="st-note" data-order-billing>Billing address: {[o.billing.name, o.billing.line1, o.billing.line2, o.billing.city, o.billing.state, o.billing.pin].filter(Boolean).join(', ')}</p>}
        </section>
      </div>

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
