import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { getCustomerOrder } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, formatDateTime, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, productImageUrl, rupees } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Order' };
type Params = Promise<{ orderNumber: string }>;

const NEXT_STEP: Record<string, string> = {
  pending_payment: 'We are waiting for your payment to be confirmed.',
  paid: 'Your order is confirmed. We will let you know when it ships.',
  processing: 'Your order is being packed.',
  shipped: 'Your order is on its way.',
  delivered: 'Your order has been delivered.',
  cancelled: 'This order was cancelled. Any payment taken is refunded to the original payment method.',
  payment_failed: 'The payment did not go through, so nothing was charged for this order.',
  refunded: 'This order has been refunded to the original payment method.',
};

export default async function OrderPage({ params }: { params: Params }) {
  const { orderNumber: raw } = await params;
  const orderNumber = decodeURIComponent(raw);
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(orderNumber)}`);
  const parsed = orderNumberInput.safeParse({ orderNumber });
  if (!parsed.success) notFound();
  // Another customer's order number behaves exactly like one that does not exist.
  const o = await getCustomerOrder(db(), me, parsed.data.orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const s = o.shipping;
  const discountPaise = Math.max(0, o.subtotalPaise - o.totalPaise);
  return (
    <>
      <Crumbs list={[{ label: 'Orders', href: '/account/orders' }, { label: o.orderNumber }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title" className="st-order-title">Order {o.orderNumber}</h1>
        <div className="st-plp-aside"><p className="st-result-count" data-order-status={o.status}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</p><p>Placed {formatDateTime(o.createdAt)}.</p></div>
      </header>
      <p className="st-order-next" role="status">{NEXT_STEP[o.status]}</p>

      <section className="st-form-group" aria-labelledby="st-ord-items">
        <h2 id="st-ord-items">Items</h2>
        <ul className="st-order-items">
          {o.items.map(i => {
            const img = productImageUrl(i.imagePath);
            return (
              <li key={`${i.sku}`} className="st-order-item">
                {img ? <img src={img} alt="" width={64} height={80} loading="lazy" /> : <span className="st-order-noimg" aria-hidden="true" />}
                <div><p className="st-order-item-name">{i.name}</p><p className="st-order-item-meta">Size {i.size} · {i.qty} × {rupees(i.unitPricePaise)}</p></div>
                <p className="st-order-item-total">{rupees(i.lineTotalPaise)}</p>
              </li>
            );
          })}
        </ul>
        <dl className="st-order-sums">
          <dt>Subtotal</dt><dd data-subtotal>{rupees(o.subtotalPaise)}</dd>
          {discountPaise > 0 && <><dt>Discount</dt><dd>−{rupees(discountPaise)}</dd></>}
          <dt>Taxes</dt><dd>Included in the prices</dd>
          <dt className="st-order-grand">Total</dt><dd className="st-order-grand" data-total>{rupees(o.totalPaise)}</dd>
        </dl>
      </section>

      <div className="st-order-columns">
        <section className="st-form-group" aria-labelledby="st-ord-pay">
          <h2 id="st-ord-pay">Payment</h2>
          <dl className="st-account-dl">
            <dt>Status</dt><dd data-payment-status={o.paymentStatus ?? 'none'}>{o.paymentStatus ? PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus : 'Not started'}</dd>
            <dt>Paid on</dt><dd>{formatDate(o.paidAt)}</dd>
          </dl>
        </section>
        <section className="st-form-group" aria-labelledby="st-ord-ship">
          <h2 id="st-ord-ship">Delivery</h2>
          {s.line1 ? <address className="st-address-text">{s.name}<br />{s.line1}{s.line2 && <><br />{s.line2}</>}<br />{[s.city, s.state, s.pin].filter(Boolean).join(', ')}{s.country && <><br />{s.country}</>}{s.phone && <><br />{s.phone}</>}</address>
            : <p>Delivery details will appear here.</p>}
        </section>
      </div>

      {o.history.length > 0 && (
        <section className="st-form-group" aria-labelledby="st-ord-history">
          <h2 id="st-ord-history">Progress</h2>
          <ol className="st-order-timeline">{o.history.map((h, n) => <li key={n}><span>{ORDER_STATUS_LABEL[h.status] ?? h.status}</span><time dateTime={new Date(h.at).toISOString()}>{formatDateTime(h.at)}</time></li>)}</ol>
        </section>
      )}
      <p className="st-account-more"><Link className="text-link" href="/account/orders">Back to orders <span aria-hidden="true">↗</span></Link></p>
    </>
  );
}
