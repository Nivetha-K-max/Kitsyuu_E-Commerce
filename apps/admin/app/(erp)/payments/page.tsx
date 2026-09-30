import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { paymentEventListQuery, paymentListQuery, type PaymentEventListQuery, type PaymentListQuery } from '@kitsyuu/contracts';
import { getPaymentExceptions, listPaymentEvents, listPayments } from '@kitsyuu/core';
import { ActionForm, Hidden, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { recordManualRefundAction } from './actions';
import FilterForm from '@/components/FilterForm';

export const metadata: Metadata = { title: 'Payments' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const VIEWS = [['exceptions', 'Exceptions'], ['attempts', 'Payment attempts'], ['events', 'Provider notifications']] as const;
type View = (typeof VIEWS)[number][0];
const EXCEPTION_HELP: Record<string, string> = {
  captured_after_cancel: 'Money was received for an order that is cancelled. Refund it by hand and record it here.',
  amount_mismatch: 'The amount received differs from the order total. Check it with the payment provider.',
  duplicate_capture: 'The order was paid more than once. Check it with the payment provider.',
  paid_without_capture: 'The order is marked paid but there is no captured payment record. Check it with the payment provider.',
};

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'billing.read')) return <><PageHead section="Commerce" title="Payments" /><Forbidden permission="billing.read" /></>;
  const sp = await searchParams;
  const view: View = VIEWS.some(([v]) => v === one(sp.view)) ? one(sp.view) as View : 'exceptions';
  const exceptions = await getPaymentExceptions(db(), actor);
  const tab = (v: View, label: string) => (
    <Link key={v} className={`btn ${v === view ? '' : 'ghost'} sm`} href={`/payments?view=${v}`} aria-current={v === view ? 'page' : undefined} data-payments-view={v}>
      {label}{v === 'exceptions' && exceptions.openCount > 0 ? ` (${exceptions.openCount})` : ''}</Link>
  );
  return (
    <>
      <PageHead section="Commerce" title="Payments" eyebrow="Payments are recorded by the verified checkout flow; this page only reads them. Refunds are never sent from here." />
      <nav className="tabs actions" aria-label="Payment views" data-payments-tabs>{VIEWS.map(([v, l]) => tab(v, l))}</nav>
      {view === 'exceptions' ? <Exceptions rows={exceptions.rows} canRefund={can(actor, 'refunds.create')} canOrders={can(actor, 'orders.read')} />
        : view === 'attempts' ? await Attempts({ sp, actor })
        : await Events({ sp, actor })}
    </>
  );
}

function Exceptions({ rows, canRefund, canOrders }: { rows: Awaited<ReturnType<typeof getPaymentExceptions>>['rows']; canRefund: boolean; canOrders: boolean }) {
  if (rows.length === 0) return <Empty title="No payment exceptions" kind="payment-exceptions">Every payment matches its order.</Empty>;
  return (
    <section className="card" aria-labelledby="ex-h" data-section="exceptions">
      <h2 id="ex-h">Exceptions queue</h2>
      <p className="note">The only action here is recording that money received for a cancelled order was refunded by hand. Refunds for returned items are handled under Returns &amp; refunds.</p>
      <div className="table-wrap"><table data-exceptions-table>
        <thead><tr><th>Exception</th><th>Order</th><th>Payment</th><th className="num">Received</th><th className="num">Order total</th><th>Handling</th></tr></thead>
        <tbody>{rows.map((e, i) => (
          <tr key={`${e.orderId}-${e.paymentId ?? 'order'}-${i}`} data-exception={e.kind} data-exception-order={e.orderNumber}>
            <td><StatusBadge status={e.kind} /><div className="note">{EXCEPTION_HELP[e.kind]}</div></td>
            <td className="mono nowrap">{canOrders ? <Link className="row-link" href={`/orders/${e.orderId}`}>{e.orderNumber}</Link> : e.orderNumber}
              <div><StatusBadge status={e.orderStatus} /></div></td>
            <td className="mono">{e.providerPaymentId ?? '—'}{e.provider && <div className="note">{e.provider}</div>}</td>
            <td className="num money">{e.amountPaise === null ? '—' : formatPaise(e.amountPaise)}</td>
            <td className="num money">{formatPaise(e.orderTotalPaise)}</td>
            <td data-exception-handling>
              {e.manualRefund ? <><StatusBadge status={e.manualRefund.status} /> <span className="note">Manual refund recorded {formatDateTime(e.manualRefund.createdAt)}
                {e.manualRefund.requestedBy ? ` by ${e.manualRefund.requestedBy}` : ''}. “{e.manualRefund.reason}”</span></>
                : e.kind === 'captured_after_cancel' && e.paymentId && canRefund ? (
                  <ActionForm action={recordManualRefundAction} submitLabel="Record manual refund" pendingLabel="Recording…" label={`Record manual refund for ${e.orderNumber}`}
                    confirmText={`Record that ${e.amountPaise === null ? 'this payment' : formatPaise(e.amountPaise)} for ${e.orderNumber} is refunded by hand? Nothing is sent to the payment provider.`}>
                    <Hidden name="paymentId" value={e.paymentId} />
                    <TextArea name="note" label="How it is refunded" rows={2} required hint="E.g. bank transfer reference. Kept in the audit log." />
                  </ActionForm>)
                : e.kind === 'captured_after_cancel' ? <span className="note">Needs the refunds.create permission.</span>
                : <span className="note">Open — check with the provider.</span>}
            </td>
          </tr>))}
        </tbody></table></div>
    </section>
  );
}

async function Attempts({ sp, actor }: { sp: Record<string, string | string[] | undefined>; actor: Awaited<ReturnType<typeof requireActor>> }) {
  const parsed = paymentListQuery.safeParse({ q: one(sp.q), status: one(sp.status), provider: one(sp.provider), exception: one(sp.exception), page: one(sp.page) });
  const query: PaymentListQuery = parsed.success ? parsed.data : { q: undefined, status: 'all', provider: 'all', exception: 'all', page: 1 };
  const { rows, hasNext, providers } = await listPayments(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all' || query.provider !== 'all' || query.exception !== 'all');
  const link = (page: number) => `/payments?${new URLSearchParams({ view: 'attempts', ...Object.fromEntries(Object.entries({ q: query.q, status: query.status, provider: query.provider, exception: query.exception })
    .filter(([, v]) => v && v !== 'all') as [string, string][]), page: String(page) })}`;
  return (
    <>
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <FilterForm className="actions" role="search" aria-label="Filter payments" data-payment-filters>
        <input type="hidden" name="view" value="attempts" />
        <label className="sr-only" htmlFor="p-q">Search</label>
        <input id="p-q" name="q" className="input" placeholder="Order no., payment reference or email" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="p-status">Payment status</label>
        <select id="p-status" name="status" className="input" defaultValue={query.status}>
          <option value="all">Any status</option>
          {['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'].map(s => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
        </select>
        <label className="sr-only" htmlFor="p-provider">Provider</label>
        <select id="p-provider" name="provider" className="input" defaultValue={query.provider}>
          <option value="all">Any provider</option>{providers.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="sr-only" htmlFor="p-ex">Exceptions</label>
        <select id="p-ex" name="exception" className="input" defaultValue={query.exception}>
          <option value="all">With or without exceptions</option><option value="any">Any exception</option>
          {['captured_after_cancel', 'amount_mismatch', 'duplicate_capture'].map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
        </select>
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/payments?view=attempts">Clear</Link>}
      </FilterForm>
      {rows.length === 0 ? <Empty title={filtered ? 'No matching payments' : 'No payments yet'} kind="payments">
          {filtered ? 'No payment attempts match these filters.' : 'Payment attempts appear here once online payment is switched on.'}</Empty> : (
        <div className="table-wrap"><table data-payments-list>
          <thead><tr><th>Created</th><th>Order</th><th>Provider</th><th>Reference</th><th className="num">Amount</th><th>Status</th><th>Exception</th></tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id} data-payment-row={p.provider_payment_id ?? p.id}>
              <td className="nowrap">{formatDateTime(p.created_at)}</td>
              <td className="mono nowrap">{can(actor, 'orders.read') ? <Link className="row-link" href={`/orders/${p.order_id}`}>{p.order_number}</Link> : p.order_number}
                <div><StatusBadge status={p.order_status} /></div></td>
              <td>{p.provider}{p.method && <div className="note">{p.method}</div>}</td>
              <td className="mono">{p.provider_payment_id ?? '—'}{p.provider_order_id && <div className="note">{p.provider_order_id}</div>}</td>
              <td className="num money">{formatPaise(p.amount_paise)}{p.currency !== 'INR' && <div className="note">{p.currency}</div>}</td>
              <td><StatusBadge status={p.status} />{p.failure_reason && <div className="note">{p.failure_reason}</div>}{p.captured_at && <div className="note">captured {formatDateTime(p.captured_at)}</div>}</td>
              <td>{p.exception ? <StatusBadge status={p.exception} /> : <span className="note">—</span>}{p.manual_refund_id && <div className="note">manual refund recorded</div>}</td>
            </tr>))}
          </tbody></table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Payment pages">
          {query.page > 1 ? <Link className="btn ghost sm" href={link(query.page - 1)}>← Newer</Link> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <Link className="btn ghost sm" href={link(query.page + 1)}>Older →</Link> : <span />}
        </nav>
      )}
    </>
  );
}

async function Events({ sp, actor }: { sp: Record<string, string | string[] | undefined>; actor: Awaited<ReturnType<typeof requireActor>> }) {
  const parsed = paymentEventListQuery.safeParse({ q: one(sp.q), provider: one(sp.provider), outcome: one(sp.outcome), page: one(sp.page) });
  const query: PaymentEventListQuery = parsed.success ? parsed.data : { q: undefined, provider: 'all', outcome: 'all', page: 1 };
  const { rows, hasNext } = await listPaymentEvents(db(), actor, query);
  const filtered = !!(query.q || query.provider !== 'all' || query.outcome !== 'all');
  const link = (page: number) => `/payments?${new URLSearchParams({ view: 'events', ...Object.fromEntries(Object.entries({ q: query.q, provider: query.provider, outcome: query.outcome })
    .filter(([, v]) => v && v !== 'all') as [string, string][]), page: String(page) })}`;
  return (
    <>
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <FilterForm className="actions" role="search" aria-label="Filter provider notifications" data-event-filters>
        <input type="hidden" name="view" value="events" />
        <label className="sr-only" htmlFor="e-q">Search</label>
        <input id="e-q" name="q" className="input" placeholder="Event id, type or order no." defaultValue={query.q ?? ''} />
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/payments?view=events">Clear</Link>}
      </FilterForm>
      <p className="note">Notifications (webhooks) the payment provider sent. Each is processed once; the message content is not shown.</p>
      {rows.length === 0 ? <Empty title={filtered ? 'No matching notifications' : 'No notifications yet'} kind="payment-events">
          {filtered ? 'No provider notifications match.' : 'Provider notifications appear here once online payment is switched on.'}</Empty> : (
        <div className="table-wrap"><table data-events-table>
          <thead><tr><th>Received</th><th>Provider</th><th>Event</th><th>Order</th><th>Outcome</th><th>Processed</th></tr></thead>
          <tbody>{rows.map(e => (
            <tr key={e.id} data-event-row={e.id}>
              <td className="nowrap">{formatDateTime(e.received_at)}</td><td>{e.provider}</td>
              <td><span className="mono">{e.type}</span><div className="note mono">{e.id}</div></td>
              <td className="mono">{e.order_id ? (can(actor, 'orders.read') ? <Link className="row-link" href={`/orders/${e.order_id}`}>{e.order_number}</Link> : e.order_number) : '—'}</td>
              <td>{e.outcome ? <StatusBadge status={e.outcome} /> : <span className="note">—</span>}</td>
              <td className="nowrap">{formatDateTime(e.processed_at)}</td>
            </tr>))}
          </tbody></table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Notification pages">
          {query.page > 1 ? <Link className="btn ghost sm" href={link(query.page - 1)}>← Newer</Link> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <Link className="btn ghost sm" href={link(query.page + 1)}>Older →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
