import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, paiseToRupees, uuid } from '@kitsyuu/contracts';
import { getOrderPayment } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { NavFrame, NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { refundProvider } from '@/lib/payments';
import { db, requireActor } from '@/lib/server';
import { codCollectAction, refundOrderEditAction } from '../../orders/actions';
import { StagePill } from '../../orders/order-ui';
import { METHOD_LONG, PaymentPill, paymentState, providerLabel } from '../payment-ui';

export const metadata: Metadata = { title: 'Payment' };
type Params = Promise<{ id: string }>;
const EXCEPTION_HELP: Record<string, string> = {
  captured_after_cancel: 'Money was received for an order that is cancelled. Refund it by hand and record it in the exceptions queue.',
  amount_mismatch: 'The amount received differs from the order total. Check it with the payment provider.',
  duplicate_capture: 'The order was paid more than once. Check it with the payment provider.',
  paid_without_capture: 'The order is marked paid but there is no captured payment record. Check it with the payment provider.',
};
const AUDIT_TEXT: Record<string, string> = {
  'order.cod_refused': 'Parcel refused: no cash collected', 'order.cod_cancelled': 'Cash-on-delivery order cancelled before dispatch',
  'payment.manual_refund_recorded': 'Manual refund recorded for money received after cancellation', 'payment.not_verified': 'A payment result could not be verified',
};

/* One order's payment: "what happened to the customer's money?". Everything shown is the recorded data (payment
   attempts, the COD state, refunds, provider notifications); the two actions here are the existing, checked ones
   (record COD cash: orders.cod; refund the difference an order edit left: refunds.create). The order itself, its
   fulfilment and its cancellation are managed on the order page. */
export default async function PaymentPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/payments', label: '← Back to payments' }];
  if (!can(actor, 'billing.read')) return <><PageHead section="Commerce" title="Payment" crumbs={crumbs} /><Forbidden permission="billing.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const d = await getOrderPayment(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const { order: o, attempts, refunds, cod } = d;
  const facts = { method: o.payment_method, paymentStatus: o.payment_status, codStatus: o.cod_status, orderStatus: o.status };
  const state = paymentState(facts);
  const isCod = o.payment_method === 'cod', store = ['cash', 'card', 'upi'].includes(o.payment_method ?? '');
  const canOrders = can(actor, 'orders.read'), canCod = can(actor, 'orders.cod'), canRefund = can(actor, 'refunds.create');
  const money = attempts.filter(a => ['captured', 'refunded', 'partially_refunded'].includes(a.status));
  const main = money[0] ?? attempts.at(-1) ?? null;
  const receivedAt = money[0]?.captured_at ?? null;
  const customerName = o.contact_name ?? o.contact_email ?? 'No customer details';
  const provider = refundProvider();
  const codDue = isCod && cod?.status === 'to_collect' && o.status !== 'cancelled';
  const codReady = codDue && (o.status === 'shipped' || o.status === 'delivered');
  const openException = d.exceptions.filter(e => !e.manualRefund);

  // The payment's own timeline, oldest first, from the recorded rows only.
  type Moment = { at: Date; key: string; kind: string; title: string; meta?: string | null; note?: string | null };
  const n = (i: number) => (attempts.filter(a => a.provider !== 'cod' && a.provider !== 'pos').length > 1 ? `Attempt ${i + 1}` : 'Payment');
  let online = -1;
  const moments: Moment[] = [
    { at: new Date(o.created_at), key: 'placed', kind: 'order', title: `Order placed · ${formatPaise(o.total_paise)} to pay`, meta: METHOD_LONG[o.payment_method ?? 'online'] ?? o.payment_method },
    ...attempts.flatMap((a): Moment[] => {
      if (a.provider === 'cod') return [{ at: new Date(a.captured_at ?? a.created_at), key: `a${a.id}`, kind: 'captured', title: `Cash collected · ${formatPaise(a.amount_paise)}`, meta: a.recorded_by ?? 'staff', note: [a.reference, a.note].filter(Boolean).join(' · ') || null }];
      if (a.provider === 'pos') return [{ at: new Date(a.captured_at ?? a.created_at), key: `a${a.id}`, kind: 'captured', title: `Paid at the counter · ${formatPaise(a.amount_paise)}`, meta: [a.method, a.recorded_by].filter(Boolean).join(' · '), note: a.reference }];
      online += 1;
      const label = n(online), out: Moment[] = [{ at: new Date(Math.min(new Date(a.created_at).getTime(), new Date(a.captured_at ?? a.created_at).getTime())), key: `a${a.id}s`, kind: 'started', title: `${label} started`, meta: providerLabel(a.provider) }];
      if (a.captured_at) out.push({ at: new Date(a.captured_at), key: `a${a.id}c`, kind: 'captured', title: `${label} captured · ${formatPaise(a.amount_paise)}`, meta: a.provider_payment_id });
      else if (a.status === 'failed') out.push({ at: new Date(a.updated_at), key: `a${a.id}f`, kind: 'failed', title: `${label} failed`, meta: a.provider_payment_id, note: a.failure_reason });
      else if (a.status === 'authorized') out.push({ at: new Date(a.updated_at), key: `a${a.id}z`, kind: 'pending', title: `${label} authorised, not captured yet`, meta: a.provider_payment_id });
      return out;
    }),
    ...refunds.flatMap((r): Moment[] => {
      const out: Moment[] = [{ at: new Date(r.created_at), key: `r${r.id}`, kind: 'refund', title: `Refund of ${formatPaise(r.amount_paise)} ${r.method === 'manual' ? 'recorded' : 'requested'}`, meta: r.requested_by, note: r.reason }];
      if (r.processed_at) out.push({ at: new Date(r.processed_at), key: `r${r.id}p`, kind: 'refund', title: `Refund of ${formatPaise(r.amount_paise)} completed`, meta: r.processed_by ?? (r.method === 'provider' ? 'payment provider' : null), note: r.reference ?? r.provider_refund_id });
      else if (r.status === 'failed') out.push({ at: new Date(r.created_at), key: `r${r.id}f`, kind: 'failed', title: `Refund of ${formatPaise(r.amount_paise)} failed`, note: r.failure_reason });
      return out;
    }),
    ...d.events.map((e): Moment => ({ at: new Date(e.received_at), key: `e${e.id}`, kind: 'event', title: `Provider notification: ${e.type}`, meta: e.outcome ? (STATUS_LABEL[e.outcome] ?? e.outcome).toLowerCase() : 'not processed' })),
    ...d.audit.filter(a => AUDIT_TEXT[a.action]).map((a, i): Moment => ({ at: new Date(a.occurred_at), key: `u${i}`, kind: 'staff', title: AUDIT_TEXT[a.action], meta: a.staff_email ?? a.actor_type })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <NavFrame className="ord ord-detail pay-detail" data-payment-screen data-payment-state={state.code}>
      <PageHead section="Commerce" title={`Payment · ${o.order_number}`} eyebrow={`${customerName} · ${METHOD_LONG[o.payment_method ?? 'online'] ?? o.payment_method} · ${o.currency}`} crumbs={crumbs}>
        <span className="head-status"><span className="head-status-label">Payment</span><PaymentPill {...facts} note={false} /></span>
        {canOrders && <NavLink className="btn ghost sm" href={`/orders/${o.id}`} data-link="order">View order</NavLink>}
      </PageHead>
      {openException.length > 0 && <p className="msg error" data-payment-exception><b>{STATUS_LABEL[openException[0].kind] ?? openException[0].kind}.</b> {EXCEPTION_HELP[openException[0].kind]} <Link href="/payments?view=exceptions">Open the exceptions queue</Link></p>}

      <div className="ord-cols">
        <div className="ord-main">
          <section className="card ord-pay-card" aria-labelledby="sum-h" data-section="payment-summary">
            <h2 id="sum-h">Payment</h2>
            <div className="ord-pay-sum">
              <div className="ord-pay-top">
                <div><span className="ord-pay-method">{METHOD_LONG[o.payment_method ?? 'online'] ?? o.payment_method}</span><b className="ord-pay-amount" data-payment-amount>{formatPaise(o.total_paise)}</b></div>
                <div className="ord-pay-state"><PaymentPill {...facts} /></div>
              </div>
              <dl className="facts ord-facts" data-payment-facts>
                <dt>Status</dt><dd data-payment-status>{state.label}</dd>
                <dt>Method</dt><dd>{METHOD_LONG[o.payment_method ?? 'online'] ?? o.payment_method}{main?.method && !isCod && !store ? <span className="note"> · {main.method}</span> : null}</dd>
                <dt>Provider</dt><dd data-payment-provider>{isCod ? <span className="note">None: cash is collected on delivery</span> : main ? providerLabel(main.provider) : <span className="note">No payment attempt yet</span>}</dd>
                <dt>Reference</dt><dd data-payment-reference>{main?.provider_payment_id ? <span className="mono">{main.provider_payment_id}</span> : <span className="note">—</span>}{main?.provider_order_id && !store ? <div className="note mono">session {main.provider_order_id}</div> : null}</dd>
                <dt>Created</dt><dd>{formatDateTime(attempts[0]?.created_at ?? o.created_at)}</dd>
                <dt>{isCod ? 'Collected' : 'Received'}</dt><dd data-payment-received>{receivedAt ? formatDateTime(receivedAt) : <span className="note">{isCod ? 'Not collected yet' : 'Not received yet'}</span>}</dd>
                {d.refundedPaise > 0 && <><dt>Refunded</dt><dd data-payment-refunded>{formatPaise(d.refundedPaise)} of {formatPaise(d.capturedPaise)}</dd></>}
              </dl>
            </div>
            {(o.status === 'pending_payment' || o.status === 'payment_failed') && <p className="note" data-payment-waiting>Waiting for the customer to pay. An online payment is recorded only by the verified checkout: it cannot be marked paid by hand.</p>}
          </section>

          {isCod && cod && (
            <section className="card" aria-labelledby="collect" data-section="cod" data-cod={cod.status}>
              <h2 id="collect">Cash on delivery</h2>
              <dl className="facts ord-facts">
                <dt>Collection</dt><dd data-cod-status>{state.label.replace(/^COD · /, '')}</dd>
                {cod.toCollectPaise > 0 && <><dt>To collect</dt><dd data-cod-to-collect><b>{formatPaise(cod.toCollectPaise)}</b></dd></>}
                <dt>COD fee</dt><dd>{cod.feePaise > 0 ? `${formatPaise(cod.feePaise)} (included)` : 'None'}</dd>
                {cod.collectedAt && <><dt>Collected at</dt><dd data-cod-collected-at>{formatDateTime(cod.collectedAt)}</dd></>}
                {cod.collectedAt && <><dt>Recorded by</dt><dd>{attempts.find(a => a.provider === 'cod')?.recorded_by ?? '—'}</dd></>}
                {cod.reference && <><dt>Receipt</dt><dd className="mono">{cod.reference}</dd></>}
              </dl>
              {codDue && (!canCod ? <p className="note" data-cod-readonly>Recording the cash needs the orders.cod permission.</p>
                : !codReady ? <p className="note" data-cod-wait>The cash can be recorded once the order has been shipped or delivered. Recording it does not change the order's stage.</p>
                : (
                  <ActionForm action={codCollectAction} submitLabel="Record cash collected" pendingLabel="Recording…" id="cod-collect-form" label="Record the cash collected" className="form spaced"
                    confirmText={`Record ${formatPaise(o.total_paise)} collected in cash for ${o.order_number}?`}>
                    <Hidden name="orderId" value={o.id} />
                    <div className="cols">
                      <Field name="amount" label="Amount collected (₹)" defaultValue={paiseToRupees(o.total_paise)} hint="Must be the order total." />
                      <Field name="reference" label="Receipt / courier reference (optional)" />
                    </div>
                  </ActionForm>
                ))}
              {cod.status === 'refused' && <p className="note">The customer refused the parcel, so nothing was collected. The order was cancelled on its own page.</p>}
            </section>
          )}

          <section className="card" aria-labelledby="att-h" data-section="attempts">
            <h2 id="att-h">Payment attempts</h2>
            {attempts.length === 0 ? <p className="empty" data-no-attempts>{isCod ? 'No payment is recorded for a cash-on-delivery order until the cash is collected.' : 'The customer has not started a payment yet.'}</p> : (<>
              <div className="table-wrap"><table data-attempts-table>
                <thead><tr><th>Attempt</th><th>Started</th><th>Provider</th><th>Reference</th><th className="num">Amount</th><th>Result</th></tr></thead>
                <tbody>{attempts.map((a, i) => (
                  <tr key={a.id} data-attempt={a.status}>
                    <td>{a.provider === 'cod' ? 'Cash recorded' : a.provider === 'pos' ? 'Counter payment' : `Attempt ${i + 1}`}</td>
                    <td className="nowrap">{formatDateTime(a.captured_at && new Date(a.captured_at) < new Date(a.created_at) ? a.captured_at : a.created_at)}</td>
                    <td>{providerLabel(a.provider)}{a.method && <div className="note">{a.method}</div>}</td>
                    <td className="mono">{a.provider_payment_id ?? '—'}</td>
                    <td className="num money">{formatPaise(a.amount_paise)}</td>
                    <td><StatusBadge status={a.status} />{a.failure_reason && <div className="note">{a.failure_reason}</div>}{a.captured_at && <div className="note">{formatDateTime(a.captured_at)}</div>}</td>
                  </tr>))}
                </tbody></table></div>
              <p className="note">Every attempt is kept as its own record; a retry never replaces an earlier one.</p>
            </>)}
          </section>

          <section className="card" aria-labelledby="refunds" data-section="refunds">
            <h2 id="refunds">Refunds</h2>
            {d.refundsDue.map(x => (
              <div key={x.editId} className="pay-due" data-refund-due={x.editId}>
                <p className="msg error">Refund due: <b>{formatPaise(x.amountPaise)}</b>. The order was edited to a lower total on {formatDateTime(x.createdAt)} (“{x.note}”).</p>
                {canRefund ? (<div className="cols">
                  {provider && <ActionForm action={refundOrderEditAction} submitLabel={`Refund through ${provider.label}`} pendingLabel="Refunding…" id={`edit-refund-p-${x.editId}`} label="Refund through the payment provider"
                    confirmText={`Refund ${formatPaise(x.amountPaise)} to the customer through ${provider.label}?`}>
                    <Hidden name="editId" value={x.editId} /><Hidden name="mode" value="provider" />
                  </ActionForm>}
                  <ActionForm action={refundOrderEditAction} submitLabel="Record refund paid outside" pendingLabel="Recording…" id={`edit-refund-m-${x.editId}`} label="Refunded by bank transfer / UPI">
                    <Hidden name="editId" value={x.editId} /><Hidden name="mode" value="manual" />
                    <Field name="reference" label="Bank / UPI reference" required />
                  </ActionForm>
                </div>) : <p className="note">Making the refund needs the refunds.create permission.</p>}
              </div>
            ))}
            {refunds.length === 0 ? (d.refundsDue.length === 0 && <p className="empty" data-no-refunds>No refund has been made or requested for this payment.</p>) : (
              <div className="table-wrap"><table data-refunds-table>
                <thead><tr><th>Date</th><th className="num">Amount</th><th>Status</th><th>Reason</th><th>How</th><th>Reference</th></tr></thead>
                <tbody>{refunds.map(r => (
                  <tr key={r.id} data-refund={r.status}>
                    <td className="nowrap">{formatDateTime(r.processed_at ?? r.created_at)}{r.requested_by && <div className="note">{r.requested_by}</div>}</td>
                    <td className="num money">{formatPaise(r.amount_paise)}</td>
                    <td><StatusBadge status={r.status} />{r.failure_reason && <div className="note">{r.failure_reason}</div>}</td>
                    <td>{r.reason}{r.return_id && <div className="note">return {can(actor, 'returns.read') ? <Link href={`/returns/${r.return_id}`}>{r.return_number}</Link> : r.return_number}</div>}</td>
                    <td>{r.method === 'provider' ? 'Payment provider' : r.method === 'manual' ? 'Paid outside, recorded' : 'By hand (to be paid outside)'}</td>
                    <td className="mono">{r.reference ?? r.provider_refund_id ?? '—'}</td>
                  </tr>))}
                </tbody></table></div>
            )}
            {d.capturedPaise > 0 && <p className="note" data-refund-total>Received {formatPaise(d.capturedPaise)} · refunded {formatPaise(d.refundedPaise)} · kept {formatPaise(d.capturedPaise - d.refundedPaise)}. A refund can be part of the amount.</p>}
            <p className="note">Refunds are started where their reason is recorded: a returned item under <Link href="/returns">Returns &amp; refunds</Link>, a lower total after an order edit here, and money received for a cancelled order in the <Link href="/payments?view=exceptions">exceptions queue</Link>.
              {provider ? ` Refunds can be sent through ${provider.label}.` : ' No payment provider is connected for refunds in this environment, so a refund is paid outside the platform and recorded with its reference.'}</p>
          </section>
        </div>

        <aside className="ord-side" aria-label="Order and customer">
          <section className="card" aria-labelledby="ord-h" data-section="order">
            <h2 id="ord-h">Order</h2>
            <dl className="facts ord-facts">
              <dt>Order</dt><dd>{canOrders ? <NavLink href={`/orders/${o.id}`} data-order-link className="mono">{o.order_number}</NavLink> : <span className="mono">{o.order_number}</span>}</dd>
              <dt>Stage</dt><dd><StagePill status={o.status} packingState={o.packing_state} /></dd>
              <dt>Placed</dt><dd>{formatDateTime(o.created_at)}</dd>
              <dt>Channel</dt><dd>{o.channel === 'retail' ? `In store${o.pos_number ? ` · POS ${o.pos_number}` : ''}` : 'Online'}</dd>
              <dt>Order total</dt><dd>{formatPaise(o.total_paise)}</dd>
            </dl>
            <p className="note">The order's stage and its payment are separate: an order can be delivered while its cash is still to collect.</p>
          </section>
          <section className="card" aria-labelledby="cust-h" data-section="customer">
            <h2 id="cust-h">Customer</h2>
            <dl className="facts ord-facts">
              <dt>Name</dt><dd>{o.contact_name ?? '—'}</dd>
              <dt>Email</dt><dd>{o.contact_email ?? '—'}</dd>
              <dt>Phone</dt><dd>{o.contact_phone ?? '—'}</dd>
              {d.customer && <><dt>Account</dt><dd><Link href={`/customers/${d.customer.id}`} data-customer-link>{d.customer.email}</Link></dd></>}
            </dl>
          </section>
          <section className="card" aria-labelledby="tl-h" data-section="payment-timeline">
            <h2 id="tl-h">Payment timeline</h2>
            <ol className="timeline" data-payment-timeline>
              {moments.map(m => (
                <li key={m.key} data-moment={m.kind}>
                  <b>{m.title}</b>
                  <span className="note"> · {formatDateTime(m.at)}{m.meta ? ` · ${m.meta}` : ''}</span>
                  {m.note && <div className="note">{m.note}</div>}
                </li>
              ))}
              {codDue && <li data-moment="waiting"><b>Cash to collect on delivery</b><span className="note"> · {formatPaise(cod!.toCollectPaise)}</span></li>}
              {(o.status === 'pending_payment' || o.status === 'payment_failed') && <li data-moment="waiting"><b>Waiting for the customer to pay</b>{o.payment_expires_at && <span className="note"> · held until {formatDateTime(o.payment_expires_at)}</span>}</li>}
            </ol>
          </section>
        </aside>
      </div>
    </NavFrame>
  );
}
