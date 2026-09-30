import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { getCustomerOrder } from '@kitsyuu/core';
import { OrderItems, OrderSums } from '@/components/OrderSummary';
import { Crumbs } from '@/components/ui';
import { db, requireCustomer } from '@/lib/server';
import { formatDateTime, NEXT_STEP, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@/lib/account-format';

/* Order confirmation (M7): what was ordered, its payment status, who it goes to, and what happens next.
   Only the customer's own order; the status shown is the one the server recorded (never what the browser reported). */
export const metadata: Metadata = { title: 'Order confirmation', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function CompletePage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const orderNumber = decodeURIComponent((await params).orderNumber);
  const parsed = orderNumberInput.safeParse({ orderNumber });
  if (!parsed.success) notFound();
  const me = await requireCustomer(`/checkout/complete/${encodeURIComponent(orderNumber)}`);
  const o = await getCustomerOrder(db(), me, parsed.data.orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  // Paid online, or a cash-on-delivery order confirmed for delivery (second pass).
  const codOpen = o.paymentMethod === 'cod' && o.codStatus === 'to_collect' && o.status !== 'cancelled';
  const paid = (o.paymentStatus === 'paid' && o.status !== 'cancelled') || codOpen;
  const s = o.shipping, c = o.contact;
  const link = `/account/orders/${encodeURIComponent(o.orderNumber)}`;
  return (
    <div className="st-wrap">
      <Crumbs list={[{ label: 'Home', href: '/' }, { label: 'Order confirmation' }]} />
      <section className="st-confirm" aria-labelledby="st-page-title">
        <p className="eyebrow"><span></span>{paid ? 'ORDER CONFIRMED' : (ORDER_STATUS_LABEL[o.status] ?? o.status).toUpperCase()}</p>
        <h1 id="st-page-title" tabIndex={-1}>{paid ? <>Thank you.<br /><em>Your order is placed.</em></> : <>Order<br /><em>{ORDER_STATUS_LABEL[o.status] ?? o.status}.</em></>}</h1>
        <p className="st-confirm-lead" data-next-step>{NEXT_STEP[o.status]}</p>
        <dl className="st-confirm-ref">
          <dt>Order number</dt><dd data-order-number>{o.orderNumber}</dd>
          <dt>Payment</dt><dd data-payment-status={o.paymentStatus ?? 'none'}>{codOpen ? 'Cash on delivery' : o.paymentStatus ? PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus : 'Not started'}{o.paidAt && <> · {formatDateTime(o.paidAt)}</>}</dd>
        </dl>
        {!paid && o.canPay && <p><Link className="button" href={`/checkout/pay/${encodeURIComponent(o.orderNumber)}`}>Pay now</Link></p>}
      </section>
      <div className="st-cart st-checkout-layout">
        <div className="st-confirm-details">
          <section className="st-form-group"><h2>Contact</h2><p>{c.name}{c.email && <><br />{c.email}</>}{c.phone && <><br />{c.phone}</>}</p></section>
          <section className="st-form-group"><h2>Deliver to</h2>
            <address className="st-address-text">{s.name}<br />{s.line1}{s.line2 && <><br />{s.line2}</>}<br />{[s.city, s.state, s.pin].filter(Boolean).join(', ')}{s.country && <><br />{s.country}</>}</address>
          </section>
          <p><Link className="button" href={link}>View order</Link> <Link className="button button-outline" href="/shop">Continue shopping</Link></p>
        </div>
        <aside className="st-summary" aria-labelledby="st-summary-title">
          <h2 id="st-summary-title">Items</h2>
          <OrderItems o={o} />
          <OrderSums o={o} />
        </aside>
      </div>
    </div>
  );
}
