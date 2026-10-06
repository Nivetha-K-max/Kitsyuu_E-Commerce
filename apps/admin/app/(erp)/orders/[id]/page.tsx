import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, paiseToRupees, uuid } from '@kitsyuu/contracts';
import { getOrder, listOrderEdits, orderCodState, orderEditOptions, orderEmails, orderOrigin, pricingView, settingsShipping } from '@kitsyuu/core';
import { INDIAN_STATES } from '@kitsyuu/contracts';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import OrderStatusForm from '@/components/OrderStatusForm';
import { NavFrame, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { codCancelAction, codCollectAction, editOrderAction, refundOrderEditAction, setPackingStateAction, updateOrderStatusAction, updateShipmentTrackingAction } from '../actions';
import { refundProvider } from '@/lib/payments';
import { flowIndex, ORDER_FLOW, orderStage, StagePill } from '../order-ui';
import { METHOD_LONG, PaymentPill, providerLabel } from '../../payments/payment-ui';
import { createInvoiceAction } from '../../finance/actions';

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
type EditSnap = { lines: { sku: string; name: string; size: string; qty: number }[]; address: Record<string, unknown> | null;
  contact?: { name?: string | null; email?: string | null; phone?: string | null }; delivery?: string | null; staffDiscountBp?: number | null };
/** One line per change: sizes and quantities, removed lines, and a new address. */
function describeEdit(b: EditSnap, a: EditSnap): string {
  const out: string[] = [];
  for (const l of b.lines) {
    const n = a.lines.find(x => x.name === l.name);
    if (!n) out.push(`${l.name} (${l.size} × ${l.qty}) removed`);
    else if (n.size !== l.size || n.qty !== l.qty) out.push(`${l.name}: ${l.size} × ${l.qty} → ${n.size} × ${n.qty}`);
  }
  for (const n of a.lines) if (!b.lines.some(x => x.name === n.name)) out.push(`${n.name} (${n.size} × ${n.qty}) added`);
  const who = (c?: EditSnap['contact']) => [c?.name, c?.email, c?.phone].filter(Boolean).join(', ');
  if (a.contact && who(b.contact) !== who(a.contact)) out.push(`contact → ${who(a.contact)}`);
  if (a.delivery !== undefined && a.delivery !== b.delivery) out.push(`delivery → ${a.delivery ?? '—'}`);
  if (a.staffDiscountBp !== undefined && (a.staffDiscountBp ?? 0) !== (b.staffDiscountBp ?? 0)) out.push(a.staffDiscountBp ? `staff discount → ${a.staffDiscountBp / 100}%` : 'staff discount removed');
  const addr = (x: Record<string, unknown> | null) => [x?.line1, x?.city, x?.pin].filter(Boolean).join(', ');
  if (addr(b.address) !== addr(a.address)) out.push(`delivery address → ${addr(a.address)}`);
  return out.join(' · ') || 'No line changes';
}
/** A status in the order history, in the stage words of the Orders screens. */
const stageName = (s: string) => (s === 'pending_payment' ? 'Placed' : s === 'payment_failed' ? 'Payment failed' : orderStage(s).label);
const PACKING_OPTIONS = [{ value: 'not_started', label: 'Not started' }, { value: 'packing', label: 'Packing' }, { value: 'packed', label: 'Packed' }];

export default async function OrderPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/orders', label: '← Back to orders' }];
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Order" crumbs={crumbs} /><Forbidden permission="orders.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const d = await getOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const { order: o } = d;
  const intact = d.integrity.linesMatchUnitPrices && d.integrity.linesMatchSubtotal && d.integrity.totalCoversSubtotal;
  const address = [d.shipping.name, d.shipping.line1, d.shipping.line2, [d.shipping.city, d.shipping.state, d.shipping.pin].filter(Boolean).join(', '), d.shipping.country].filter(Boolean);
  // Second pass: cash on delivery, order edits (before shipment) and their refunds.
  const [cod, edits, editing, origin, emails] = await Promise.all([orderCodState(db(), o.id), listOrderEdits(db(), o.id),
    can(actor, 'orders.edit') ? orderEditOptions(db(), actor, o.id, { shipping: settingsShipping(() => db()) }) : Promise.resolve(null), orderOrigin(db(), actor, o.id), orderEmails(db(), o.id)]);
  const canCod = can(actor, 'orders.cod');
  const provider = refundProvider();
  // Print invoice (client change request): the issued invoice made from this order's own data (Finance). Without one, staff
  // with finance.manage can issue it here for a paid order; the numbering and GST split are the Finance module's.
  const issued = d.billing?.invoices.find(i => i.status === 'issued') ?? null;
  const canIssue = !issued && can(actor, 'finance.manage') && ['paid', 'processing', 'shipped', 'delivered'].includes(o.status);

  // ---- where the order is, and what staff can do next (display only: the transitions are the server's) ----
  const canStatus = can(actor, 'orders.update_status');
  const allowed = d.allowedTransitions;
  const packing = d.shipment?.packingState ?? null;
  const st = orderStage(o.status, packing);
  const off = o.status === 'cancelled' || o.status === 'refunded';                 // no longer in the fulfilment flow
  const when = (status: string) => d.history.find(h => h.to_status === status)?.created_at ?? null;
  // A cancelled or refunded order shows the last stage it reached, from its own history.
  const reached = off ? Math.max(0, ...d.history.map(h => flowIndex(h.to_status))) : flowIndex(o.status, packing);
  const stepDates = [o.createdAt, o.paymentMethod === 'cod' ? null : o.paidAt ?? when('paid'), when('processing'), null,
    d.shipment?.shippedAt ?? when('shipped'), d.shipment?.deliveredAt ?? when('delivered')];
  const codDue = cod?.status === 'to_collect' && o.status !== 'cancelled';
  // The money is managed under Payments: this page shows a summary and links there. Staff without billing.read cannot open
  // Payments, so for them the one payment step an order needs (recording COD cash, orders.cod) stays on this page.
  const canBilling = !!d.billing;
  const paymentHref = `/payments/${o.id}`;
  const collectHref = canBilling ? `${paymentHref}#collect` : '#pay-h';
  const captured = d.billing?.payments.filter(p => ['captured', 'refunded', 'partially_refunded'].includes(p.status)) ?? [];
  const lastAttempt = d.billing?.payments.at(-1) ?? null;
  const refundedPaise = d.billing?.refunds.filter(r => r.status === 'processed').reduce((n, r) => n + r.amount_paise, 0) ?? 0;
  const refundsOpen = d.billing?.refunds.filter(r => r.status === 'requested' || r.status === 'pending').length ?? 0;
  // One timeline: the order's own status history, with the payment events of the same order (when permitted) in between.
  type Moment = { at: Date; key: string; row?: string; title: string; meta: string; note?: string | null; kind: 'order' | 'payment' };
  const moments: Moment[] = [
    ...d.history.map(h => ({ at: new Date(h.created_at), key: `h${h.id}`, row: h.to_status, kind: 'order' as const,
      title: `${h.from_status ? `${stageName(h.from_status)} → ` : ''}${stageName(h.to_status)}`, meta: h.staff_email ?? (h.by_customer ? 'customer' : 'system'), note: h.note })),
    ...(d.billing?.payments ?? []).flatMap((p): Moment[] => p.provider === 'cod'
      ? [{ at: new Date(p.captured_at ?? p.created_at), key: `p${p.id}`, kind: 'payment', title: `Cash collected · ${rupees(p.amount_paise)}`, meta: 'cash on delivery' }]
      : p.status === 'failed' ? [{ at: new Date(p.created_at), key: `p${p.id}`, kind: 'payment', title: `Payment attempt failed · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider), note: p.failure_reason }]
      : p.captured_at ? [{ at: new Date(p.captured_at), key: `p${p.id}`, kind: 'payment', title: `Payment received · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider) }]
      : [{ at: new Date(p.created_at), key: `p${p.id}`, kind: 'payment', title: `Payment started · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider) }]),
    ...(d.billing?.refunds ?? []).map((r): Moment => ({ at: new Date(r.processed_at ?? r.created_at), key: `r${r.id}`, kind: 'payment',
      title: `Refund ${r.status === 'processed' ? 'made' : r.status === 'failed' ? 'failed' : r.status === 'pending' ? 'sent to the provider' : 'recorded'} · ${rupees(r.amount_paise)}`, meta: 'refund', note: r.reason })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const quick = (to: 'processing' | 'delivered', text: string) => (
    <ActionForm action={updateOrderStatusAction} submitLabel={text} pendingLabel={to === 'processing' ? 'Starting…' : 'Marking delivered…'} id={`quick-${to}-form`} label={text} className="ord-quick"
      confirmText={`${text}: order ${o.orderNumber}?`}>
      <Hidden name="orderId" value={o.id} /><Hidden name="expectedStatus" value={o.status} /><Hidden name="toStatus" value={to} />
      <Hidden name="note" value="" />{/* the status form's note field: empty here (a note is only required when cancelling) */}
    </ActionForm>
  );
  const customerName = d.contact.name ?? d.contact.email ?? 'No customer details';
  const lines = (a: { name?: string | null; line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; pin?: string | null; country?: string | null }) =>
    [a.name, a.line1, a.line2, [a.city, a.state, a.pin].filter(Boolean).join(', '), a.country].filter(Boolean) as string[];

  return (
    <NavFrame className="ord ord-detail" data-order-screen>
      <PageHead section="Commerce" title={`Order ${o.orderNumber}`} eyebrow={`${customerName} · Placed ${formatDateTime(o.createdAt)} · ${o.currency}`} crumbs={crumbs}>
        <span className="head-status" data-order-status={o.status}><span className="head-status-label">Stage</span><StagePill status={o.status} packingState={packing} /></span>
        <span className="head-status" {...(o.paymentStatus ? { 'data-payment-status': o.paymentStatus } : {})} data-payment-method={o.paymentMethod ?? undefined}><span className="head-status-label">Payment</span>
          <PaymentPill method={o.paymentMethod} paymentStatus={o.paymentStatus} codStatus={cod?.status ?? null} orderStatus={o.status} note={false} /></span>
        {d.payment && d.payment.exceptions.some(e => !e.manualRefund) && <span className="head-status" data-payment-exception>
          <span className="head-status-label">Exception</span><StatusBadge status={d.payment.exceptions.find(e => !e.manualRefund)!.kind} /></span>}
        <Link className="btn ghost sm" href={`/orders/${o.id}/packing-slip`} data-link="packing-slip">Packing slip</Link>
        {editing && !editing.blocker && <a className="btn ghost sm" href="#edit-h" data-link="edit-order">Edit order</a>}
        {issued && can(actor, 'finance.read') && <Link className="btn ghost sm" href={`/finance/invoices/${issued.id}`} data-link="print-invoice">Print invoice</Link>}
      </PageHead>
      {d.payment?.cancelled && <p className={`msg ${d.payment.cancelled.kind === 'cancelled_payment_exception' ? 'error' : 'ok'}`} data-cancelled-money={d.payment.cancelled.kind}>
        <b>{CANCELLED_MONEY[d.payment.cancelled.kind][0]}.</b> {CANCELLED_MONEY[d.payment.cancelled.kind][1]}</p>}

      {/* The flow: Placed → Confirmed → Being packed → Packed → Shipped → Delivered (the real states, nothing added). */}
      <section className="card ord-flow" aria-label="Order progress" data-order-flow={st.code}>
        <ol className="ord-steps" data-off={off || undefined}>
          {ORDER_FLOW.map((name, i) => {
            const state = off ? (i <= reached ? 'done' : 'skipped') : o.status === 'delivered' || i < reached ? 'done' : i === reached ? 'current' : 'upcoming';
            const at = state === 'done' || state === 'current' ? stepDates[i] : null;
            return <li key={name} data-state={state} aria-current={state === 'current' ? 'step' : undefined}><b>{name}</b><small>{at ? formatDateTime(at) : state === 'current' ? st.note ?? 'now' : ' '}</small></li>;
          })}
          {off && <li data-state="stopped" aria-current="step"><b>{st.label}</b><small>{formatDateTime(when(o.status)) }</small></li>}
        </ol>
      </section>

      <div className="ord-cols">
        <div className="ord-main">
          {/* What happens next. Each button is one of the transitions the server allows for this status (d.allowedTransitions)
              and goes through the same actions as the full forms below; nothing here overrides a rule. */}
          <section className="card ord-action" aria-labelledby="next-h" data-next-step={o.status}>
            <h2 id="next-h">Next step</h2>
            {off ? <p>This order is {st.label.toLowerCase()}. Nothing more can be done with it here.</p>
              : o.status === 'pending_payment' || o.status === 'payment_failed' ? <>
                  <p><b>Waiting for the customer to pay.</b> {o.status === 'payment_failed' ? 'The last payment attempt failed; the customer can try again. ' : ''}Payment is recorded by the checkout and cannot be marked paid here.</p>
                  {canStatus && allowed.includes('cancelled') && <p className="ord-action-row"><a className="btn ghost" href="#st-h" data-next="cancel">Cancel this order…</a>{canBilling && <NavLink className="btn ghost" href={paymentHref} data-next="view-payment">View payment</NavLink>}</p>}
                </>
              : o.status === 'delivered' ? (codDue
                  ? <><p><b>Delivered. Cash still to collect: {rupees(cod!.toCollectPaise)}.</b> Record it once the courier or the customer has handed it over.</p>
                      {canCod ? <p className="ord-action-row"><NavLink className="btn" href={collectHref} data-next="cod-collect">Record cash collected</NavLink></p>
                        : <p className="note" data-next="cod-readonly">Recording the cash needs the orders.cod permission.</p>}</>
                  : <p><b>Delivered{cod?.status === 'collected' ? ' and paid in cash' : ''}.</b> Nothing more to do for this order.</p>)
              : !canStatus ? <p className="note" data-next="readonly">You can view this order. Moving it forward needs the orders.update_status permission.</p>
              : o.status === 'paid' && allowed.includes('processing') ? <>
                  <p><b>Payment is confirmed.</b> Start packing to move the order into fulfilment.</p>
                  {quick('processing', 'Start packing')}
                </>
              : o.status === 'processing' && packing !== 'packed' ? <>
                  <p><b>The order is being packed.</b> Mark it packed when the parcel is ready for the courier.</p>
                  <ActionForm action={setPackingStateAction} submitLabel="Mark as packed" pendingLabel="Marking packed…" id="quick-packed-form" label="Mark as packed" className="ord-quick">
                    <Hidden name="orderId" value={o.id} /><Hidden name="packingState" value="packed" />
                  </ActionForm>
                </>
              : o.status === 'processing' && allowed.includes('shipped') ? <>
                  <p><b>Packed and ready.</b> Hand it to the courier, then mark it shipped{codDue ? '. The cash is collected on delivery' : ''}.</p>
                  <ActionForm action={updateOrderStatusAction} submitLabel="Ship order" pendingLabel="Marking shipped…" id="quick-ship-form" label="Ship order" className="form ord-ship" confirmText={`Mark order ${o.orderNumber} as shipped?`}>
                    <Hidden name="orderId" value={o.id} /><Hidden name="expectedStatus" value={o.status} /><Hidden name="toStatus" value="shipped" /><Hidden name="note" value="" />
                    {d.carriers.length > 0 && <div className="cols">
                      <Select name="carrierCode" label="Courier" options={d.carriers.map(c => ({ value: c.code, label: c.label }))} defaultValue={d.carriers[0].code} />
                      <Field name="trackingNumber" label="Tracking number" hint="Optional. It can also be added later." />
                    </div>}
                  </ActionForm>
                </>
              : o.status === 'shipped' && allowed.includes('delivered') ? <>
                  <p><b>With the courier.</b> Mark it delivered once the customer has the parcel{codDue ? '; then record the cash collected' : ''}.</p>
                  {quick('delivered', 'Mark delivered')}
                </>
              : <p className="note">No step is available for this order right now.</p>}
          </section>

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
                    <td>{i.colour ? `${i.colour} / ${i.size}` : i.size}</td>
                    <td className="num" data-qty-label={`${i.qty} × `}>{rupees(i.unit_price_paise)}</td>
                    <td className="num" data-qty>{i.qty}</td>
                    <td className="num">{rupees(i.line_total_paise)}</td>
                  </tr>
                );
              })}</tbody>
              <tfoot>
                <tr><th colSpan={5} className="num">Subtotal</th><td className="num" data-subtotal>{rupees(o.subtotalPaise)}</td></tr>
                {o.discountPaise > 0 && <tr><th colSpan={5} className="num">Discounts{o.loyaltyPointsUsed > 0 ? ` (incl. ${o.loyaltyPointsUsed} points, ${rupees(o.loyaltyDiscountPaise)})` : ''}</th><td className="num" data-discount>−{rupees(o.discountPaise)}</td></tr>}
                <tr><th colSpan={5} className="num">Delivery</th><td className="num" data-shipping-amount>{rupees(o.shippingPaise)}</td></tr>
                {o.codFeePaise > 0 && <tr><th colSpan={5} className="num">Cash on delivery fee</th><td className="num" data-cod-fee>{rupees(o.codFeePaise)}</td></tr>}
                {!o.pricesIncludeTax && <tr><th colSpan={5} className="num">Tax</th><td className="num">{rupees(o.taxPaise)}</td></tr>}
                <tr><th colSpan={5} className="num">Total{o.pricesIncludeTax ? ' (tax-inclusive)' : ''}</th><td className="num" data-order-total><b>{rupees(o.totalPaise)}</b></td></tr>
              </tfoot>
            </table></div>
            <p className="note" data-integrity={intact ? 'ok' : 'mismatch'}>
              {intact ? 'Amounts are the prices paid at checkout. Changes before shipment are made under Edit order and kept in its history.' : 'Warning: the recorded line totals do not add up. Amounts are shown exactly as recorded and were not changed.'}
            </p>
          </section>

          <section className="card" aria-labelledby="ful-h" data-section="fulfilment">
            <h2 id="ful-h">Fulfilment</h2>
            <dl className="facts" data-fulfilment>
              <dt>Stage</dt><dd>{['paid', 'processing', 'shipped', 'delivered'].includes(o.status) ? <StagePill status={o.status} packingState={packing} /> : <span className="note">Not in fulfilment ({st.label.toLowerCase()}{st.note ? `, ${st.note}` : ''})</span>}</dd>
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

          <section className="card ord-pay-card" aria-labelledby="pay-h" data-section="billing">
            <h2 id="pay-h">Payment</h2>
            <div className="ord-pay-sum" data-payment-summary={o.paymentMethod ?? 'online'}>
              <div className="ord-pay-top">
                <div><span className="ord-pay-method">{METHOD_LONG[o.paymentMethod ?? 'online'] ?? o.paymentMethod}</span><b className="ord-pay-amount" data-payment-amount>{rupees(o.totalPaise)}</b></div>
                <div className="ord-pay-state"><PaymentPill method={o.paymentMethod} paymentStatus={o.paymentStatus} codStatus={cod?.status ?? null} orderStatus={o.status} /></div>
              </div>
              <dl className="facts ord-facts">
                {cod ? <>
                  {cod.toCollectPaise > 0 && <><dt>To collect</dt><dd data-cod-to-collect><b>{rupees(cod.toCollectPaise)}</b> in cash on delivery</dd></>}
                  {cod.collectedAt && <><dt>Collected</dt><dd data-cod-collected>{formatDateTime(cod.collectedAt)}{cod.reference && <span className="note mono"> · {cod.reference}</span>}</dd></>}
                  <dt>COD fee</dt><dd>{cod.feePaise > 0 ? rupees(cod.feePaise) : 'None'}</dd>
                </> : <>
                  {canBilling && lastAttempt && <><dt>Provider</dt><dd>{providerLabel(lastAttempt.provider)}{lastAttempt.method ? <span className="note"> · {lastAttempt.method}</span> : null}</dd></>}
                  {canBilling && captured[0]?.provider_payment_id && <><dt>Reference</dt><dd className="mono" data-payment-reference>{captured[0].provider_payment_id}</dd></>}
                  {o.paidAt && <><dt>Paid</dt><dd>{formatDateTime(o.paidAt)}</dd></>}
                </>}
                {canBilling && d.billing!.payments.length > 1 && <><dt>Attempts</dt><dd>{d.billing!.payments.length} ({d.billing!.payments.filter(p => p.status === 'failed').length} failed)</dd></>}
                {refundedPaise > 0 && <><dt>Refunded</dt><dd data-payment-refunded>{rupees(refundedPaise)}</dd></>}
                {refundsOpen > 0 && <><dt>Refunds</dt><dd>{refundsOpen} waiting to be completed</dd></>}
              </dl>
              {canBilling ? <p className="ord-action-row">
                  <NavLink className="btn ghost" href={paymentHref} data-link="view-payment">View payment</NavLink>
                </p>
                : <p className="note" data-readonly="billing">Payment attempts, refunds and invoices are under Payments, which needs the billing.read permission.</p>}
              {/* Without billing.read there is no Payments area to go to: the COD cash is recorded here (orders.cod). */}
              {!canBilling && codDue && canCod && (o.status === 'shipped' || o.status === 'delivered') && (
                <ActionForm action={codCollectAction} submitLabel="Record cash collected" pendingLabel="Recording…" id="cod-collect-form" label="Cash collected" confirmText={`Record ${rupees(o.totalPaise)} collected in cash for ${o.orderNumber}?`}>
                  <Hidden name="orderId" value={o.id} />
                  <div className="cols">
                    <Field name="amount" label="Amount collected (₹)" defaultValue={paiseToRupees(o.totalPaise)} hint="Must be the order total." />
                    <Field name="reference" label="Receipt / courier reference (optional)" />
                  </div>
                </ActionForm>
              )}
            </div>
            {d.payment && d.payment.exceptions.length > 0 && (
              <p className="msg error" data-order-exceptions>{d.payment.exceptions.map((e, i) => <span key={i}><StatusBadge status={e.kind} /> {e.manualRefund ? 'manual refund recorded' : 'needs attention'}{i < d.payment!.exceptions.length - 1 ? ' · ' : ''}</span>)}
                {' '}<Link href="/payments?view=exceptions">Open the exceptions queue</Link></p>)}
            {d.billing && (<>
              <h3 className="sub">Invoice</h3>
              {canIssue && <ActionForm action={createInvoiceAction} submitLabel="Issue invoice" id="issue-invoice-form" label="Issue the invoice for this order" className="inline-form">
                <Hidden name="orderId" value={o.id} /></ActionForm>}
              {d.billing.invoices.length === 0 ? <p className="empty">No invoice.</p> : (
                <ul className="plain" data-invoices>{d.billing.invoices.map(i => (
                  <li key={i.id}>{can(actor, 'finance.read') ? <Link className="mono" href={`/finance/invoices/${i.id}`}>{i.invoice_number ?? 'draft'}</Link> : <span className="mono">{i.invoice_number ?? 'draft'}</span>} <StatusBadge status={i.status} /> {rupees(i.total_paise)}
                    <span className="note"> · {i.prices_include_tax ? 'tax-inclusive' : 'tax added'} · tax {rupees(i.tax_paise)} · {formatDateTime(i.issued_at)}</span></li>))}
                </ul>
              )}
            </>)}
          </section>

          <section className="card" aria-labelledby="st-h" data-section="status">
            <h2 id="st-h">Change status</h2>
            <p className="note">The full status form: use it to cancel an order (a reason is required) or to add a note to the history. The steps above use the same checks.</p>
            <div className="status-actions">
              {!canStatus ? <p className="note" data-readonly="status">Changing the status needs the orders.update_status permission.</p>
                : <OrderStatusForm action={updateOrderStatusAction} orderId={o.id} orderNumber={o.orderNumber} current={o.status} currentLabel={label(o.status)} allowed={d.allowedTransitions} carriers={d.carriers} />}
            </div>
            {/* A cash-on-delivery order is cancelled with its own checked step (before dispatch, or when the parcel is refused). */}
            {cod && codDue && (o.status === 'processing' || o.status === 'shipped') && (
              <div data-section="cod-cancel">
                <h3 className="sub" id="cod-h">{o.status === 'processing' ? 'Cancel this cash-on-delivery order' : 'Parcel refused by the customer'}</h3>
                {!canCod ? <p className="note">This needs the orders.cod permission.</p> : (
                  <ActionForm action={codCancelAction} submitLabel={o.status === 'processing' ? 'Cancel this COD order' : 'Record parcel refused'} variant="danger" id="cod-cancel-form"
                    label={o.status === 'processing' ? 'Cancel before dispatch' : 'Customer refused the parcel'} className="form spaced"
                    confirmText={o.status === 'processing' ? 'Cancel this order? Its items go back to stock.' : 'Record that the customer refused the parcel? The order is cancelled.'}>
                    <Hidden name="orderId" value={o.id} />
                    <Hidden name="kind" value={o.status === 'processing' ? 'cancel' : 'refused'} />
                    <Field name="note" label="Reason" required />
                    {o.status === 'shipped' && <Checkbox name="restock" label="The pieces are back and fit to sell: put them back in stock" />}
                  </ActionForm>
                )}
              </div>
            )}
          </section>

          {editing && (
            <section className="card" aria-labelledby="edit-h" data-section="order-edit">
              <h2 id="edit-h">Edit order</h2>
              {editing.blocker ? <p className="note" data-edit-blocked>{editing.blocker}</p> : (
                <>
                  <p className="note">Change sizes (only sizes at the same price) or quantities (0 removes a line), add a product, or change the delivery address, delivery option, contact details or staff discount. Each line keeps the price the customer paid; discounts, delivery (for a new address) and tax are worked out again on the server.
                    {o.paymentMethod === 'cod' ? ' The new total is what is collected on delivery.' : ' A lower total leaves a refund due; a higher total cannot be saved (an extra payment cannot be collected).'}</p>
                  <ActionForm action={editOrderAction} submitLabel="Save changes" id="order-edit-form" label="Edit order" confirmText="Save these changes? Stock and the order total are updated now.">
                    <Hidden name="orderId" value={o.id} />
                    <Hidden name="expectedTotalPaise" value={String(o.totalPaise)} />
                    <div className="table-wrap"><table data-edit-lines>
                      <thead><tr><th>Item</th><th>Size</th><th>Qty</th></tr></thead>
                      <tbody>{editing.items.map(i => (
                        <tr key={i.id}><td>{i.name}<div className="note mono">{i.sku}</div><input type="hidden" name="itemIds[]" value={i.id} /></td>
                          <td><select name="variantIds[]" className="input" defaultValue={i.variant_id ?? ''} aria-label={`Size of ${i.name}`}>{i.sizes.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></td>
                          <td><input name="qtys[]" className="input qty" type="number" min={0} max={10} defaultValue={i.qty} aria-label={`Quantity of ${i.name}`} /></td></tr>
                      ))}</tbody>
                    </table></div>
                    <Checkbox name="changeAddress" label="Change the delivery address" />
                    <div className="cols">
                      <Field name="fullName" label="Name" defaultValue={d.shipping.name ?? ''} />
                      <Field name="phone" label="Mobile" defaultValue={d.contact.phone ?? ''} />
                      <Field name="line1" label="Address line 1" defaultValue={d.shipping.line1 ?? ''} />
                      <Field name="line2" label="Address line 2" defaultValue={d.shipping.line2 ?? ''} />
                      <Field name="city" label="City" defaultValue={d.shipping.city ?? ''} />
                      <Select name="state" label="State" defaultValue={d.shipping.state ?? ''} options={[{ value: '', label: 'Choose…' }, ...INDIAN_STATES.map(x => ({ value: x, label: x }))]} />
                      <Field name="pin" label="PIN code" defaultValue={d.shipping.pin ?? ''} />
                    </div>
                    <p className="note">The address fields are used only when “Change the delivery address” is ticked.</p>
                    <fieldset className="fieldset" data-edit-extra><legend>More changes</legend>
                      <div className="cols">
                        {editing.addable.length > 0 && <Select name="addVariantId" label="Add a product (today's price)" options={[{ value: '', label: '—' }, ...editing.addable.map(v => ({ value: v.id, label: v.label }))]} />}
                        <Field name="addQty" label="Quantity to add" defaultValue="1" />
                        {editing.delivery.length > 1 && <Select name="deliveryRateId" label="Delivery option" defaultValue={editing.currentRate ?? ''}
                          options={editing.delivery.map(x => ({ value: x.rateId, label: `${x.label} · ${rupees(x.amountPaise)}` }))} />}
                      </div>
                      <Checkbox name="changeContact" label="Change the contact details" />
                      <div className="cols">
                        <Field name="contactName" label="Contact name" defaultValue={d.contact.name ?? ''} />
                        <Field name="contactEmail" label="Contact email" type="email" defaultValue={d.contact.email ?? ''} />
                        <Field name="contactPhone" label="Contact mobile" defaultValue={d.contact.phone ?? ''} />
                      </div>
                      {can(actor, 'orders.discount') && <div className="cols">
                        <Field name="staffDiscountPercent" label="Staff discount % (0 removes it)" hint="Empty: unchanged. Same maximum and minimum prices as draft orders." />
                        <Field name="staffDiscountReason" label="Reason for the discount" />
                      </div>}
                    </fieldset>
                    <TextArea name="note" label="Reason for the change" rows={2} required hint="Kept in the edit history, e.g. Customer asked by phone for size M." />
                  </ActionForm>
                </>
              )}
            </section>
          )}

          {edits.length > 0 && (
            <section className="card" aria-labelledby="edits-h" data-section="order-edits">
              <h2 id="edits-h">Order edits</h2>
              <ol className="timeline" data-edit-history>{edits.map(e => {
                const b = e.before as EditSnap, a = e.after as EditSnap;
                return (
                  <li key={e.id} data-edit={e.id}>
                    <b>{rupees(e.total_before)} → {rupees(e.total_after)}</b>
                    <span className="note"> · {formatDateTime(e.created_at)} · {e.staff_email ?? '—'}</span>
                    <div className="note">“{e.note}”</div>
                    <div className="note">{describeEdit(b, a)}</div>
                    {e.refund_due_paise > 0 && (e.refund_id
                      ? <div className="note" data-edit-refund={e.refund_status}>Refund {rupees(e.refund_due_paise)}: <StatusBadge status={e.refund_status ?? 'pending'} /> {e.refund_method === 'manual' ? `recorded (${e.refund_reference})` : 'through the payment provider'}</div>
                      : <div data-edit-refund="due">
                          <p className="msg error">Refund due: {rupees(e.refund_due_paise)}.{canBilling && <> <NavLink href={`${paymentHref}#refunds`} data-link="refund-due">Make the refund under Payments</NavLink></>}</p>
                          {!canBilling && (can(actor, 'refunds.create') ? (<div className="cols">
                            {provider && <ActionForm action={refundOrderEditAction} submitLabel={`Refund through ${provider.label}`} id={`edit-refund-p-${e.id}`} label="Refund through the payment provider"
                              confirmText={`Refund ${rupees(e.refund_due_paise)} to the customer through ${provider.label}?`}>
                              <Hidden name="editId" value={e.id} /><Hidden name="mode" value="provider" />
                            </ActionForm>}
                            <ActionForm action={refundOrderEditAction} submitLabel="Record refund paid outside" id={`edit-refund-m-${e.id}`} label="Refunded by bank transfer / UPI">
                              <Hidden name="editId" value={e.id} /><Hidden name="mode" value="manual" />
                              <Field name="reference" label="Bank / UPI reference" required />
                            </ActionForm>
                          </div>) : <p className="note">Making the refund needs the refunds.create permission.</p>)}
                        </div>)}
                  </li>
                );
              })}</ol>
            </section>
          )}

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
        </div>

        <aside className="ord-side" aria-label="Order details">
          {origin && <section className="card" aria-labelledby="info-h" data-section="info">
            <h2 id="info-h">Order information</h2>
            {/* 2026-10-01: online or offline (branch), created by staff from a draft, staff discount with its reason. */}
            <dl className="facts ord-facts" data-order-origin={origin.channel}>
              <dt>Channel</dt><dd><b>{origin.channel === 'retail' ? `${origin.pos_number ? 'POS · ' : ''}Offline · ${origin.branch}` : 'Online'}</b>{origin.pos_number && <> · Bill <Link href={`/pos/sale/${id}`} data-order-pos>{origin.pos_number}</Link></>}</dd>
              <dt>Paid by</dt><dd>{({ online: 'online', cod: 'cash on delivery', cash: 'cash in store', card: 'card in store', upi: 'UPI in store' } as Record<string, string>)[origin.payment_method] ?? origin.payment_method}</dd>
              <dt>Placed</dt><dd>{formatDateTime(o.createdAt)}</dd>
              {o.paidAt && <><dt>Paid at</dt><dd>{formatDateTime(o.paidAt)}</dd></>}
              <dt>Source</dt><dd>{origin.created_by ? <>Created by {origin.created_by}{origin.draft_id ? <> from draft <Link href={`/drafts/${origin.draft_id}`}>{origin.draft_number}</Link></> : null}</> : 'Placed by the customer'}</dd>
              {(() => { const pv = pricingView(origin.pricing); return <>
                {pv.delivery && <><dt>{pv.delivery.pickup ? 'Pickup' : 'Delivery'}</dt><dd data-order-delivery>{pv.delivery.pickup ? 'Store pickup' : 'Delivery'}: {pv.delivery.label}{pv.delivery.estimate ? ` (${pv.delivery.estimate})` : ''}</dd></>}
                {pv.discounts.length > 0 && <><dt>Discounts</dt><dd data-order-discounts>Discounts: {pv.discounts.map(x => `${x.label} −${formatPaise(x.amountPaise)}`).join('; ')}</dd></>}</>; })()}
              {origin.staff_discount_paise > 0 && <><dt>Staff</dt><dd data-staff-discount>Staff discount {origin.staff_discount_bp! / 100}% ({formatPaise(origin.staff_discount_paise)}) on {formatPaise(origin.subtotal_paise)}: “{origin.staff_discount_reason}”, by {origin.discount_by ?? '—'}</dd></>}
              <dt>Last change</dt><dd>{formatDateTime(o.updatedAt)}</dd>
            </dl>
          </section>}

          <section className="card" aria-labelledby="cust-h" data-section="customer">
            <h2 id="cust-h">Customer</h2>
            <dl className="facts ord-facts">
              <dt>Name</dt><dd>{d.contact.name ?? '—'}</dd>
              <dt>Email</dt><dd>{d.contact.email ?? '—'}</dd>
              <dt>Phone</dt><dd>{d.contact.phone ?? '—'}</dd>
              <dt>Account</dt><dd data-customer-account>{d.customer === undefined ? <span className="note">needs customers.read</span>
                : d.customer ? <><Link href={`/customers/${d.customer.id}`} data-customer-link>{d.customer.email}</Link> <StatusBadge status={d.customer.status} /></>
                : <span className="note">no account record</span>}</dd>
            </dl>
            <h3 className="sub">Ship to</h3>
            <address className="ord-address">{address.length ? address.map((l, i) => <div key={i}>{l}</div>) : '—'}</address>
            <h3 className="sub">Bill to</h3>
            <address className="ord-address" data-billing>{d.billingAddress ? lines(d.billingAddress).map((l, i) => <div key={i}>{l}</div>) : 'Same as delivery'}</address>
          </section>

          {/* Who did what: the order's own status history (staff member, the customer, or the system), newest last. */}
          <section className="card" aria-labelledby="hist-h" data-section="activity">
            <h2 id="hist-h">Timeline</h2>
            {moments.length === 0 ? <p className="empty">Nothing recorded yet.</p> : (
              <ol className="timeline" data-history>
                {moments.map(m => (
                  <li key={m.key} data-timeline={m.kind} {...(m.row ? { 'data-history-row': m.row } : {})}>
                    <b>{m.title}</b>
                    <span className="note"> · {formatDateTime(m.at)} · {m.meta}</span>
                    {m.note && <div className="note">“{m.note}”</div>}
                  </li>
                ))}
              </ol>
            )}
            {!canBilling && cod?.collectedAt && <p className="note" data-cod-activity>Cash on delivery collected {formatDateTime(cod.collectedAt)}.</p>}
            {/* 2026-10-01: the customer emails of this order (sent / failed; none yet = pending or not applicable). */}
            <h3 className="sub">Customer emails</h3>
            <p className="note" data-order-emails>Customer emails: {emails.length === 0 ? 'none sent yet' : emails.map(e => `${e.event.replace('.', ' ')} ${e.status === 'sent' ? 'sent' : 'FAILED'} ${formatDateTime(e.created_at as Date)}${e.error ? ` (${e.error})` : ''}`).join(' · ')}</p>
          </section>
        </aside>
      </div>
    </NavFrame>
  );
}
