/* One return or exchange, shown on its order's Returns tab. It is the one return screen of the ERP: the Returns queue
   opens the same order on this tab. The steps offered are exactly those the return workflow allows from the current
   status (core RETURN_FLOW, passed in as `actions`); the forms call the existing return actions. */
import { can, type StaffPrincipal } from '@kitsyuu/auth';
import type { getReturn } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Facts, Section } from '@/components/frame';
import { StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { rupeesField } from '@/lib/erp';
import { refundProvider } from '@/lib/payments';
import { refundAction, returnItemAction, returnStepAction } from '../../returns/actions';

const STEP: Record<string, { label: string; variant?: 'danger' | 'ghost'; note?: 'required' | 'optional' }> = {
  review: { label: 'Start review', variant: 'ghost' },
  request_info: { label: 'Ask the customer for information', variant: 'ghost', note: 'required' },
  approve: { label: 'Approve' },
  reject: { label: 'Reject', variant: 'danger', note: 'required' },
  schedule_pickup: { label: 'Schedule pickup' },
  picked_up: { label: 'Mark picked up' },
  receive: { label: 'Mark received' },
  inspect: { label: 'Record inspection', note: 'optional' },
  ship_exchange: { label: 'Send the replacement', note: 'optional' },
  complete: { label: 'Complete' },
  cancel: { label: 'Cancel return', variant: 'danger', note: 'optional' },
};

export function ReturnPanel({ actor, data }: { actor: StaffPrincipal; data: Awaited<ReturnType<typeof getReturn>> }) {
  const { ret: r, items, events, refunds, payments, sizes, itemsValuePaise, actions } = data;
  const manage = can(actor, 'returns.manage');
  const canRefund = manage && can(actor, 'refunds.create');
  const provider = refundProvider();
  const left = payments.reduce((n, p) => n + Math.max(0, p.left), 0);
  const providerRefunds = !!provider?.refund && payments.some(p => p.provider === provider.code && p.left > 0);
  const received = ['received', 'inspection', 'refund_pending', 'refunded', 'exchange_pending', 'exchanged', 'completed'].includes(r.status) || (r.status === 'rejected' && !!r.received_at);
  const stepForm = (a: string) => {
    const s = STEP[a]!;
    return (
      <details key={a} className="row-edit" data-step={a}><summary className={`btn sm ${s.variant ?? ''}`}>{s.label}</summary>
        <ActionForm action={returnStepAction} submitLabel={s.label} variant={s.variant === 'danger' ? 'danger' : undefined} className="form compact row-edit-form" id={`step-${a}`} label={s.label}>
          <Hidden name="returnId" value={r.id} /><Hidden name="action" value={a} />
          {a === 'approve' && <Select name="resolution" label="Resolution" options={[{ value: 'refund', label: 'Refund' }, { value: 'exchange', label: 'Exchange for another size' }]} />}
          {a === 'schedule_pickup' && <><Field name="pickupAt" label="Pickup (India time)" type="datetime-local" required /><Field name="pickupRef" label="Pickup / courier reference" /></>}
          {a === 'inspect' && <>
            <Select name="inspectionResult" label="Result" options={[{ value: 'ok', label: 'OK (as expected)' }, { value: 'damaged', label: 'Damaged (still accepted)' }, { value: 'not_returnable', label: 'Not returnable (rejects the return)' }]} />
            {r.resolution !== 'exchange' && <Field name="refundAmount" label="Refund to make (₹)" hint={`Items returned are worth ${formatPaise(itemsValuePaise)} at the price paid. Enter the amount the business decides.`} />}
          </>}
          {s.note && <TextArea name="note" label={a === 'reject' ? 'Reason (kept here; the customer sees the status)' : a === 'request_info' ? 'What is needed' : 'Note (staff only)'} rows={2} required={s.note === 'required'} />}
        </ActionForm>
      </details>
    );
  };
  return (
    <div data-return={r.number} data-return-status={r.status}>
      <Section id={`ret-${r.id}`} title={`Return ${r.number}`} name="return" meta={<StatusBadge status={r.status} />} hint={`Requested ${formatDateTime(r.requested_at as Date)}.`}>
        <Facts items={[
          { label: 'Resolution', value: r.resolution ?? 'not decided' },
          { label: 'Reason', value: r.reason },
          { label: 'Customer wrote', value: r.description ?? '—' },
          ...(r.pickup_at ? [{ label: 'Pickup', value: `${formatDateTime(r.pickup_at as Date)}${r.pickup_ref ? ` · ${r.pickup_ref}` : ''}` }] : []),
          ...(r.received_at ? [{ label: 'Received', value: formatDateTime(r.received_at as Date) }] : []),
          ...(r.inspection_result ? [{ label: 'Inspection', value: `${r.inspection_result}${r.inspection_note ? ` — ${r.inspection_note}` : ''}` }] : []),
          ...(r.refund_amount_paise ? [{ label: 'Refund', value: formatPaise(r.refund_amount_paise) }] : []),
          ...(r.staff_note ? [{ label: 'Staff note', value: r.staff_note }] : []),
        ]} />
      </Section>

      <Section id={`ret-next-${r.id}`} title="Next step" name="return-actions" hint="Only the steps the return workflow allows from its current status are offered.">
        {!manage ? <p className="note">Handling returns needs returns.manage.</p> : actions.length === 0 ? <p className="note">Nothing more to do{r.status === 'refund_pending' ? ' except the refund below' : ''}.</p>
          : <div className="actions">{actions.map(stepForm)}</div>}
      </Section>

      <Section id={`ret-items-${r.id}`} title="Returned items" name="return-items" wide hint="Restocking puts the units back through the stock ledger (the order's branch for a counter sale, the online stock otherwise).">
        <div className="table-wrap"><table data-return-items>
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Paid each</th><th>Back in stock</th>{r.resolution === 'exchange' && <th>Replacement</th>}</tr></thead>
          <tbody>{items.map(i => {
            const choices = sizes.filter(z => z.product_id === i.product_id && z.is_active);
            return (
              <tr key={i.id}>
                <td>{i.name}<div className="note mono">{i.sku} · {i.colour ? `${i.colour}, ` : ''}size {i.size}</div></td><td className="num">{i.qty}</td><td className="num money">{formatPaise(i.unit_price_paise)}</td>
                <td>{i.restocked_qty} of {i.qty}
                  {manage && received && i.restocked_qty < i.qty && i.variant_id && (
                    <ActionForm action={returnItemAction} submitLabel="Restock" variant="ghost" className="inline-form" id={`restock-${i.id}`} label="Restock" confirmText="Put these units back into sellable stock?">
                      <Hidden name="returnId" value={r.id} /><Hidden name="returnItemId" value={i.id} />
                      <label className="sr-only" htmlFor={`rq-${i.id}`}>Units</label>
                      <input id={`rq-${i.id}`} name="restockQty" type="number" min={1} max={i.qty - i.restocked_qty} defaultValue={i.qty - i.restocked_qty} className="input" style={{ width: 70 }} />
                    </ActionForm>)}</td>
                {r.resolution === 'exchange' && <td>{i.exchange_size ? `Size ${i.exchange_size}` : '—'}
                  {manage && !['exchanged', 'completed', 'cancelled', 'rejected'].includes(r.status) && (
                    <ActionForm action={returnItemAction} submitLabel="Set" variant="ghost" className="inline-form" id={`exchange-${i.id}`} label="Replacement size">
                      <Hidden name="returnId" value={r.id} /><Hidden name="returnItemId" value={i.id} />
                      <label className="sr-only" htmlFor={`ex-${i.id}`}>Size</label>
                      <select id={`ex-${i.id}`} name="exchangeVariantId" className="input" defaultValue={i.exchange_variant_id ?? ''}>
                        <option value="">Choose…</option>{choices.map(z => <option key={z.id} value={z.id}>Size {z.size} ({z.stock_qty} in stock)</option>)}
                      </select>
                    </ActionForm>)}</td>}
              </tr>
            );
          })}</tbody>
        </table></div>
      </Section>

      {r.resolution !== 'exchange' && (
        <Section id={`ret-refund-${r.id}`} title="Refund" name="refunds" wide
          hint={<>Captured on this order: {formatPaise(payments.reduce((n, p) => n + p.amount_paise, 0))} · can still be refunded: {formatPaise(left)}.
            {provider?.refund ? ` Refunds can be sent through ${provider.label}.` : ' No payment provider is set up for refunds: refund outside the platform (bank / UPI / provider dashboard), then record it with its reference.'}</>}>
          {refunds.length > 0 && (
            <div className="table-wrap"><table data-refunds-table>
              <thead><tr><th>When</th><th className="num">Amount</th><th>How</th><th>Reference</th><th>Status</th><th>By</th></tr></thead>
              <tbody>{refunds.map(f => (
                <tr key={f.id}><td className="nowrap">{formatDateTime(f.created_at as Date)}</td><td className="num money">{formatPaise(f.amount_paise)}</td>
                  <td>{f.method === 'provider' ? 'Payment provider' : 'Recorded manually'}</td><td className="mono">{f.provider_refund_id ?? f.reference ?? '—'}</td>
                  <td><StatusBadge status={f.status} />{f.failure_reason && <div className="note">{f.failure_reason}</div>}</td><td>{f.processed_by_email ?? '—'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {r.status === 'refund_pending' ? (canRefund ? (
            <ActionForm action={refundAction} submitLabel="Make refund" pendingLabel="Refunding…" id="refund-form" label="Refund" confirmText="Make this refund? It cannot be undone from here.">
              <Hidden name="returnId" value={r.id} />
              <Select name="mode" label="How" options={[...(providerRefunds ? [{ value: 'provider', label: `Through ${provider!.label}` }] : []), { value: 'manual', label: 'Already refunded outside the platform (record it)' }]} />
              <div className="cols">
                <Field name="amount" label="Amount (₹)" defaultValue={rupeesField(r.refund_amount_paise)} required />
                <Field name="reference" label="Reference" hint="Required for a manual refund: bank / UPI / provider refund id." />
              </div>
              <TextArea name="note" label="Reason" rows={2} required />
            </ActionForm>
          ) : <p className="note">Making refunds needs returns.manage and refunds.create.</p>)
            : refunds.length === 0 && <p className="note">The refund is made here once the return has been received and inspected.</p>}
        </Section>
      )}

      <Section id={`ret-hist-${r.id}`} title="Return history" name="return-history" wide>
        <ol className="timeline">{events.map(e => (
          <li key={e.id}><StatusBadge status={e.to_status} /> <span className="who">{formatDateTime(e.created_at as Date)} · {e.staff_email ?? e.actor_type}</span>{e.note && <p className="msg-body">{e.note}</p>}</li>
        ))}</ol>
      </Section>
    </div>
  );
}
