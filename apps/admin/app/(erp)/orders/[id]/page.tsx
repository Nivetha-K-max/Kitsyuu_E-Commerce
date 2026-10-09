/* One order: the control centre of the ERP (2026-10-07, order-centric architecture).

     header (number, stage, payment state, total, customer, channel, placed, the next action)
     tabs   Overview · Items · Payment · Fulfilment · Returns · Invoice · Activity

   Payment, Returns and Fulfilment are this order's own records: the Payments, Returns and Shipping queues open the same
   order on the matching tab, so there is one workflow for each, reached from two places. Every action here is an
   existing, server-checked one (status transitions, packing, tracking, COD, order edit, return steps, refunds, invoice);
   the page only decides which of them to offer for the order's current state. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { can } from '@kitsyuu/auth';
import { INDIAN_STATES, NotFoundError, paiseToRupees, uuid } from '@kitsyuu/contracts';
import { getOrder, getOrderPayment, getReturn, getShipmentDetail, listOrderEdits, orderCodState, orderEditOptions, orderEmails, orderOrigin, pricingView, returnSettings,
  settingsShipping, SHIPMENT_MOVES } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Entity, Facts, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import OrderStatusForm from '@/components/OrderStatusForm';
import { Drawer, MoreMenu, type MoreItem } from '@/components/overlays';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise, STATUS_LABEL } from '@/lib/format';
import { refundProvider } from '@/lib/payments';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { createInvoiceAction } from '../../finance/actions';
import { METHOD_LONG, PaymentPill, providerLabel } from '../../payments/payment-ui';
import { updateShipmentAction } from '../../shipping/actions';
import { codCancelAction, codCollectAction, editOrderAction, refundOrderEditAction, setPackingStateAction, startReturnAction, updateOrderStatusAction, updateShipmentTrackingAction } from '../actions';
import { flowIndex, ORDER_FLOW, orderStage, StagePill } from '../order-ui';
import { PaymentPanel } from './payment-panel';
import { ReturnPanel } from './return-panel';

export const metadata: Metadata = { title: 'Order' };
type Params = Promise<{ id: string }>;
type Search = Promise<{ tab?: string; return?: string }>;
const TABS = [['overview', 'Overview'], ['items', 'Items'], ['payment', 'Payment'], ['fulfilment', 'Fulfilment'], ['returns', 'Returns'], ['invoice', 'Invoice'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];
const rupees = (p: number) => `₹${paiseToRupees(p)}`;
const label = (s: string | null) => (s ? STATUS_LABEL[s] ?? s : '—');
/** How a cancelled order stands with money (M8): no money, money received (exception), or money received and refunded by hand. */
const CANCELLED_MONEY: Record<string, [string, string]> = {
  cancelled_unpaid: ['Cancelled · unpaid', 'No money was received for this order.'],
  cancelled_payment_exception: ['Cancelled · payment exception', 'Money was received after the order was cancelled. Record the manual refund on the Payment tab.'],
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
const words = (s: string) => s.replace(/_/g, ' ');
/** A return that still needs work (the rest are finished one way or another). */
const RETURN_CLOSED = ['completed', 'cancelled', 'rejected'];

export default async function OrderPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Order" crumbs={[{ href: '/orders', label: '← Back to orders' }]} /><Forbidden permission="orders.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!uuid.safeParse(id).success) notFound();
  const tab: Tab = TABS.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const d = await getOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const { order: o } = d;
  const base = `/orders/${o.id}`;
  const href = (t: Tab, hash = '') => `${t === 'overview' ? base : `${base}?tab=${t}`}${hash}`;

  const canStatus = can(actor, 'orders.update_status'), canCod = can(actor, 'orders.cod'), canBilling = !!d.billing;
  const canReturns = can(actor, 'returns.read'), manageReturns = can(actor, 'returns.manage'), canShipping = can(actor, 'shipping.read');
  const needsEdits = tab === 'overview' || tab === 'items' || tab === 'activity';
  // Every tab: the COD state, where the order came from, its returns and its shipment (for the header, the tab row and the next action).
  const [cod, origin, editing, returns, shipRow, rs, edits] = await Promise.all([
    orderCodState(db(), o.id), orderOrigin(db(), actor, o.id),
    can(actor, 'orders.edit') ? orderEditOptions(db(), actor, o.id, { shipping: settingsShipping(() => db()) }) : Promise.resolve(null),
    canReturns ? db().selectFrom('return_requests').select(['id', 'number', 'status', 'resolution', 'requested_at']).where('order_id', '=', o.id).orderBy('requested_at', 'desc').execute() : Promise.resolve([]),
    db().selectFrom('shipments').select(['id', 'status', 'in_transit_at', 'failed_at', 'failure_reason']).where('order_id', '=', o.id).executeTakeFirst(),
    canReturns ? returnSettings(db()) : Promise.resolve(null),
    needsEdits ? listOrderEdits(db(), o.id) : Promise.resolve([]),
  ]);
  const selectedReturn = returns.find(r => r.id === sp.return) ?? returns.find(r => !RETURN_CLOSED.includes(r.status)) ?? returns[0] ?? null;
  // Only the selected tab's own data.
  const [payment, shipment, ret, reasons, returnedRows, emails] = await Promise.all([
    tab === 'payment' && canBilling ? getOrderPayment(db(), actor, o.id) : Promise.resolve(null),
    (tab === 'fulfilment' || tab === 'activity') && shipRow && canShipping ? getShipmentDetail(db(), actor, shipRow.id) : Promise.resolve(null),
    tab === 'returns' && selectedReturn ? getReturn(db(), actor, selectedReturn.id) : Promise.resolve(null),
    tab === 'returns' && manageReturns ? db().selectFrom('return_reasons').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute() : Promise.resolve([]),
    tab === 'returns' && canReturns ? db().selectFrom('return_items as i').innerJoin('return_requests as r', 'r.id', 'i.return_id').select(['i.order_item_id', 'i.qty'])
      .where('r.order_id', '=', o.id).where('r.status', 'not in', ['rejected', 'cancelled']).execute() : Promise.resolve([]),
    tab === 'activity' ? orderEmails(db(), o.id) : Promise.resolve([]),
  ]);

  // ---- where the order is (display only: the transitions are the server's) ----
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
  const codReady = codDue && (o.status === 'shipped' || o.status === 'delivered');
  const intact = d.integrity.linesMatchUnitPrices && d.integrity.linesMatchSubtotal && d.integrity.totalCoversSubtotal;
  const issued = d.billing?.invoices.find(i => i.status === 'issued') ?? null;
  const canIssue = !issued && can(actor, 'finance.manage') && ['paid', 'processing', 'shipped', 'delivered'].includes(o.status);
  const refundedPaise = d.billing?.refunds.filter(r => r.status === 'processed').reduce((n, r) => n + r.amount_paise, 0) ?? 0;
  const refundsOpen = d.billing?.refunds.filter(r => r.status === 'requested' || r.status === 'pending').length ?? 0;
  const captured = d.billing?.payments.filter(p => ['captured', 'refunded', 'partially_refunded'].includes(p.status)) ?? [];
  const lastAttempt = d.billing?.payments.at(-1) ?? null;
  const refundDue = edits.filter(e => e.refund_due_paise > 0 && !e.refund_id);
  const openException = d.payment?.exceptions.find(e => !e.manualRefund) ?? null;
  const openReturn = returns.find(r => !RETURN_CLOSED.includes(r.status)) ?? null;
  // Returns (same rules as the return workflow itself): switched on with a window, a delivered order, inside the window.
  const deliveredAt = when('delivered');
  const returnUntil = rs?.enabled && rs.windowDays && deliveredAt ? new Date(new Date(deliveredAt).getTime() + rs.windowDays * 86_400_000) : null;
  const returnsOn = !!rs?.enabled && !!rs.windowDays;
  const returnOpenable = returnsOn && o.status === 'delivered' && !!returnUntil && returnUntil > new Date();
  const customerName = d.contact.name ?? d.contact.email ?? 'No customer details';
  const address = [d.shipping.name, d.shipping.line1, d.shipping.line2, [d.shipping.city, d.shipping.state, d.shipping.pin].filter(Boolean).join(', '), d.shipping.country].filter(Boolean);
  const lines = (a: { name?: string | null; line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; pin?: string | null; country?: string | null }) =>
    [a.name, a.line1, a.line2, [a.city, a.state, a.pin].filter(Boolean).join(', '), a.country].filter(Boolean) as string[];
  const channel = origin ? (origin.channel === 'retail' ? `${origin.pos_number ? 'POS · ' : ''}Offline · ${origin.branch}` : 'Online') : null;

  // ---- the next action: ONE primary step for the order's current state, from the transitions the server allows ----
  const quick = (to: 'processing' | 'delivered', text: string) => (
    <ActionForm action={updateOrderStatusAction} submitLabel={text} pendingLabel={to === 'processing' ? 'Starting…' : 'Marking delivered…'} id={`quick-${to}-form`} label={text} className="ord-quick"
      confirmText={`${text}: order ${o.orderNumber}?`}>
      <Hidden name="orderId" value={o.id} /><Hidden name="expectedStatus" value={o.status} /><Hidden name="toStatus" value={to} />
      <Hidden name="note" value="" />{/* the status form's note field: empty here (a note is only required when cancelling) */}
    </ActionForm>
  );
  let primary: ReactNode = null, next: ReactNode;
  if (off) next = <>This order is {st.label.toLowerCase()}. Nothing more can be done with it here.</>;
  else if (o.status === 'pending_payment' || o.status === 'payment_failed')
    next = <><b>Waiting for the customer to pay.</b> {o.status === 'payment_failed' ? 'The last payment attempt failed; the customer can try again. ' : ''}Payment is recorded by the checkout and cannot be marked paid here.{canStatus && allowed.includes('cancelled') ? ' The order can be cancelled from More.' : ''}</>;
  else if (o.status === 'delivered') {
    if (codDue) {
      next = <><b>Delivered. Cash still to collect: {rupees(cod!.toCollectPaise)}.</b> Record it once the courier or the customer has handed it over.{canCod ? '' : ' Recording the cash needs the orders.cod permission.'}</>;
      if (canCod) primary = <NavLink className="btn" href={href('payment', '#collect')} data-next="cod-collect">Record COD cash</NavLink>;
    } else if (openReturn) {
      next = <><b>Delivered. Return {openReturn.number} is open</b> ({words(openReturn.status)}). Continue it on the Returns tab.</>;
      primary = <NavLink className="btn" href={`${href('returns')}&return=${openReturn.id}`} data-next="return">Continue return</NavLink>;
    } else next = <><b>Delivered{cod?.status === 'collected' ? ' and paid in cash' : ''}.</b> Nothing more to do for this order.{returnOpenable && manageReturns ? ' A return or exchange can be started from the Returns tab.' : ''}</>;
  } else if (!canStatus) next = <span data-next="readonly">You can view this order. Moving it forward needs the orders.update_status permission.</span>;
  else if (o.status === 'paid' && allowed.includes('processing')) {
    next = <><b>Payment is confirmed.</b> Start packing to move the order into fulfilment.</>;
    primary = quick('processing', 'Start packing');
  } else if (o.status === 'processing' && packing !== 'packed') {
    next = <><b>The order is being packed.</b> Mark it packed when the parcel is ready for the courier.</>;
    primary = (
      <ActionForm action={setPackingStateAction} submitLabel="Mark as packed" pendingLabel="Marking packed…" id="quick-packed-form" label="Mark as packed" className="ord-quick">
        <Hidden name="orderId" value={o.id} /><Hidden name="packingState" value="packed" />
      </ActionForm>
    );
  } else if (o.status === 'processing' && allowed.includes('shipped')) {
    next = <><b>Packed and ready.</b> Hand it to the courier, then mark it shipped{codDue ? '. The cash is collected on delivery' : ''}.</>;
    primary = (
      <Drawer trigger="Mark shipped" name="ship" scope="ord" title={`Ship order ${o.orderNumber}`} description="Choose the courier. The tracking number is optional and can be added later.">
        <ActionForm action={updateOrderStatusAction} submitLabel="Ship order" pendingLabel="Marking shipped…" id="quick-ship-form" label="Ship order" className="form ord-ship" confirmText={`Mark order ${o.orderNumber} as shipped?`}>
          <Hidden name="orderId" value={o.id} /><Hidden name="expectedStatus" value={o.status} /><Hidden name="toStatus" value="shipped" /><Hidden name="note" value="" />
          {d.carriers.length > 0 && <>
            <Select name="carrierCode" label="Courier" options={d.carriers.map(c => ({ value: c.code, label: c.label }))} defaultValue={d.carriers[0]!.code} />
            <Field name="trackingNumber" label="Tracking number" hint="Optional. It can also be added later." />
          </>}
        </ActionForm>
      </Drawer>
    );
  } else if (o.status === 'shipped' && allowed.includes('delivered')) {
    next = <><b>With the courier.</b> Mark it delivered once the customer has the parcel{codDue ? '; then record the cash collected' : ''}.</>;
    primary = quick('delivered', 'Mark delivered');
  } else next = <>No step is available for this order right now.</>;

  // Secondary actions (useful now, not the main step) and More (rare or destructive: each opens the place that does it).
  const secondary: ReactNode[] = [];
  if (o.status === 'shipped' && codReady && canCod) secondary.push(<NavLink key="cod" className="btn ghost sm" href={href('payment', '#collect')} data-next="cod-collect">Record COD cash</NavLink>);
  if (o.status === 'delivered' && returnOpenable && manageReturns && !openReturn) secondary.push(<NavLink key="ret" className="btn ghost sm" href={href('returns', '#start-return')} data-next="start-return">Start return / exchange</NavLink>);
  if (refundDue.length > 0 && canBilling) secondary.push(<NavLink key="ref" className="btn ghost sm" href={href('payment', '#refunds')} data-link="refund-due">Refund due</NavLink>);
  const codCancellable = !!cod && codDue && (o.status === 'processing' || o.status === 'shipped') && canCod;
  const more: MoreItem[] = [
    { label: 'Packing slip', href: `${base}/packing-slip` },
    ...(issued && can(actor, 'finance.read') ? [{ label: 'Print invoice', href: `/finance/invoices/${issued.id}` }] : []),
    ...(editing && !editing.blocker ? [{ label: 'Edit order', href: href('items', '#edit-h') }] : []),
    ...(d.customer ? [{ label: 'Customer profile', href: `/customers/${d.customer.id}` }] : []),
    ...(origin?.pos_number ? [{ label: `POS bill ${origin.pos_number}`, href: `/pos/sale/${o.id}` }] : []),
    ...(canStatus && allowed.length > 0 ? [{ label: 'Change status with a note', href: href('fulfilment', '#st-h') }] : []),
    ...(canStatus && allowed.includes('cancelled') ? [{ label: 'Cancel order…', href: href('fulfilment', '#st-h'), danger: true }] : []),
    ...(codCancellable ? [{ label: o.status === 'processing' ? 'Cancel COD order…' : 'Parcel refused…', href: href('fulfilment', '#cod-h'), danger: true }] : []),
  ];

  const steps = (
    <ol className="ord-steps" data-off={off || undefined} data-order-flow={st.code}>
      {ORDER_FLOW.map((name, i) => {
        const state = off ? (i <= reached ? 'done' : 'skipped') : o.status === 'delivered' || i < reached ? 'done' : i === reached ? 'current' : 'upcoming';
        const at = state === 'done' || state === 'current' ? stepDates[i] : null;
        return <li key={name} data-state={state} aria-current={state === 'current' ? 'step' : undefined}><b>{name}</b><small>{at ? formatDateTime(at) : state === 'current' ? st.note ?? 'now' : ' '}</small></li>;
      })}
      {off && <li data-state="stopped" aria-current="step"><b>{st.label}</b><small>{formatDateTime(when(o.status))}</small></li>}
    </ol>
  );
  const paymentSummary = (
    <div className="ord-pay-sum" data-payment-summary={o.paymentMethod ?? 'online'}>
      <div className="ord-pay-top">
        <div><span className="ord-pay-method">{METHOD_LONG[o.paymentMethod ?? 'online'] ?? o.paymentMethod}</span><b className="ord-pay-amount" data-payment-amount>{rupees(o.totalPaise)}</b></div>
        <div className="ord-pay-state"><PaymentPill method={o.paymentMethod} paymentStatus={o.paymentStatus} codStatus={cod?.status ?? null} orderStatus={o.status} /></div>
      </div>
      <Facts items={[
        ...(cod ? [
          ...(cod.toCollectPaise > 0 ? [{ label: 'To collect', value: <span data-cod-to-collect><b>{rupees(cod.toCollectPaise)}</b> in cash on delivery</span> }] : []),
          ...(cod.collectedAt ? [{ label: 'Collected', value: <span data-cod-collected>{formatDateTime(cod.collectedAt)}{cod.reference && <span className="note mono"> · {cod.reference}</span>}</span> }] : []),
          { label: 'COD fee', value: cod.feePaise > 0 ? rupees(cod.feePaise) : 'None' },
        ] : [
          ...(canBilling && lastAttempt ? [{ label: 'Provider', value: <>{providerLabel(lastAttempt.provider)}{lastAttempt.method ? <span className="note"> · {lastAttempt.method}</span> : null}</> }] : []),
          ...(canBilling && captured[0]?.provider_payment_id ? [{ label: 'Reference', value: <span className="mono" data-payment-reference>{captured[0].provider_payment_id}</span> }] : []),
          ...(o.paidAt ? [{ label: 'Paid', value: formatDateTime(o.paidAt) }] : []),
        ]),
        ...(canBilling && d.billing!.payments.length > 1 ? [{ label: 'Attempts', value: `${d.billing!.payments.length} (${d.billing!.payments.filter(p => p.status === 'failed').length} failed)` }] : []),
        ...(refundedPaise > 0 ? [{ label: 'Refunded', value: <span data-payment-refunded>{rupees(refundedPaise)}</span> }] : []),
        ...(refundsOpen > 0 ? [{ label: 'Refunds', value: `${refundsOpen} waiting to be completed` }] : []),
      ]} />
    </div>
  );

  // One timeline (Activity): the order's status history with its payment events, edits, returns and delivery updates in between.
  type Moment = { at: Date; key: string; row?: string; title: string; meta: string; note?: string | null; kind: 'order' | 'payment' | 'edit' | 'return' | 'delivery' };
  const moments: Moment[] = tab !== 'activity' ? [] : [
    ...d.history.map(h => ({ at: new Date(h.created_at), key: `h${h.id}`, row: h.to_status, kind: 'order' as const,
      title: `${h.from_status ? `${stageName(h.from_status)} → ` : ''}${stageName(h.to_status)}`, meta: h.staff_email ?? (h.by_customer ? 'customer' : 'system'), note: h.note })),
    ...(d.billing?.payments ?? []).flatMap((p): Moment[] => p.provider === 'cod'
      ? [{ at: new Date(p.captured_at ?? p.created_at), key: `p${p.id}`, kind: 'payment', title: `Cash collected · ${rupees(p.amount_paise)}`, meta: 'cash on delivery' }]
      : p.status === 'failed' ? [{ at: new Date(p.created_at), key: `p${p.id}`, kind: 'payment', title: `Payment attempt failed · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider), note: p.failure_reason }]
      : p.captured_at ? [{ at: new Date(p.captured_at), key: `p${p.id}`, kind: 'payment', title: `Payment received · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider) }]
      : [{ at: new Date(p.created_at), key: `p${p.id}`, kind: 'payment', title: `Payment started · ${rupees(p.amount_paise)}`, meta: providerLabel(p.provider) }]),
    ...(d.billing?.refunds ?? []).map((r): Moment => ({ at: new Date(r.processed_at ?? r.created_at), key: `r${r.id}`, kind: 'payment',
      title: `Refund ${r.status === 'processed' ? 'made' : r.status === 'failed' ? 'failed' : r.status === 'pending' ? 'sent to the provider' : 'recorded'} · ${rupees(r.amount_paise)}`, meta: 'refund', note: r.reason })),
    ...edits.map((e): Moment => ({ at: new Date(e.created_at), key: `e${e.id}`, kind: 'edit', title: `Order edited · ${rupees(e.total_before)} → ${rupees(e.total_after)}`, meta: e.staff_email ?? 'staff', note: e.note })),
    ...returns.map((r): Moment => ({ at: new Date(r.requested_at), key: `t${r.id}`, kind: 'return', title: `Return ${r.number} requested`, meta: `now ${words(r.status)}` })),
    ...(shipment?.events ?? []).filter(e => ['in_transit', 'failed_delivery'].includes(e.status)).map((e): Moment => ({ at: new Date(e.created_at), key: `s${e.id}`, kind: 'delivery',
      title: e.status === 'in_transit' ? 'Parcel in transit' : 'Delivery failed', meta: e.staff_email ?? e.source, note: e.note })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Returns tab: what can still be returned (units bought minus units already in another return).
  const taken = new Map<string, number>();
  for (const r of returnedRows) taken.set(r.order_item_id, (taken.get(r.order_item_id) ?? 0) + r.qty);
  const returnable = d.items.map(i => ({ ...i, left: Math.max(0, i.qty - (taken.get(i.id) ?? 0)) })).filter(i => i.left > 0);
  const moves = shipRow ? SHIPMENT_MOVES[shipRow.status] ?? [] : [];
  const provider = refundProvider();

  return (
    <Entity module={{ href: '/orders', label: 'Orders' }} name="order" title={`Order ${o.orderNumber}`}
      status={<>
        <span className="head-status" data-order-status={o.status}><StagePill status={o.status} packingState={packing} /></span>
        <span className="head-status" {...(o.paymentStatus ? { 'data-payment-status': o.paymentStatus } : {})} data-payment-method={o.paymentMethod ?? undefined}>
          <PaymentPill method={o.paymentMethod} paymentStatus={o.paymentStatus} codStatus={cod?.status ?? null} orderStatus={o.status} note={false} /></span>
        {openException && <span className="head-status" data-payment-exception><StatusBadge status={openException.kind} /></span>}
      </>}
      factsAttr="data-order-facts"
      facts={[
        { label: 'Total', value: <b data-order-head-total>{rupees(o.totalPaise)}</b> },
        { label: 'Customer', value: d.customer ? <Link href={`/customers/${d.customer.id}`} data-customer-link>{customerName}</Link> : customerName },
        ...(channel ? [{ label: 'Channel', value: channel }] : []),
        { label: 'Placed', value: formatDateTime(o.createdAt) },
      ]}
      actions={<div className="ord-head-actions" data-order-actions={o.status}>{primary}{secondary}<MoreMenu items={more} /></div>}
      tabs={TABS.map(([tid, tl]) => ({ id: tid, label: tl, count: tid === 'returns' ? returns.length : undefined }))} current={tab} tabHref={t => href(t as Tab)}
      notice={d.payment?.cancelled && <p className={`msg ${d.payment.cancelled.kind === 'cancelled_payment_exception' ? 'error' : 'ok'}`} data-cancelled-money={d.payment.cancelled.kind}>
        <b>{CANCELLED_MONEY[d.payment.cancelled.kind]![0]}.</b> {CANCELLED_MONEY[d.payment.cancelled.kind]![1]}</p>}>

      {tab === 'overview' && <>
        <Section id="next-h" title="Progress" name="progress" wide>
          {steps}
          <p className="ord-now" data-next-step={o.status}>{next}</p>
          {(openException || refundDue.length > 0 || !intact || shipRow?.status === 'failed_delivery' || (openReturn && o.status !== 'delivered')) && (
            <ul className="ord-warnings" data-order-warnings>
              {openException && <li data-order-exceptions><StatusBadge status={openException.kind} /> A payment exception needs attention. <NavLink href={href('payment')}>Open the Payment tab</NavLink></li>}
              {refundDue.map(e => <li key={e.id} data-warning="refund-due">Refund due: <b>{rupees(e.refund_due_paise)}</b> after an order edit. {canBilling ? <NavLink href={href('payment', '#refunds')}>Make the refund on the Payment tab</NavLink> : 'Making it needs billing.read and refunds.create.'}</li>)}
              {!intact && <li data-warning="integrity">The recorded line totals do not add up. Amounts are shown exactly as recorded. <NavLink href={href('items')}>See the items</NavLink></li>}
              {shipRow?.status === 'failed_delivery' && <li data-warning="failed-delivery">The last delivery attempt failed{shipRow.failure_reason ? `: ${shipRow.failure_reason}` : ''}. <NavLink href={href('fulfilment')}>Open Fulfilment</NavLink></li>}
              {openReturn && o.status !== 'delivered' && <li data-warning="return">Return {openReturn.number} is open ({words(openReturn.status)}). <NavLink href={href('returns')}>Open Returns</NavLink></li>}
            </ul>
          )}
        </Section>
        <Section id="cust-h" title="Customer" name="customer">
          <Facts items={[
            { label: 'Name', value: d.contact.name ?? '—' }, { label: 'Email', value: d.contact.email ?? '—' }, { label: 'Phone', value: d.contact.phone ?? '—' },
            { label: 'Account', value: <span data-customer-account>{d.customer === undefined ? <span className="note">needs customers.read</span>
              : d.customer ? <><Link href={`/customers/${d.customer.id}`}>{d.customer.email}</Link> <StatusBadge status={d.customer.status} /></> : <span className="note">no account record</span>}</span> },
            { label: 'Ship to', value: <address className="ord-address">{address.length ? address.map((l, i) => <div key={i}>{l}</div>) : '—'}</address> },
            { label: 'Bill to', value: <address className="ord-address" data-billing>{d.billingAddress ? lines(d.billingAddress).map((l, i) => <div key={i}>{l}</div>) : 'Same as delivery'}</address> },
          ]} />
        </Section>
        <Section id="pay-h" title="Payment" name="billing" hint="A summary. Attempts, COD, refunds and the payment timeline are on the Payment tab.">
          {paymentSummary}
          <p className="ord-action-row"><NavLink className="btn ghost sm" href={href('payment')} data-link="view-payment">Open payment</NavLink></p>
        </Section>
        <Section id="tot-h" title="Totals" name="totals">
          <Facts attr="data-order-totals" items={[
            { label: `Items (${d.items.reduce((n, i) => n + i.qty, 0)})`, value: rupees(o.subtotalPaise) },
            ...(o.discountPaise > 0 ? [{ label: 'Discounts', value: `−${rupees(o.discountPaise)}` }] : []),
            { label: 'Delivery', value: rupees(o.shippingPaise) },
            ...(o.codFeePaise > 0 ? [{ label: 'COD fee', value: rupees(o.codFeePaise) }] : []),
            ...(!o.pricesIncludeTax ? [{ label: 'Tax', value: rupees(o.taxPaise) }] : []),
            { label: `Total${o.pricesIncludeTax ? ' (tax-inclusive)' : ''}`, value: <b>{rupees(o.totalPaise)}</b> },
          ]} />
        </Section>
        {origin && (
          <Section id="info-h" title="Order information" name="info">
            {/* 2026-10-01: online or offline (branch), created by staff from a draft, staff discount with its reason. */}
            <div data-order-origin={origin.channel}>
              <Facts items={[
                { label: 'Channel', value: <><b>{channel}</b>{origin.pos_number && <> · Bill <Link href={`/pos/sale/${id}`} data-order-pos>{origin.pos_number}</Link></>}</> },
                { label: 'Paid by', value: ({ online: 'online', cod: 'cash on delivery', cash: 'cash in store', card: 'card in store', upi: 'UPI in store' } as Record<string, string>)[origin.payment_method] ?? origin.payment_method },
                { label: 'Source', value: origin.created_by ? <>Created by {origin.created_by}{origin.draft_id ? <> from draft <Link href={`/drafts/${origin.draft_id}`}>{origin.draft_number}</Link></> : null}</> : 'Placed by the customer' },
                ...(() => { const pv = pricingView(origin.pricing); return [
                  ...(pv.delivery ? [{ label: pv.delivery.pickup ? 'Pickup' : 'Delivery', value: <span data-order-delivery>{pv.delivery.pickup ? 'Store pickup' : 'Delivery'}: {pv.delivery.label}{pv.delivery.estimate ? ` (${pv.delivery.estimate})` : ''}</span> }] : []),
                  ...(pv.discounts.length > 0 ? [{ label: 'Discounts', value: <span data-order-discounts>Discounts: {pv.discounts.map(x => `${x.label} −${formatPaise(x.amountPaise)}`).join('; ')}</span> }] : [])]; })(),
                ...(origin.staff_discount_paise > 0 ? [{ label: 'Staff', value: <span data-staff-discount>Staff discount {origin.staff_discount_bp! / 100}% ({formatPaise(origin.staff_discount_paise)}) on {formatPaise(origin.subtotal_paise)}: “{origin.staff_discount_reason}”, by {origin.discount_by ?? '—'}</span> }] : []),
                { label: 'Last change', value: formatDateTime(o.updatedAt) },
              ]} />
            </div>
          </Section>
        )}
      </>}

      {tab === 'items' && <>
        <Section id="items-h" title="Order items" name="items" wide meta={`${d.items.length}`}>
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
        </Section>

        {editing && (
          <Section id="edit-h" title="Edit order" name="order-edit" wide
            hint={editing.blocker ? undefined : <>Change sizes (only sizes at the same price) or quantities (0 removes a line), add a product, or change the delivery address, delivery option, contact details or staff discount. Each line keeps the price the customer paid; discounts, delivery (for a new address) and tax are worked out again on the server.
              {o.paymentMethod === 'cod' ? ' The new total is what is collected on delivery.' : ' A lower total leaves a refund due; a higher total cannot be saved (an extra payment cannot be collected).'}</>}>
            {editing.blocker ? <p className="note" data-edit-blocked>{editing.blocker}</p> : (
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
            )}
          </Section>
        )}

        {edits.length > 0 && (
          <Section id="edits-h" title="Edit history" name="order-edits" wide meta={`${edits.length}`}>
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
                        <p className="msg error">Refund due: {rupees(e.refund_due_paise)}.{canBilling && <> <NavLink href={href('payment', '#refunds')} data-link="refund-due">Make the refund on the Payment tab</NavLink></>}</p>
                        {/* Without billing.read the Payment tab has no refund list: the refund is made here (refunds.create). */}
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
          </Section>
        )}

        {d.stock && (
          <Section id="stk-h" title="Stock effect" name="stock" wide hint="Every stock movement this order caused, from the stock ledger.">
            {d.stock.length === 0 ? <p className="empty">This order has not moved any stock.</p> : (
              <div className="table-wrap"><table data-order-stock>
                <thead><tr><th>When</th><th>SKU</th><th className="num">Change</th><th>Reason</th><th className="num">Balance after</th><th>By</th></tr></thead>
                <tbody>{d.stock.map((m, i) => (
                  <tr key={i}><td>{formatDateTime(m.created_at)}</td><td className="mono">{m.sku}</td><td className="num">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td>{m.reason}</td><td className="num">{m.balance_after ?? '—'}</td><td>{m.staff_email ?? <span className="note">system</span>}</td></tr>))}
                </tbody></table></div>
            )}
          </Section>
        )}
      </>}

      {tab === 'payment' && (payment
        ? <PaymentPanel actor={actor} d={payment} returnsHref={href('returns')} />
        : <>
            {/* Without billing.read: the summary, and the one payment step an order needs (recording COD cash, orders.cod). */}
            <Section id="pay-h" title="Payment" name="billing">
              {paymentSummary}
              <p className="note" data-readonly="billing">Payment attempts, refunds and the payment timeline need the billing.read permission.</p>
            </Section>
            {codDue && (
              <Section id="collect" title="Cash on delivery" name="cod" hint="Recording the cash completes the payment. It does not change the order's stage.">
                {!canCod ? <p className="note" data-cod-readonly>Recording the cash needs the orders.cod permission.</p>
                  : !codReady ? <p className="note" data-cod-wait>The cash can be recorded once the order has been shipped or delivered.</p>
                  : (
                    <ActionForm action={codCollectAction} submitLabel="Record cash collected" pendingLabel="Recording…" id="cod-collect-form" label="Cash collected" confirmText={`Record ${rupees(o.totalPaise)} collected in cash for ${o.orderNumber}?`}>
                      <Hidden name="orderId" value={o.id} />
                      <div className="cols">
                        <Field name="amount" label="Amount collected (₹)" defaultValue={paiseToRupees(o.totalPaise)} hint="Must be the order total." />
                        <Field name="reference" label="Receipt / courier reference (optional)" />
                      </div>
                    </ActionForm>
                  )}
              </Section>
            )}
            {cod?.collectedAt && <p className="note" data-cod-activity>Cash on delivery collected {formatDateTime(cod.collectedAt)}.</p>}
          </>)}

      {tab === 'fulfilment' && <>
        <Section id="ful-h" title="Fulfilment" name="fulfilment" hint="Couriers are booked by hand; no courier service is connected.">
          <Facts attr="data-fulfilment" items={[
            { label: 'Stage', value: ['paid', 'processing', 'shipped', 'delivered'].includes(o.status) ? <StagePill status={o.status} packingState={packing} /> : <span className="note">Not in fulfilment ({st.label.toLowerCase()}{st.note ? `, ${st.note}` : ''})</span> },
            { label: 'Packing', value: <span data-packing-state>{d.shipment ? <StatusBadge status={d.shipment.packingState} /> : <span className="note">Not started</span>}</span> },
            ...(shipRow && !['pending', 'processing', 'packed'].includes(shipRow.status) ? [{ label: 'Shipment', value: <span data-shipment-status={shipRow.status}><StatusBadge status={shipRow.status} /></span> }] : []),
            { label: 'Courier', value: <span data-courier>{d.shipment?.shippedAt ? d.shipment.carrierLabel : '—'}</span> },
            { label: 'Tracking', value: <span data-tracking>{d.shipment?.trackingNumber
              ? (d.shipment.trackingUrl ? <a href={d.shipment.trackingUrl} rel="noopener noreferrer" target="_blank" className="mono">{d.shipment.trackingNumber}</a> : <span className="mono">{d.shipment.trackingNumber}</span>)
              : d.shipment?.shippedAt ? <span className="note">Tracking not provided</span> : '—'}</span> },
            { label: 'Shipped', value: <span data-shipped-at>{formatDateTime(d.shipment?.shippedAt)}</span> },
            ...(shipRow?.in_transit_at ? [{ label: 'In transit', value: formatDateTime(shipRow.in_transit_at as Date) }] : []),
            ...(shipRow?.failed_at ? [{ label: 'Delivery failed', value: `${formatDateTime(shipRow.failed_at as Date)}${shipRow.failure_reason ? ` — ${shipRow.failure_reason}` : ''}` }] : []),
            { label: 'Delivered', value: <span data-delivered-at>{formatDateTime(d.shipment?.deliveredAt)}</span> },
            { label: 'Deliver to', value: <address className="ord-address">{address.length ? address.map((l, i) => <div key={i}>{l}</div>) : '—'}</address> },
          ]} />
          <p className="ord-action-row"><Link className="btn ghost sm" href={`${base}/packing-slip`} data-link="packing-slip">Packing slip</Link></p>
        </Section>

        {canStatus && o.status === 'processing' && (
          <Section id="pack-h" title="Packing" name="packing" hint="Packing progress while the order is being prepared. It does not change the order's status.">
            <ActionForm action={setPackingStateAction} submitLabel="Save packing" pendingLabel="Saving…" id="packing-form" label="Packing progress" className="form inline">
              <Hidden name="orderId" value={o.id} />
              <Select name="packingState" label="Packing" options={PACKING_OPTIONS} defaultValue={d.shipment?.packingState ?? 'not_started'} />
            </ActionForm>
          </Section>
        )}
        {canStatus && (o.status === 'shipped' || o.status === 'delivered') && (
          <Section id="track-h" title="Courier and tracking" name="tracking" hint="Add or correct the courier and the tracking number. Tracking stays optional.">
            <ActionForm action={updateShipmentTrackingAction} submitLabel="Save tracking" pendingLabel="Saving…" id="tracking-form" label="Courier and tracking" className="form inline">
              <Hidden name="orderId" value={o.id} />
              <Select name="carrierCode" label="Courier" options={d.carriers.map(c => ({ value: c.code, label: c.label }))} defaultValue={d.shipment?.carrierCode ?? d.carriers[0]?.code} />
              <Field name="trackingNumber" label="Tracking number" defaultValue={d.shipment?.trackingNumber ?? ''} hint="Optional. Leave empty if the courier gave none." />
            </ActionForm>
          </Section>
        )}
        {shipRow && moves.length > 0 && (
          <Section id="del-h" title="Delivery update" name="shipment-update" hint="Record what the courier reports: in transit, a failed delivery, a new attempt, or delivered.">
            {!can(actor, 'shipping.manage') ? <p className="note">Recording delivery updates needs shipping.manage.</p> : (
              <ActionForm action={updateShipmentAction} submitLabel="Save update" pendingLabel="Saving…" id="shipment-update-form" label="Delivery update">
                <Hidden name="shipmentId" value={shipRow.id} />
                {/* courier and tracking are changed in "Courier and tracking" above: this form keeps them as they are */}
                <Hidden name="courierCode" value={d.shipment?.carrierCode ?? ''} /><Hidden name="trackingNumber" value={d.shipment?.trackingNumber ?? ''} />
                <Select name="status" label="Status" defaultValue={shipRow.status} options={[{ value: shipRow.status, label: `${words(shipRow.status)} (no change)` },
                  ...moves.map(m => ({ value: m, label: m === 'delivered' ? 'delivered (also marks the order delivered)' : m === 'in_transit' && shipRow.status === 'failed_delivery' ? 'in transit (new delivery attempt)' : words(m) }))]} />
                <Field name="failureReason" label="Why the delivery failed" hint="Needed when marking a failed delivery." />
                <TextArea name="note" label="Note (staff only)" rows={2} />
              </ActionForm>
            )}
          </Section>
        )}
        {shipment && shipment.events.length > 0 && (
          <Section id="se-h" title="Shipment history" name="shipment-events" wide>
            <ol className="timeline" data-shipment-events>{shipment.events.map(e => (
              <li key={e.id}><StatusBadge status={e.status} /> <span className="who">{formatDateTime(e.created_at as Date)} · {e.staff_email ?? e.source}</span>{e.note && <p className="msg-body">{e.note}</p>}</li>
            ))}</ol>
          </Section>
        )}

        <Section id="st-h" title="Change status" name="status" hint="The full status form: use it to cancel an order (a reason is required) or to add a note to the history. The next-step button above uses the same checks.">
          <div className="status-actions">
            {!canStatus ? <p className="note" data-readonly="status">Changing the status needs the orders.update_status permission.</p>
              : <OrderStatusForm action={updateOrderStatusAction} orderId={o.id} orderNumber={o.orderNumber} current={o.status} currentLabel={label(o.status)} allowed={d.allowedTransitions} carriers={d.carriers} />}
          </div>
        </Section>
        {/* A cash-on-delivery order is cancelled with its own checked step (before dispatch, or when the parcel is refused). */}
        {cod && codDue && (o.status === 'processing' || o.status === 'shipped') && (
          <Section id="cod-h" title={o.status === 'processing' ? 'Cancel this cash-on-delivery order' : 'Parcel refused by the customer'} name="cod-cancel"
            hint={o.status === 'processing' ? 'Before dispatch: the order is cancelled and its items go back to stock.' : 'The customer refused the parcel: nothing was collected and the order is cancelled.'}>
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
          </Section>
        )}
      </>}

      {tab === 'returns' && (!canReturns
        ? <StateBlock kind="denied" title="Returns need the returns.read permission">Ask an administrator for access to see this order&rsquo;s returns and exchanges.</StateBlock>
        : <>
            {returns.length > 1 && (
              <Section id="rets-h" title="Returns of this order" name="returns-list" wide meta={`${returns.length}`}>
                <div className="table-wrap"><table data-order-returns>
                  <thead><tr><th>Return</th><th>Status</th><th>Resolution</th><th>Requested</th></tr></thead>
                  <tbody>{returns.map(r => (
                    <tr key={r.id} data-order-return={r.number} aria-current={r.id === selectedReturn?.id ? 'true' : undefined}>
                      <td>{r.id === selectedReturn?.id ? <b className="mono">{r.number}</b> : <NavLink className="mono" href={`${href('returns')}&return=${r.id}`}>{r.number}</NavLink>}</td>
                      <td><StatusBadge status={r.status} /></td><td>{r.resolution ?? 'not decided'}</td><td className="nowrap">{formatDateTime(r.requested_at as Date)}</td>
                    </tr>))}
                  </tbody></table></div>
              </Section>
            )}
            {ret && <ReturnPanel actor={actor} data={ret} />}
            {returns.length === 0 && (
              <StateBlock title="No return or exchange for this order" name="returns">
                {!returnsOn ? 'Returns are not offered: all sales are final (Configuration → Returns).'
                  : o.status !== 'delivered' ? 'A return can be opened once the order has been delivered.'
                  : !returnOpenable ? `The ${rs!.windowDays}-day return window for this order has ended.`
                  : `A return can be opened until ${formatDateTime(returnUntil)}.`}
              </StateBlock>
            )}
            {manageReturns && returnOpenable && returnable.length > 0 && (
              <Section id="start-return" title="Start a return or exchange" name="start-return"
                hint={`Opens a return for this order on the customer's behalf. It then follows the normal steps (approve, receive, inspect, refund or exchange). Open until ${formatDateTime(returnUntil)}.`}>
                <ActionForm action={startReturnAction} submitLabel="Open return" pendingLabel="Opening…" id="start-return-form" label="Start a return or exchange">
                  <Hidden name="orderId" value={o.id} />
                  {returnable.map(i => <Field key={i.id} name={`qty_${i.id}`} label={`${i.name} · ${i.size} (can return ${i.left}) — quantity returned`} type="number" defaultValue="0" />)}
                  <Select name="reasonCode" label="Reason" options={reasons.map(r => ({ value: r.code, label: r.label }))} />
                  <TextArea name="description" label="Note (optional)" rows={2} />
                </ActionForm>
              </Section>
            )}
            {returns.length > 0 && manageReturns && !(returnOpenable && returnable.length > 0) && (
              <p className="note" data-return-closed>{!returnsOn ? 'New returns are switched off (Configuration → Returns).' : !returnOpenable ? 'No new return can be opened: the return window has ended or the order is not delivered.' : 'Every item of this order is already in a return.'}</p>
            )}
          </>)}

      {tab === 'invoice' && (!d.billing
        ? <StateBlock kind="denied" title="Invoices need the billing.read permission">Ask an administrator for access to see this order&rsquo;s invoice.</StateBlock>
        : <Section id="inv-h" title="Invoice" name="invoice" hint="The invoice is made from this order's own data; its numbering and GST split are the Finance module's.">
            {d.billing.invoices.length === 0 ? <p className="empty" data-no-invoice>{['paid', 'processing', 'shipped', 'delivered'].includes(o.status) ? 'No invoice has been issued for this order yet.' : 'An invoice can be issued once the order is paid.'}</p> : (
              <ul className="plain" data-invoices>{d.billing.invoices.map(i => (
                <li key={i.id}>{can(actor, 'finance.read') ? <Link className="mono" href={`/finance/invoices/${i.id}`}>{i.invoice_number ?? 'draft'}</Link> : <span className="mono">{i.invoice_number ?? 'draft'}</span>} <StatusBadge status={i.status} /> {rupees(i.total_paise)}
                  <span className="note"> · {i.prices_include_tax ? 'tax-inclusive' : 'tax added'} · tax {rupees(i.tax_paise)} · {formatDateTime(i.issued_at)}</span></li>))}
              </ul>
            )}
            {canIssue && <ActionForm action={createInvoiceAction} submitLabel="Issue invoice" id="issue-invoice-form" label="Issue the invoice for this order" className="inline-form">
              <Hidden name="orderId" value={o.id} /></ActionForm>}
            {issued && can(actor, 'finance.read') && <p className="ord-action-row"><Link className="btn ghost sm" href={`/finance/invoices/${issued.id}`} data-link="print-invoice">Open and print invoice</Link></p>}
            {!issued && !canIssue && ['paid', 'processing', 'shipped', 'delivered'].includes(o.status) && <p className="note">Issuing an invoice needs the finance.manage permission.</p>}
          </Section>)}

      {tab === 'activity' && <>
        {/* Who did what: the order's own status history (staff member, the customer, or the system), oldest first. */}
        <Section id="hist-h" title="Timeline" name="activity" wide hint="Status changes, payment events, order edits, returns and delivery updates of this order, oldest first.">
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
        </Section>
        {/* 2026-10-01: the customer emails of this order (sent / failed; none yet = pending or not applicable). */}
        <Section id="mail-h" title="Customer emails" name="emails">
          <p className="note" data-order-emails>Customer emails: {emails.length === 0 ? 'none sent yet' : emails.map(e => `${e.event.replace('.', ' ')} ${e.status === 'sent' ? 'sent' : 'FAILED'} ${formatDateTime(e.created_at as Date)}${e.error ? ` (${e.error})` : ''}`).join(' · ')}</p>
        </Section>
      </>}
    </Entity>
  );
}
