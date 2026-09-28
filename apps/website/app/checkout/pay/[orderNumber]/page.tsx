import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { DomainError, NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { getCustomerOrder, preparePayment } from '@kitsyuu/core';
import PaymentStep from '@/components/PaymentStep';
import { OrderItems, OrderSums } from '@/components/OrderSummary';
import { Crumbs } from '@/components/ui';
import { paymentProvider } from '@/lib/commerce';
import { db, requireCustomer } from '@/lib/server';
import { formatDateTime, rupees } from '@/lib/account-format';

/* Pay for an order (M7): starts or resumes a payment session with the configured provider and shows its widget. */
export const metadata: Metadata = { title: 'Payment', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function PayPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const orderNumber = decodeURIComponent((await params).orderNumber);
  const parsed = orderNumberInput.safeParse({ orderNumber });
  if (!parsed.success) notFound();
  const me = await requireCustomer(`/checkout/pay/${encodeURIComponent(orderNumber)}`);
  const o = await getCustomerOrder(db(), me, parsed.data.orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const orderLink = `/account/orders/${encodeURIComponent(o.orderNumber)}`;
  if (!o.canPay) redirect(o.paymentStatus === 'paid' ? `/checkout/complete/${encodeURIComponent(o.orderNumber)}` : orderLink);
  const provider = paymentProvider();

  let start: Awaited<ReturnType<typeof preparePayment>> | null = null, problem = '';
  if (!provider) problem = 'Online payment is not set up yet. Your order is saved.';
  else {
    try { start = await preparePayment(db(), provider, me, o.orderNumber); }
    catch (e) { if (e instanceof DomainError) problem = e.message; else throw e; }
  }
  return (
    <div className="st-wrap">
      <Crumbs list={[{ label: 'Store', href: '/' }, { label: 'Checkout' }, { label: 'Payment' }]} />
      <header className="st-plp-head">
        <h1 id="st-page-title" tabIndex={-1}>Payment</h1>
        <div className="st-plp-aside"><p className="st-result-count">Order {o.orderNumber}</p>
          <p>{rupees(o.totalPaise)}{o.paymentExpiresAt && <> · items held until {formatDateTime(o.paymentExpiresAt)}</>}</p></div>
      </header>
      <div className="st-cart st-checkout-layout">
        <div>
          {start ? <PaymentStep orderNumber={o.orderNumber} provider={start.provider} label={start.label} amountLabel={rupees(start.amountPaise)} client={start.client} />
            : <div className="st-form-alert" role="alert" data-payment-unavailable><p>{problem}</p><p><Link className="text-link" href={orderLink}>View your order</Link></p></div>}
        </div>
        <aside className="st-summary" aria-labelledby="st-summary-title">
          <h2 id="st-summary-title">Order summary</h2>
          <OrderItems o={o} />
          <OrderSums o={o} />
        </aside>
      </div>
    </div>
  );
}
