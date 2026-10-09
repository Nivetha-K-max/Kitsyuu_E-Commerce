/* The Payment tab of an order: "what happened to this order's money?". It is the one payment screen of the ERP: the
   Payments queue opens the same order on this tab, so there is no second payment workflow.
   Everything shown is recorded data (payment attempts, the COD state, refunds, provider notifications). The actions are
   the existing, checked ones: record COD cash (orders.cod), refund the difference an order edit left (refunds.create)
   and record a manual refund for money received after the order was cancelled (refunds.create). Refunds for returned
   items are made on the Returns tab. Nothing here invents a payment rule. */
import Link from 'next/link';
import { can, type StaffPrincipal } from '@kitsyuu/auth';
import { paiseToRupees } from '@kitsyuu/contracts';
import type { getOrderPayment } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, TextArea } from '@/components/forms';
import { Facts, Section } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { refundProvider } from '@/lib/payments';
import { METHOD_LONG, PaymentPill, paymentState, providerLabel } from '../../payments/payment-ui';
import { recordManualRefundAction } from '../../payments/actions';
import { codCollectAction, refundOrderEditAction } from '../actions';

const EXCEPTION_HELP: Record<string, string> = {
  captured_after_cancel: 'Money was received for an order that is cancelled. Refund it by hand and record it here.',
  amount_mismatch: 'The amount received differs from the order total. Check it with the payment provider.',
  duplicate_capture: 'The order was paid more than once. Check it with the payment provider.',
  paid_without_capture: 'The order is marked paid but there is no captured payment record. Check it with the payment provider.',
};
const AUDIT_TEXT: Record<string, string> = {
  'order.cod_refused': 'Parcel refused: no cash collected', 'order.cod_cancelled': 'Cash-on-delivery order cancelled before dispatch',
  'payment.manual_refund_recorded': 'Manual refund recorded for money received after cancellation', 'payment.not_verified': 'A payment result could not be verified',
};

export function PaymentPanel({ actor, d, returnsHref }: { actor: StaffPrincipal; d: Awaited<ReturnType<typeof getOrderPayment>>; returnsHref: string }) {
  const { order: o, attempts, refunds, cod } = d;
  const facts = { method: o.payment_method, paymentStatus: o.payment_status, codStatus: o.cod_status, orderStatus: o.status };
  const state = paymentState(facts);
  const isCod = o.payment_method === 'cod', store = ['cash', 'card', 'upi'].includes(o.payment_method ?? '');
  const canCod = can(actor, 'orders.cod'), canRefund = can(actor, 'refunds.create');
  const money = attempts.filter(a => ['captured', 'refunded', 'partially_refunded'].includes(a.status));
  const main = money[0] ?? attempts.at(-1) ?? null;
  const receivedAt = money[0]?.captured_at ?? null;
  const provider = refundProvider();
  const codDue = isCod && cod?.status === 'to_collect' && o.status !== 'cancelled';
  const codReady = codDue && (o.status === 'shipped' || o.status === 'delivered');
  const method = METHOD_LONG[o.payment_method ?? 'online'] ?? o.payment_method;

  // The payment's own timeline, oldest first, from the recorded rows only.
  type Moment = { at: Date; key: string; kind: string; title: string; meta?: string | null; note?: string | null };
  const onlineIds = attempts.filter(a => a.provider !== 'cod' && a.provider !== 'pos').map(a => a.id);
  const attemptName = (id: string) => (onlineIds.length > 1 ? `Attempt ${onlineIds.indexOf(id) + 1}` : 'Payment');
  const moments: Moment[] = [
    { at: new Date(o.created_at), key: 'placed', kind: 'order', title: `Order placed · ${formatPaise(o.total_paise)} to pay`, meta: method },
    ...attempts.flatMap((a): Moment[] => {
      if (a.provider === 'cod') return [{ at: new Date(a.captured_at ?? a.created_at), key: `a${a.id}`, kind: 'captured', title: `Cash collected · ${formatPaise(a.amount_paise)}`, meta: a.recorded_by ?? 'staff', note: [a.reference, a.note].filter(Boolean).join(' · ') || null }];
      if (a.provider === 'pos') return [{ at: new Date(a.captured_at ?? a.created_at), key: `a${a.id}`, kind: 'captured', title: `Paid at the counter · ${formatPaise(a.amount_paise)}`, meta: [a.method, a.recorded_by].filter(Boolean).join(' · '), note: a.reference }];
      const label = attemptName(a.id);
      // an attempt cannot have started after it was captured (seen in imported demo rows): show the earlier time
      const out: Moment[] = [{ at: new Date(Math.min(new Date(a.created_at).getTime(), new Date(a.captured_at ?? a.created_at).getTime())), key: `a${a.id}s`, kind: 'started', title: `${label} started`, meta: providerLabel(a.provider) }];
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
    ...d.audit.filter(a => AUDIT_TEXT[a.action]).map((a, i): Moment => ({ at: new Date(a.occurred_at), key: `u${i}`, kind: 'staff', title: AUDIT_TEXT[a.action]!, meta: a.staff_email ?? a.actor_type })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <div className="pay-detail" data-payment-screen data-payment-state={state.code}>
      {d.exceptions.length > 0 && (
        <Section id="exc-h" title="Payment exception" name="payment-exception" hint="Something about this payment does not match its order. It stays listed in Payments → Exceptions until it is handled.">
          {d.exceptions.map((e, i) => (
            <div key={`${e.paymentId ?? 'order'}-${i}`} className="pay-exc" data-payment-exception={e.kind} data-exception-open={e.manualRefund ? undefined : ''}>
              <p className={`msg ${e.manualRefund ? 'ok' : 'error'}`}><b>{STATUS_LABEL[e.kind] ?? e.kind}.</b> {EXCEPTION_HELP[e.kind]}
                {e.amountPaise !== null && <> Received {formatPaise(e.amountPaise)}{e.providerPaymentId ? <> (<span className="mono">{e.providerPaymentId}</span>)</> : null}; order total {formatPaise(e.orderTotalPaise)}.</>}</p>
              <div data-exception-handling>
                {e.manualRefund ? <p className="note"><StatusBadge status={e.manualRefund.status} /> Manual refund recorded {formatDateTime(e.manualRefund.createdAt)}{e.manualRefund.requestedBy ? ` by ${e.manualRefund.requestedBy}` : ''}. “{e.manualRefund.reason}”</p>
                  : e.kind === 'captured_after_cancel' && e.paymentId && canRefund ? (
                    <ActionForm action={recordManualRefundAction} submitLabel="Record manual refund" pendingLabel="Recording…" id={`manual-refund-${e.paymentId}`} label={`Record manual refund for ${o.order_number}`}
                      confirmText={`Record that ${e.amountPaise === null ? 'this payment' : formatPaise(e.amountPaise)} for ${o.order_number} is refunded by hand? Nothing is sent to the payment provider.`}>
                      <Hidden name="paymentId" value={e.paymentId} />
                      <TextArea name="note" label="How it is refunded" rows={2} required hint="E.g. bank transfer reference. Kept in the audit log." />
                    </ActionForm>)
                  : e.kind === 'captured_after_cancel' ? <p className="note">Recording the manual refund needs the refunds.create permission.</p>
                  : <p className="note">Open: check it with the payment provider. Nothing can be recorded for it here.</p>}
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section id="sum-h" title="Payment" name="payment-summary" hint="How this order is paid and where the money stands.">
        <div className="ord-pay-top">
          <div><span className="ord-pay-method">{method}</span><b className="ord-pay-amount" data-payment-amount>{formatPaise(o.total_paise)}</b></div>
          <div className="ord-pay-state"><PaymentPill {...facts} /></div>
        </div>
        <Facts attr="data-payment-facts" items={[
          { label: 'Status', value: <span data-payment-status>{state.label}</span> },
          { label: 'Method', value: <>{method}{main?.method && !isCod && !store ? <span className="note"> · {main.method}</span> : null}</> },
          { label: 'Provider', value: <span data-payment-provider>{isCod ? <span className="note">None: cash is collected on delivery</span> : main ? providerLabel(main.provider) : <span className="note">No payment attempt yet</span>}</span> },
          { label: 'Reference', value: <span data-payment-reference>{main?.provider_payment_id ? <span className="mono">{main.provider_payment_id}</span> : <span className="note">—</span>}{main?.provider_order_id && !store ? <span className="note mono"> · session {main.provider_order_id}</span> : null}</span> },
          { label: 'Created', value: formatDateTime(attempts[0]?.created_at ?? o.created_at) },
          { label: isCod ? 'Collected' : 'Received', value: <span data-payment-received>{receivedAt ? formatDateTime(receivedAt) : <span className="note">{isCod ? 'Not collected yet' : 'Not received yet'}</span>}</span> },
          ...(d.refundedPaise > 0 ? [{ label: 'Refunded', value: <span data-payment-refunded>{formatPaise(d.refundedPaise)} of {formatPaise(d.capturedPaise)}</span> }] : []),
        ]} />
        {(o.status === 'pending_payment' || o.status === 'payment_failed') && <p className="note" data-payment-waiting>Waiting for the customer to pay. An online payment is recorded only by the verified checkout: it cannot be marked paid by hand.</p>}
      </Section>

      {isCod && cod && (
        <Section id="collect" title="Cash on delivery" name="cod" hint="Recording the cash completes the payment. It does not change the order's stage.">
          <div data-cod={cod.status}>
            <Facts items={[
              { label: 'Collection', value: <span data-cod-status>{state.label.replace(/^COD · /, '')}</span> },
              ...(cod.toCollectPaise > 0 ? [{ label: 'To collect', value: <b data-cod-to-collect>{formatPaise(cod.toCollectPaise)}</b> }] : []),
              { label: 'COD fee', value: cod.feePaise > 0 ? `${formatPaise(cod.feePaise)} (included)` : 'None' },
              ...(cod.collectedAt ? [{ label: 'Collected at', value: <span data-cod-collected-at>{formatDateTime(cod.collectedAt)}</span> }, { label: 'Recorded by', value: attempts.find(a => a.provider === 'cod')?.recorded_by ?? '—' }] : []),
              ...(cod.reference ? [{ label: 'Receipt', value: <span className="mono">{cod.reference}</span> }] : []),
            ]} />
          </div>
          {codDue && (!canCod ? <p className="note" data-cod-readonly>Recording the cash needs the orders.cod permission.</p>
            : !codReady ? <p className="note" data-cod-wait>The cash can be recorded once the order has been shipped or delivered.</p>
            : (
              <ActionForm action={codCollectAction} submitLabel="Record cash collected" pendingLabel="Recording…" id="cod-collect-form" label="Record the cash collected"
                confirmText={`Record ${formatPaise(o.total_paise)} collected in cash for ${o.order_number}?`}>
                <Hidden name="orderId" value={o.id} />
                <div className="cols">
                  <Field name="amount" label="Amount collected (₹)" defaultValue={paiseToRupees(o.total_paise)} hint="Must be the order total." />
                  <Field name="reference" label="Receipt / courier reference (optional)" />
                </div>
              </ActionForm>
            ))}
          {cod.status === 'refused' && <p className="note">The customer refused the parcel, so nothing was collected and the order was cancelled.</p>}
        </Section>
      )}

      <Section id="att-h" title="Payment attempts" name="attempts" wide meta={attempts.length ? `${attempts.length}` : undefined} hint="Every attempt is kept as its own record; a retry never replaces an earlier one.">
        {attempts.length === 0 ? <p className="empty" data-no-attempts>{isCod ? 'No payment is recorded for a cash-on-delivery order until the cash is collected.' : 'The customer has not started a payment yet.'}</p> : (
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
        )}
      </Section>

      <Section id="refunds" title="Refunds" name="refunds" wide
        hint={<>A refund is started where its reason is recorded: a returned item on the <NavLink href={returnsHref}>Returns tab</NavLink>, a lower total after an order edit here, and money received for a cancelled order under Payment exception above.
          {provider ? ` Refunds can be sent through ${provider.label}.` : ' No payment provider is connected for refunds in this environment, so a refund is paid outside the platform and recorded with its reference.'}</>}>
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
                <td>{r.reason}{r.return_id && <div className="note">return <NavLink href={`${returnsHref}&return=${r.return_id}`}>{r.return_number}</NavLink></div>}</td>
                <td>{r.method === 'provider' ? 'Payment provider' : r.method === 'manual' ? 'Paid outside, recorded' : 'By hand (to be paid outside)'}</td>
                <td className="mono">{r.reference ?? r.provider_refund_id ?? '—'}</td>
              </tr>))}
            </tbody></table></div>
        )}
        {d.capturedPaise > 0 && <p className="note" data-refund-total>Received {formatPaise(d.capturedPaise)} · refunded {formatPaise(d.refundedPaise)} · kept {formatPaise(d.capturedPaise - d.refundedPaise)}. A refund can be part of the amount.</p>}
      </Section>

      <Section id="tl-h" title="Payment timeline" name="payment-timeline" wide>
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
      </Section>
    </div>
  );
}
