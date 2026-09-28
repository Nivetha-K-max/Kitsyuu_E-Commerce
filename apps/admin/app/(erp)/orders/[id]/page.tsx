import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, paiseToRupees, uuid } from '@kitsyuu/contracts';
import { getOrder } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import OrderStatusForm from '@/components/OrderStatusForm';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, STATUS_LABEL } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { setPackingStateAction, updateOrderStatusAction, updateShipmentTrackingAction } from '../actions';

export const metadata: Metadata = { title: 'Order' };
type Params = Promise<{ id: string }>;
const rupees = (p: number) => `₹${paiseToRupees(p)}`;
const label = (s: string | null) => (s ? STATUS_LABEL[s] ?? s : '—');
/** How a cancelled order stands with money (M8): no money, money received (exception), or money received and refunded by hand. */
const CANCELLED_MONEY: Record<string, [string, string]> = {
  cancelled_unpaid: ['Cancelled · unpaid', 'No money was received for this order.'],
  cancelled_payment_exception: ['Cancelled · payment exception', 'Money was received after the order was cancelled. Record the manual refund on the Payments page.'],
  cancelled_paid_refund_recorded: ['Cancelled · paid, manual refund recorded', 'Money was received after cancellation; a manual refund has been recorded.'],
};
const PACKING_OPTIONS = [{ value: 'not_started', label: 'Not started' }, { value: 'packing', label: 'Packing' }, { value: 'packed', label: 'Packed' }];

export default async function OrderPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/orders', label: 'Orders' }];
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Order" crumbs={crumbs} /><Forbidden permission="orders.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const d = await getOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const { order: o } = d;
  const intact = d.integrity.linesMatchUnitPrices && d.integrity.linesMatchSubtotal && d.integrity.totalCoversSubtotal;
  const address = [d.shipping.name, d.shipping.line1, d.shipping.line2, [d.shipping.city, d.shipping.state, d.shipping.pin].filter(Boolean).join(', '), d.shipping.country].filter(Boolean);

  return (
    <>
      <PageHead section="Commerce" title={`Order ${o.orderNumber}`} eyebrow={`Placed ${formatDateTime(o.createdAt)} · ${o.currency}`} crumbs={crumbs}>
        <span className="head-status" data-order-status={o.status}><span className="head-status-label">Order</span><StatusBadge status={o.status} /></span>
        {o.paymentStatus && <span className="head-status" data-payment-status={o.paymentStatus}><span className="head-status-label">Payment</span><StatusBadge status={o.paymentStatus} /></span>}
        {d.payment && d.payment.exceptions.some(e => !e.manualRefund) && <span className="head-status" data-payment-exception>
          <span className="head-status-label">Exception</span><StatusBadge status={d.payment.exceptions.find(e => !e.manualRefund)!.kind} /></span>}
      </PageHead>
      {d.payment?.cancelled && <p className={`msg ${d.payment.cancelled.kind === 'cancelled_payment_exception' ? 'error' : 'ok'}`} data-cancelled-money={d.payment.cancelled.kind}>
        <b>{CANCELLED_MONEY[d.payment.cancelled.kind][0]}.</b> {CANCELLED_MONEY[d.payment.cancelled.kind][1]}</p>}

      <div className="grid two">
        <section className="card" aria-labelledby="items-h" data-section="items">
          <h2 id="items-h">Order items</h2>
          <div className="table-wrap"><table data-items-table>
            <thead><tr><th><span className="sr-only">Image</span></th><th>Item</th><th>Size</th><th className="num">Unit price</th><th className="num">Qty</th><th className="num">Line total</th></tr></thead>
            <tbody>{d.items.map(i => {
              const img = productImageUrl(i.image_path);
              return (
                <tr key={i.id} data-item={i.sku}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <td className="thumb">{img ? <img src={img} alt="" width={44} height={56} loading="lazy" /> : null}</td>
                  <td>{i.product_id && can(actor, 'products.read') ? <Link href={`/products/${i.product_id}`}>{i.name}</Link> : i.name}
                    <div className="note mono">{i.sku}</div>{i.product_status && i.product_status !== 'active' && <StatusBadge status={i.product_status} />}</td>
                  <td>{i.size}</td>
                  <td className="num">{rupees(i.unit_price_paise)}</td>
                  <td className="num" data-qty>{i.qty}</td>
                  <td className="num">{rupees(i.line_total_paise)}</td>
                </tr>
              );
            })}</tbody>
            <tfoot>
              <tr><th colSpan={5} className="num">Subtotal</th><td className="num" data-subtotal>{rupees(o.subtotalPaise)}</td></tr>
              <tr><th colSpan={5} className="num">Total (tax-inclusive)</th><td className="num" data-order-total><b>{rupees(o.totalPaise)}</b></td></tr>
            </tfoot>
          </table></div>
          <p className="note" data-integrity={intact ? 'ok' : 'mismatch'}>
            {intact ? 'Amounts are the prices paid at checkout and cannot be edited.' : 'Warning: the recorded line totals do not add up. Amounts are shown exactly as recorded and were not changed.'}
          </p>
        </section>

        <section className="card" aria-labelledby="st-h" data-section="status">
          <h2 id="st-h">Status &amp; actions</h2>
          <dl className="facts">
            <dt>Order</dt><dd>{label(o.status)}</dd>
            <dt>Payment</dt><dd>{label(o.paymentStatus)}</dd>
            <dt>Paid at</dt><dd>{formatDateTime(o.paidAt)}</dd>
            <dt>Last change</dt><dd>{formatDateTime(o.updatedAt)}</dd>
          </dl>
          <div className="status-actions">
            {!can(actor, 'orders.update_status') ? <p className="note" data-readonly="status">Changing the status needs the orders.update_status permission.</p>
              : <OrderStatusForm action={updateOrderStatusAction} orderId={o.id} orderNumber={o.orderNumber} current={o.status} currentLabel={label(o.status)} allowed={d.allowedTransitions} carriers={d.carriers} />}
          </div>
          <h3 className="sub">Status history</h3>
          {d.history.length === 0 ? <p className="empty">No status changes recorded.</p> : (
            <ol className="timeline" data-history>
              {d.history.map(h => (
                <li key={h.id} data-history-row={h.to_status}>
                  <b>{h.from_status ? `${label(h.from_status)} → ` : ''}{label(h.to_status)}</b>
                  <span className="note"> · {formatDateTime(h.created_at)} · {h.staff_email ?? (h.by_customer ? 'customer' : 'system')}</span>
                  {h.note && <div className="note">“{h.note}”</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="cust-h" data-section="customer">
          <h2 id="cust-h">Customer &amp; shipping</h2>
          <dl className="facts">
            <dt>Name</dt><dd>{d.contact.name ?? '—'}</dd>
            <dt>Email</dt><dd>{d.contact.email ?? '—'}</dd>
            <dt>Phone</dt><dd>{d.contact.phone ?? '—'}</dd>
            <dt>Ship to</dt><dd>{address.length ? address.map((l, i) => <div key={i}>{l}</div>) : '—'}</dd>
            <dt>Account</dt><dd data-customer-account>{d.customer === undefined ? <span className="note">needs customers.read</span>
              : d.customer ? <><Link href={`/customers/${d.customer.id}`} data-customer-link>{d.customer.email}</Link> <StatusBadge status={d.customer.status} /></>
              : <span className="note">no account record</span>}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="bill-h" data-section="billing">
          <h2 id="bill-h">Payment &amp; invoices</h2>
          {!d.billing ? <p className="note" data-readonly="billing">Payments and invoices need the billing.read permission.</p> : (
            <>
              <h3 className="sub">Payments</h3>
              {d.billing.payments.length === 0 ? <p className="empty">No payment recorded.</p> : (
                <div className="table-wrap"><table data-payments-table>
                  <thead><tr><th>Provider</th><th>Reference</th><th className="num">Amount</th><th>Status</th><th>Captured</th></tr></thead>
                  <tbody>{d.billing.payments.map(p => (
                    <tr key={p.id}><td>{p.provider}{p.method && <div className="note">{p.method}</div>}</td><td className="mono">{p.provider_payment_id ?? '—'}</td>
                      <td className="num">{rupees(p.amount_paise)}</td><td><StatusBadge status={p.status} />{p.failure_reason && <div className="note">{p.failure_reason}</div>}</td>
                      <td>{formatDateTime(p.captured_at)}</td></tr>))}
                  </tbody></table></div>
              )}
              <h3 className="sub">Invoices</h3>
              {d.billing.invoices.length === 0 ? <p className="empty">No invoice.</p> : (
                <ul className="plain" data-invoices>{d.billing.invoices.map(i => (
                  <li key={i.id}><span className="mono">{i.invoice_number ?? 'draft'}</span> <StatusBadge status={i.status} /> {rupees(i.total_paise)}
                    <span className="note"> · {i.prices_include_tax ? 'tax-inclusive' : 'tax added'} · tax {rupees(i.tax_paise)} · {formatDateTime(i.issued_at)}</span></li>))}
                </ul>
              )}
              {d.payment && d.payment.exceptions.length > 0 && (<><h3 className="sub">Payment exceptions</h3>
                <ul className="plain" data-order-exceptions>{d.payment.exceptions.map((e, i) => (
                  <li key={i}><StatusBadge status={e.kind} /> {e.providerPaymentId && <span className="mono">{e.providerPaymentId}</span>}
                    <span className="note"> · {e.manualRefund ? 'manual refund recorded' : 'open'}</span></li>))}
                </ul>
                <p className="note"><Link href="/payments?view=exceptions">Open the exceptions queue</Link></p></>)}
              {d.billing.refunds.length > 0 && (<><h3 className="sub">Manual refunds</h3>
                <ul className="plain">{d.billing.refunds.map(r => <li key={r.id}>{rupees(r.amount_paise)} <StatusBadge status={r.status} /> <span className="note">{r.reason}</span></li>)}</ul></>)}
            </>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="ful-h" data-section="fulfilment">
        <h2 id="ful-h">Fulfilment</h2>
        <dl className="facts" data-fulfilment>
          <dt>Stage</dt><dd>{['paid', 'processing', 'shipped', 'delivered'].includes(o.status) ? <StatusBadge status={o.status} /> : <span className="note">Not in fulfilment ({label(o.status).toLowerCase()})</span>}</dd>
          <dt>Packing</dt><dd data-packing-state>{d.shipment ? <StatusBadge status={d.shipment.packingState} /> : <span className="note">Not started</span>}</dd>
          <dt>Courier</dt><dd data-courier>{d.shipment?.shippedAt ? d.shipment.carrierLabel : '—'}</dd>
          <dt>Tracking</dt><dd data-tracking>{d.shipment?.trackingNumber
            ? (d.shipment.trackingUrl ? <a href={d.shipment.trackingUrl} rel="noopener noreferrer" target="_blank" className="mono">{d.shipment.trackingNumber}</a> : <span className="mono">{d.shipment.trackingNumber}</span>)
            : d.shipment?.shippedAt ? <span className="note">Tracking not provided</span> : '—'}</dd>
          <dt>Shipped</dt><dd data-shipped-at>{formatDateTime(d.shipment?.shippedAt)}</dd>
          <dt>Delivered</dt><dd data-delivered-at>{formatDateTime(d.shipment?.deliveredAt)}</dd>
        </dl>
        <p className="note">Couriers are booked by hand; no courier service is connected. Shipped and delivered are set with the order status above.</p>
        {can(actor, 'orders.update_status') && o.status === 'processing' && (
          <ActionForm action={setPackingStateAction} submitLabel="Save packing" pendingLabel="Saving…" id="packing-form" label="Packing progress" className="form inline">
            <Hidden name="orderId" value={o.id} />
            <Select name="packingState" label="Packing" options={PACKING_OPTIONS} defaultValue={d.shipment?.packingState ?? 'not_started'} />
          </ActionForm>
        )}
        {can(actor, 'orders.update_status') && (o.status === 'shipped' || o.status === 'delivered') && (
          <ActionForm action={updateShipmentTrackingAction} submitLabel="Save tracking" pendingLabel="Saving…" id="tracking-form" label="Courier and tracking" className="form inline">
            <Hidden name="orderId" value={o.id} />
            <Select name="carrierCode" label="Courier" options={d.carriers.map(c => ({ value: c.code, label: c.label }))} defaultValue={d.shipment?.carrierCode ?? d.carriers[0]?.code} />
            <Field name="trackingNumber" label="Tracking number" defaultValue={d.shipment?.trackingNumber ?? ''} hint="Optional. Leave empty if the courier gave none." />
          </ActionForm>
        )}
      </section>

      {d.stock && (
        <section className="card" aria-labelledby="stk-h" data-section="stock">
          <h2 id="stk-h">Stock effect</h2>
          {d.stock.length === 0 ? <p className="empty">This order has not moved any stock.</p> : (
            <div className="table-wrap"><table data-order-stock>
              <thead><tr><th>When</th><th>SKU</th><th className="num">Change</th><th>Reason</th><th className="num">Balance after</th><th>By</th></tr></thead>
              <tbody>{d.stock.map((m, i) => (
                <tr key={i}><td>{formatDateTime(m.created_at)}</td><td className="mono">{m.sku}</td><td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td>{m.reason}</td><td className="num">{m.balance_after ?? '—'}</td><td>{m.staff_email ?? <span className="note">system</span>}</td></tr>))}
              </tbody></table></div>
          )}
        </section>
      )}
    </>
  );
}
