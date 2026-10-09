import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { orderPaymentListQuery, paymentEventListQuery, paymentListQuery, type OrderPaymentListQuery, type PaymentEventListQuery, type PaymentListQuery } from '@kitsyuu/contracts';
import { getPaymentExceptions, listOrderPayments, listPaymentEvents, listPayments, PAYMENT_PAGE_SIZE } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';
import { FilterLink, NavFrame, NavLink } from '@/components/NavFrame';
import { orderStage } from '../orders/order-ui';
import { methodLabel, PaymentPill, providerLabel } from './payment-ui';

export const metadata: Metadata = { title: 'Payments' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/* Payments is the money queue across orders: which payments failed, which COD cash is still to collect, what was
   refunded, which payments do not match their order. It finds the work; the work is done on the order's Payment tab
   (one payment record, one workflow). The first view is one line per order's payment; the others are the records behind it. */
const VIEWS = [['payments', 'Payments'], ['exceptions', 'Exceptions'], ['attempts', 'Payment attempts'], ['events', 'Provider notifications']] as const;
const STATES: { value: OrderPaymentListQuery['state']; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Pending' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' }, { value: 'cod_to_collect', label: 'COD · To collect' }, { value: 'cod_collected', label: 'COD · Cash collected' }, { value: 'cod_refused', label: 'COD · Not collected' },
];
type View = (typeof VIEWS)[number][0];
const EXCEPTION_HELP: Record<string, string> = {
  captured_after_cancel: 'Money was received for an order that is cancelled. It has to be refunded by hand and recorded.',
  amount_mismatch: 'The amount received differs from the order total. Check it with the payment provider.',
  duplicate_capture: 'The order was paid more than once. Check it with the payment provider.',
  paid_without_capture: 'The order is marked paid but there is no captured payment record. Check it with the payment provider.',
};

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'billing.read')) return <><PageHead section="Commerce" title="Payments" /><Forbidden permission="billing.read" /></>;
  const sp = await searchParams;
  const view: View = VIEWS.some(([v]) => v === one(sp.view)) ? one(sp.view) as View : 'payments';
  const exceptions = await getPaymentExceptions(db(), actor);
  const tab = (v: View, label: string) => (
    <FilterLink key={v} className="btn ghost sm" group="view" current={v === view} currentValue="page" href={v === 'payments' ? '/payments' : `/payments?view=${v}`} data-payments-view={v}>
      {label}{v === 'exceptions' && exceptions.openCount > 0 ? ` (${exceptions.openCount})` : ''}</FilterLink>
  );
  return (
    <NavFrame className="ord pay" data-payments-screen>
      <PageHead section="Commerce" title="Payments" eyebrow={view === 'payments' ? 'The money of each order: how it is paid, what was received, collected or refunded. A row opens the order on its Payment tab.'
        : view === 'exceptions' ? 'Payments that do not match their order. Each is handled on its order’s Payment tab.'
        : 'Online payments are recorded by the verified checkout flow; these views only read them.'} />
      <nav className="tabs ord-views" aria-label="Payment views" data-payments-tabs>{VIEWS.map(([v, l]) => tab(v, l))}</nav>
      {view === 'payments' ? await Payments({ sp, actor })
        : view === 'exceptions' ? <Exceptions rows={exceptions.rows} canRefund={can(actor, 'refunds.create')} canOrders={can(actor, 'orders.read')} />
        : view === 'attempts' ? await Attempts({ sp, actor })
        : await Events({ sp, actor })}
    </NavFrame>
  );
}

async function Payments({ sp, actor }: { sp: Record<string, string | string[] | undefined>; actor: Awaited<ReturnType<typeof requireActor>> }) {
  const parsed = orderPaymentListQuery.safeParse({ q: one(sp.q), state: one(sp.state), method: one(sp.method), from: one(sp.from), to: one(sp.to), page: one(sp.page) });
  const query: OrderPaymentListQuery = parsed.success ? parsed.data : { q: undefined, state: 'all', method: 'all', from: undefined, to: undefined, page: 1 };
  const { rows, hasNext, matching, total, codToCollect } = await listOrderPayments(db(), actor, query);
  const filtered = !!(query.q || query.state !== 'all' || query.method !== 'all' || query.from || query.to);
  const canOrders = can(actor, 'orders.read'), canCod = can(actor, 'orders.cod');
  // A payment is its order's Payment tab (one record, two ways in). Without orders.read the same panel opens on its own.
  const pay = (orderId: string, hash = '') => `${canOrders ? `/orders/${orderId}?tab=payment` : `/payments/${orderId}`}${hash}`;
  const href = (change: Partial<Record<'q' | 'state' | 'method' | 'from' | 'to' | 'page', string | undefined>>) => {
    const next = { q: query.q, state: query.state, method: query.method, from: query.from, to: query.to, page: undefined as string | undefined, ...change };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v && v !== 'all') as [string, string][]).toString();
    return qs ? `/payments?${qs}` : '/payments';
  };
  const first = (query.page - 1) * PAYMENT_PAGE_SIZE + 1;
  return (
    <>
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <p className="note pay-count" data-payments-count>{total} payment{total === 1 ? '' : 's'}{filtered ? ` · ${matching} matching` : ''}{rows.length && (hasNext || query.page > 1) ? ` · ${first}–${first + rows.length - 1}` : ''}
        {codToCollect.orders > 0 && <> · <FilterLink group="state" current={false} href={href({ state: 'cod_to_collect' })} data-cod-outstanding>Cash to collect: <b>{formatPaise(codToCollect.paise)}</b> on {codToCollect.orders} COD order{codToCollect.orders === 1 ? '' : 's'}</FilterLink></>}</p>
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter payments" data-order-payment-filters>
          <label className="sr-only" htmlFor="op-q">Search</label>
          <input id="op-q" name="q" className="input" placeholder="Search order no., customer, phone or payment reference" defaultValue={query.q ?? ''} />
          {query.state !== 'all' && <input type="hidden" name="state" value={query.state} />}
          <span className="ord-dates">
            <label htmlFor="op-from">Order placed</label>
            <input id="op-from" name="from" type="date" className="input" defaultValue={query.from ?? ''} aria-label="Placed on or after" />
            <span aria-hidden="true">–</span>
            <input id="op-to" name="to" type="date" className="input" defaultValue={query.to ?? ''} aria-label="Placed on or before" />
          </span>
          <label className="sr-only" htmlFor="op-method">Payment method</label>
          <select id="op-method" name="method" className="input ord-pay-filter" defaultValue={query.method === 'all' ? '' : query.method} data-payment-method-filter>
            <option value="">Any method</option><option value="online">Online</option><option value="cod">Cash on delivery</option><option value="store">In store (cash, card, UPI)</option>
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/payments" data-clear-filters>Clear all</FilterLink>}
      </div>
      <nav className="ord-chipset ord-stages" aria-label="Filter by payment status" data-payment-state-chips>
        <span className="ord-chip-label" aria-hidden="true">Status</span>
        {STATES.map(c => <FilterLink key={c.value} className="ord-chip" group="state" href={href({ state: c.value })} current={query.state === c.value} data-payment-state-chip={c.value}>{c.label}</FilterLink>)}
      </nav>
      {rows.length === 0 ? <Empty title={filtered ? 'No matching payments' : 'No payments yet'} kind="order-payments" action={filtered ? <Link className="btn ghost" href="/payments">Clear filters</Link> : undefined}>
          {filtered ? 'No payment matches these filters.' : 'A payment appears here for every order placed.'}</Empty> : (
        <div className="table-wrap ord-table" data-fresh key={href({ page: String(query.page) })}><table data-order-payments>
          <thead><tr><th>Payment for</th><th>Reference</th><th>Method</th><th>Status</th><th className="num">Amount</th><th>Date (IST)</th><th>Next step</th></tr></thead>
          <tbody>{rows.map(p => {
            const st = orderStage(p.status), cod = p.payment_method === 'cod';
            const codDue = cod && p.cod_status === 'to_collect' && p.status !== 'cancelled';
            const collect = codDue && canCod && (p.status === 'shipped' || p.status === 'delivered');
            // Why this payment needs attention, from its recorded state only.
            const why = p.refunds_open > 0 ? 'refund in progress' : p.payment_status === 'failed' ? `last attempt failed${p.attempts > 1 ? ` (${p.attempts} attempts)` : ''}`
              : codDue ? (p.status === 'delivered' ? 'delivered, cash not recorded' : p.status === 'shipped' ? 'collect on delivery' : 'collect after dispatch')
              : p.payment_status === 'pending' || p.payment_status === 'authorized' ? 'waiting for the customer to pay' : null;
            return (
              <tr key={p.id} data-payment-of={p.order_number}>
                <td className="ord-who"><NavLink prefetch className="row-link" href={pay(p.id)} aria-label={`Payment for order ${p.order_number}`}>{p.contact_name ?? p.contact_email ?? 'No customer details'}</NavLink>
                  <div className="ord-no"><span className="mono">{p.order_number}</span><span> · order {st.label.toLowerCase()}</span></div></td>
                <td className="ord-extra pay-ref" data-label="Reference">{p.reference ? <span className="mono">{p.reference}</span> : <span className="note">{cod ? 'no cash recorded yet' : 'no payment yet'}</span>}
                  {p.attempts > 1 && <div className="note">{p.attempts} attempts</div>}</td>
                <td className="ord-items pay-method">{methodLabel(p.payment_method)}{!cod && p.provider && p.provider !== 'pos' ? <div className="note">{providerLabel(p.provider)}</div> : p.provider === 'pos' ? <div className="note">in store</div> : null}</td>
                <td className="ord-stage"><PaymentPill method={p.payment_method} paymentStatus={p.payment_status} codStatus={p.cod_status} orderStatus={p.status} note={false} />
                  {p.refunded_paise > 0 && <div className="note">{formatPaise(p.refunded_paise)} refunded</div>}{why && <div className="note" data-payment-why>{why}</div>}</td>
                <td className="num money ord-amount" data-payment-amount>{formatPaise(p.total_paise)}</td>
                <td className="nowrap ord-placed">{formatDateTime(p.captured_at ?? p.created_at)}<div className="note">{p.captured_at ? (cod ? 'collected' : 'received') : 'order placed'}</div></td>
                <td className="ord-next" data-next-step>{collect ? <NavLink className="btn sm" href={pay(p.id, '#collect')} aria-label={`Record COD cash: order ${p.order_number}`}>Record COD cash<span aria-hidden="true"> →</span></NavLink>
                  : p.refunds_open > 0 ? <NavLink className="btn ghost sm" href={pay(p.id, '#refunds')} aria-label={`View refund for order ${p.order_number}`}>View refund</NavLink>
                  : p.payment_status === 'failed' ? <NavLink className="btn ghost sm" href={pay(p.id, '#att-h')} aria-label={`View payment attempts for order ${p.order_number}`}>View attempts</NavLink>
                  : <NavLink className="btn ghost sm" href={pay(p.id)} aria-label={`View payment for order ${p.order_number}`}>View</NavLink>}</td>
              </tr>);
          })}
          </tbody></table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Payment pages">
          {query.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page - 1) })}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page + 1) })}>Older →</FilterLink> : <span />}
        </nav>
      )}
    </>
  );
}

function Exceptions({ rows, canRefund, canOrders }: { rows: Awaited<ReturnType<typeof getPaymentExceptions>>['rows']; canRefund: boolean; canOrders: boolean }) {
  if (rows.length === 0) return <Empty title="No payment exceptions" kind="payment-exceptions">Every payment matches its order.</Empty>;
  const open = (orderId: string) => (canOrders ? `/orders/${orderId}?tab=payment#exc-h` : `/payments/${orderId}`);
  return (
    <div className="table-wrap ord-table" data-section="exceptions"><table data-exceptions-table>
      <thead><tr><th>Exception</th><th>Order</th><th>Payment</th><th className="num">Received</th><th className="num">Order total</th><th>Handling</th><th>Next step</th></tr></thead>
      <tbody>{rows.map((e, i) => {
        const record = !e.manualRefund && e.kind === 'captured_after_cancel' && !!e.paymentId && canRefund;
        return (
          <tr key={`${e.orderId}-${e.paymentId ?? 'order'}-${i}`} data-exception={e.kind} data-exception-order={e.orderNumber} data-exception-state={e.manualRefund ? 'recorded' : 'open'}>
            <td className="ord-who"><StatusBadge status={e.kind} /><div className="note">{EXCEPTION_HELP[e.kind]}</div></td>
            <td className="mono nowrap ord-extra" data-label="Order"><NavLink prefetch className="row-link" href={open(e.orderId)} aria-label={`Payment exception of order ${e.orderNumber}`}>{e.orderNumber}</NavLink>
              <div><StatusBadge status={e.orderStatus} /></div></td>
            <td className="mono ord-extra" data-label="Payment">{e.providerPaymentId ?? '—'}{e.provider && <div className="note">{e.provider}</div>}</td>
            <td className="num money ord-extra" data-label="Received">{e.amountPaise === null ? '—' : formatPaise(e.amountPaise)}</td>
            <td className="num money ord-amount">{formatPaise(e.orderTotalPaise)}</td>
            <td className="ord-stage" data-exception-handling>
              {e.manualRefund ? <><StatusBadge status={e.manualRefund.status} /> <span className="note">Manual refund recorded {formatDateTime(e.manualRefund.createdAt)}
                {e.manualRefund.requestedBy ? ` by ${e.manualRefund.requestedBy}` : ''}. “{e.manualRefund.reason}”</span></>
                : e.kind === 'captured_after_cancel' ? <span className="note">Open: refund by hand, then record it{canRefund ? '' : ' (needs refunds.create)'}.</span>
                : <span className="note">Open: check with the provider.</span>}
            </td>
            <td className="ord-next" data-next-step>{record
              ? <NavLink className="btn sm" href={open(e.orderId)} aria-label={`Record manual refund: order ${e.orderNumber}`}>Record manual refund<span aria-hidden="true"> →</span></NavLink>
              : <NavLink className="btn ghost sm" href={open(e.orderId)} aria-label={`View payment of order ${e.orderNumber}`}>View</NavLink>}</td>
          </tr>);
      })}
      </tbody></table></div>
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
              <td className="nowrap"><Link href={can(actor, 'orders.read') ? `/orders/${p.order_id}?tab=payment` : `/payments/${p.order_id}`} data-attempt-payment>{formatDateTime(p.created_at)}</Link></td>
              <td className="mono nowrap">{can(actor, 'orders.read') ? <Link className="row-link" href={`/orders/${p.order_id}?tab=payment`}>{p.order_number}</Link> : p.order_number}
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
              <td className="mono">{e.order_id ? (can(actor, 'orders.read') ? <Link className="row-link" href={`/orders/${e.order_id}?tab=payment`}>{e.order_number}</Link> : e.order_number) : '—'}</td>
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
