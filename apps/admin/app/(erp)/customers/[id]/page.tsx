/* One customer: the customer control centre (2026-10-07, same entity frame as the order).

     header (name, account status, email, phone, joined, orders, lifetime value, the main action)
     tabs   Overview · Orders · Payments · Returns · Loyalty · Support · Activity

   Orders, payments, returns and tickets are not copied here: each row opens the record where it is managed (the order
   and its Payment / Returns tab, the support ticket). Loyalty is the same balance and history as Customers → Loyalty.
   Shows safe account data only: the services never select password hashes, token hashes, IP addresses or user agents,
   and the admin database role cannot read the secret columns at all (migration 1800).

   2026-10-10: every read is a core service that checks its own permission (this page queries nothing itself), and a tab
   reads only what it shows. Payments also lists the payment attempts, refunds (billing.read) and invoices (finance.read)
   of the customer; Returns finds every return of the customer, whatever the age of the order; Orders and Payments page
   through all orders (?page=); Activity lists the emails sent to the customer. All of it read only. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { customerBasket, customerEmailLog, customerOrdersPage, customerOrderWorkflows, customerPayments, customerRecordCounts, customerReturnHistory, customerTickets,
  getCustomer, getCustomerLoyalty, listCustomerNotes, listInvoices, LOYALTY_KIND_LABELS, type CustomerPart } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, TextArea } from '@/components/forms';
import { Entity, Facts, Figures, Section, StateBlock } from '@/components/frame';
import { FilterLink, NavLink } from '@/components/NavFrame';
import { Drawer, MoreMenu, type MoreItem } from '@/components/overlays';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { pageOf } from '@/lib/erp';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { adjustPointsAction } from '../../loyalty/actions';
import { StagePill } from '../../orders/order-ui';
import { methodLabel, PaymentPill, providerLabel } from '../../payments/payment-ui';
import { addCustomerNoteAction, setCustomerStatusAction, updateCustomerContactAction } from '../actions';

export const metadata: Metadata = { title: 'Customer' };
type Params = Promise<{ id: string }>;
type Search = Promise<{ tab?: string; page?: string | string[] }>;
const TABS = [['overview', 'Overview'], ['orders', 'Orders'], ['payments', 'Payments'], ['returns', 'Returns'], ['loyalty', 'Loyalty'], ['support', 'Support'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];
const words = (s: string) => s.replace(/_/g, ' ');
const RETURN_CLOSED = ['completed', 'cancelled', 'rejected'];
const TICKET_CLOSED = ['resolved', 'closed'];
const channelOf = (o: { channel: string; pos_number: string | null }) => (o.channel === 'retail' ? (o.pos_number ? `POS ${o.pos_number}` : 'Offline') : 'Online');
/** Amounts are rupees throughout the platform; another currency recorded on a row is named next to the amount. */
const money = (paise: number, currency?: string | null) => `${formatPaise(paise)}${currency && currency !== 'INR' ? ` ${currency}` : ''}`;
/** What each tab reads of the customer record itself (getCustomer). */
const PARTS: Record<Tab, CustomerPart[]> = { overview: ['orders', 'addresses', 'sessions', 'audit'], orders: [], payments: [], returns: [], loyalty: [], support: [], activity: ['orders', 'sessions', 'audit'] };
const EMAIL_LABEL: Record<string, string> = {
  'order.placed': 'Order confirmation', 'order.packed': 'Order packed', 'order.shipped': 'Order shipped', 'order.tracking': 'Tracking details', 'order.delivered': 'Order delivered',
  'order.cancelled': 'Order cancelled', 'order.payment_request': 'Payment request', 'return.status': 'Return update', 'refund.processed': 'Refund processed',
  'payment.failed': 'Payment failed', 'payment.pending': 'Payment pending', 'support.reply': 'Support reply', 'cart.reminder': 'Cart reminder',
  'checkout.reminder': 'Checkout reminder', 'cart.auto_reminder': 'Cart reminder (automatic)',
};

export default async function CustomerPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const actor = await requireActor();
  if (!can(actor, 'customers.read')) return <><PageHead section="Commerce" title="Customer" crumbs={[{ href: '/customers', label: '← Back to customers' }]} /><Forbidden permission="customers.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!uuid.safeParse(id).success) notFound();
  const tab: Tab = TABS.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const page = pageOf(sp.page);
  const d = await getCustomer(db(), actor, id, { parts: PARTS[tab] }).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const c = d.customer;
  const canOrders = can(actor, 'orders.read'), canReturns = can(actor, 'returns.read'), canSupport = can(actor, 'support.read'), canLoyalty = can(actor, 'loyalty.read');
  const canBilling = can(actor, 'billing.read'), canFinance = can(actor, 'finance.read');
  const on = (...tabs: Tab[]) => tabs.includes(tab);
  // The related records of this customer (read only; each is managed where it lives). Every read is a core service that
  // checks its own permission; a tab asks only for what it shows.
  const [counts, notes, basket, loyalty, flows, orderPage, paid, invoices, returnList, tickets, emails] = await Promise.all([
    customerRecordCounts(db(), actor, id),
    on('overview', 'activity') ? listCustomerNotes(db(), actor, id) : Promise.resolve([]),
    on('overview') ? customerBasket(db(), actor, id) : Promise.resolve(null),
    on('overview', 'loyalty', 'activity') && canLoyalty ? getCustomerLoyalty(db(), actor, id) : Promise.resolve(null),
    on('orders') && canOrders ? customerOrderWorkflows(db(), actor, id) : Promise.resolve(null),
    on('orders', 'payments') && canOrders ? customerOrdersPage(db(), actor, id, { page }) : Promise.resolve(null),
    on('payments') && canBilling ? customerPayments(db(), actor, id) : Promise.resolve(null),
    on('payments') && canFinance ? listInvoices(db(), actor, { customerId: id, status: 'all', page: 1 }) : Promise.resolve(null),
    on('overview', 'returns', 'activity') && canReturns ? customerReturnHistory(db(), actor, id, { lines: on('returns') }) : Promise.resolve(null),
    on('overview', 'support', 'activity') && canSupport ? customerTickets(db(), actor, id) : Promise.resolve([]),
    on('activity') && canOrders ? customerEmailLog(db(), actor, id) : Promise.resolve(null),
  ]);
  const returns = returnList?.rows ?? [];
  const base = `/customers/${c.id}`;
  const href = (t: Tab, hash = '') => `${t === 'overview' ? base : `${base}?tab=${t}`}${hash}`;
  const pageHref = (t: Tab, n: number) => (n > 1 ? `${base}?tab=${t}&page=${n}` : href(t));
  const orderLink = (orderId: string, t?: 'payment' | 'returns', extra = '') => `/orders/${orderId}${t ? `?tab=${t}${extra}` : ''}`;
  /** Newer / older for the orders of the Orders and Payments tabs (25 a page, newest first). */
  const pager = (t: Tab) => orderPage && (orderPage.page > 1 || orderPage.hasNext) && (
    <nav className="pager" aria-label="Order pages" data-customer-pager>
      {orderPage.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={pageHref(t, orderPage.page - 1)} data-page-newer>← Newer</FilterLink> : <span />}
      <span className="pager-page" data-page-current>Page {orderPage.page}</span>
      {orderPage.hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={pageHref(t, orderPage.page + 1)} data-page-older>Older →</FilterLink> : <span />}
    </nav>
  );
  /** A page number past the last page: say so and offer the first page (never an error). */
  const pastEnd = (t: Tab) => <StateBlock title="No orders on this page" name="customer-orders-page" action={<NavLink className="btn ghost sm" href={href(t)}>First page</NavLink>}>This customer has {formatNumber(d.summary.ordersCount)} order{d.summary.ordersCount === 1 ? '' : 's'}; page {page} is past the last one.</StateBlock>;

  const activeSessions = d.sessions.filter(s => s.active).length;
  const disabling = c.status === 'active';
  const name = c.fullName || c.email;
  const openReturns = returns.filter(r => !RETURN_CLOSED.includes(r.status));
  const openTickets = tickets.filter(t => !TICKET_CLOSED.includes(t.status));
  const codDue = d.orders.filter(o => o.payment_method === 'cod' && o.cod_status === 'to_collect' && o.status !== 'cancelled');
  const failed = d.orders.filter(o => o.payment_status === 'failed' && o.status !== 'cancelled');
  const refunded = d.orders.filter(o => o.payment_status === 'refunded' || o.payment_status === 'partially_refunded');
  const refundPending = returns.filter(r => r.status === 'refund_pending');

  // ---- header: one main action for this customer's current state; rare and account actions under More ----
  const canDraft = can(actor, 'orders.create') && c.status === 'active';
  const primary: ReactNode = canDraft ? <Link className="btn" href={`/drafts?customer=${c.id}#dn-h`} data-link="new-draft">New draft order</Link> : null;
  const more: MoreItem[] = [
    ...(d.canManage ? [{ label: 'Edit contact details', href: href('overview', '#prof-h') }] : []),
    ...(can(actor, 'customers.note') ? [{ label: 'Add a service note', href: href('overview', '#notes-h') }] : []),
    ...(can(actor, 'loyalty.adjust') ? [{ label: 'Add or remove points', href: href('loyalty', '#loy-adjust') }] : []),
    ...(can(actor, 'support.manage') ? [{ label: 'New support ticket', href: '/support/new' }] : []),
    ...(d.canManage ? [{ label: disabling ? 'Disable account…' : 'Enable account…', href: href('overview', '#acc-h'), danger: disabling }] : []),
  ];

  // ---- one timeline (Activity): what happened with this customer, from the recorded rows, newest first ----
  type Moment = { at: Date; key: string; kind: string; title: ReactNode; meta?: string | null; note?: string | null };
  const moments: Moment[] = tab !== 'activity' && tab !== 'overview' ? [] : [
    { at: c.createdAt, key: 'joined', kind: 'account', title: 'Account created' },
    ...d.orders.map((o): Moment => ({ at: new Date(o.created_at), key: `o${o.id}`, kind: 'order',
      title: <>Order {canOrders ? <NavLink href={orderLink(o.id)}>{o.order_number}</NavLink> : o.order_number} placed · {formatPaise(o.total_paise)}</>, meta: channelOf(o) })),
    ...(canOrders ? d.orders.filter(o => o.paid_at) : []).map((p): Moment => ({ at: new Date(p.paid_at as Date), key: `p${p.id}`, kind: 'payment',
      title: <>Payment received for <NavLink href={orderLink(p.id, 'payment')}>{p.order_number}</NavLink></>, meta: methodLabel(p.payment_method) })),
    ...returns.map((r): Moment => ({ at: new Date(r.requested_at as Date), key: `r${r.id}`, kind: 'return',
      title: <>Return {canOrders ? <NavLink href={orderLink(r.order_id, 'returns', `&return=${r.id}`)}>{r.number}</NavLink> : r.number} requested</>, meta: `now ${words(r.status)}`, note: r.reason })),
    ...tickets.map((t): Moment => ({ at: new Date(t.created_at as Date), key: `t${t.id}`, kind: 'support',
      title: <>Support ticket <Link href={`/support/${t.id}`}>{t.number}</Link> opened</>, meta: `now ${words(t.status)}`, note: t.subject })),
    // loyalty changes tied to an order are part of that order's story; the ones made by hand, imported or expired are events of their own
    ...(loyalty?.rows ?? []).filter(t => !t.order_id).map((t): Moment => ({ at: new Date(t.created_at as Date), key: `l${t.id}`, kind: 'loyalty',
      title: `${LOYALTY_KIND_LABELS[t.kind] ?? t.kind}: ${t.points > 0 ? '+' : ''}${t.points} points`, meta: t.staff_email, note: t.reason })),
    ...notes.map((n): Moment => ({ at: new Date(n.created_at as Date), key: `n${n.id}`, kind: 'note', title: 'Service note added', meta: n.author ?? 'staff', note: n.body })),
    // staff actions on the account from the audit log (notes and point changes are already listed above)
    ...(d.audit ?? []).filter(a => a.entity_type === 'customers' && !/note|loyalty|points/.test(a.action)).map((a): Moment => ({ at: new Date(a.occurred_at), key: `a${a.id}`, kind: 'staff',
      title: <span className="mono">{a.action}</span>, meta: a.staff_email ?? a.actor_type })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const timeline = (rows: Moment[]) => (
    <ol className="timeline" data-customer-activity>
      {rows.map(m => (
        <li key={m.key} data-timeline={m.kind}>
          <b>{m.title}</b>
          <span className="note"> · {formatDateTime(m.at)}{m.meta ? ` · ${m.meta}` : ''}</span>
          {m.note && <div className="note">{m.note}</div>}
        </li>
      ))}
    </ol>
  );
  const denied = (permission: string, what: string) => <StateBlock kind="denied" title={`${what} need the ${permission} permission`}>Ask an administrator for access.</StateBlock>;

  return (
    <Entity module={{ href: '/customers', label: 'Customers' }} name="customer" title={name}
      status={<span className="head-status" data-customer-status={c.status}><StatusBadge status={c.status} /></span>}
      factsAttr="data-customer-facts"
      facts={[
        { label: 'Email', value: c.email },
        ...(c.phone ? [{ label: 'Phone', value: c.phone }] : []),
        { label: 'Joined', value: formatDateTime(c.createdAt) },
        { label: 'Orders', value: <span data-kpi="Orders">{formatNumber(d.summary.ordersCount)}</span> },
        { label: 'Lifetime value', value: <b data-kpi="Lifetime value">{formatPaise(d.summary.lifetimeValuePaise)}</b> },
      ]}
      actions={<div className="ord-head-actions" data-customer-actions>{primary}<MoreMenu items={more} /></div>}
      tabs={TABS.map(([tid, tl]) => ({ id: tid, label: tl, count: tid === 'orders' ? d.summary.ordersCount : tid === 'returns' ? counts.returns ?? undefined : tid === 'support' ? counts.tickets ?? undefined : undefined }))}
      current={tab} tabHref={t => href(t as Tab)}
      notice={c.status !== 'active' ? <p className="msg error" data-customer-disabled><b>This account is {words(c.status)}.</b> The customer cannot sign in or place orders until it is enabled again.</p> : undefined}>

      {tab === 'overview' && <>
        {(codDue.length > 0 || failed.length > 0 || refundPending.length > 0 || openReturns.length > 0 || openTickets.length > 0) && (
          <Section id="att-h" title="Needs attention" name="attention" wide>
            <ul className="ord-warnings" data-customer-attention>
              {codDue.map(o => <li key={`c${o.id}`}>Cash on delivery still to collect for <NavLink href={orderLink(o.id, 'payment', '#collect')}>{o.order_number}</NavLink> ({formatPaise(o.total_paise)}).</li>)}
              {failed.map(o => <li key={`f${o.id}`}>The payment for <NavLink href={orderLink(o.id, 'payment')}>{o.order_number}</NavLink> failed; the customer can try again.</li>)}
              {openReturns.map(r => <li key={`r${r.id}`}>Return <NavLink href={orderLink(r.order_id, 'returns', `&return=${r.id}`)}>{r.number}</NavLink> is open ({words(r.status)}).</li>)}
              {openTickets.map(t => <li key={`t${t.id}`}>Support ticket <Link href={`/support/${t.id}`}>{t.number}</Link> is {words(t.status)}: {t.subject}</li>)}
            </ul>
          </Section>
        )}
        <Section id="prof-h" title="Contact" name="profile" hint="The email is the customer's login and is not changed here.">
          <Facts items={[
            { label: 'Name', value: c.fullName || '—' },
            { label: 'Email', value: <>{c.email} {c.emailVerifiedAt ? <span className="note">verified {formatDateTime(c.emailVerifiedAt)}</span> : <span className="note">not verified</span>}</> },
            { label: 'Mobile', value: c.phone ?? '—' },
            { label: 'Joined', value: formatDateTime(c.createdAt) },
          ]} />
          {d.canManage ? (
            <Drawer trigger="Edit contact details" triggerClass="btn ghost sm" name="contact" scope="ord" title="Contact details" description="Correct the name or mobile number. Every change is recorded in the audit log.">
              <ActionForm action={updateCustomerContactAction} submitLabel="Save contact details" pendingLabel="Saving…" id="customer-contact-form" label="Customer contact details">
                <Hidden name="customerId" value={c.id} />
                <Field name="fullName" label="Name" defaultValue={c.fullName ?? ''} />
                <Field name="phone" label="Mobile number" type="tel" defaultValue={c.phone ?? ''} hint="10-digit Indian mobile number, or leave empty." />
              </ActionForm>
            </Drawer>
          ) : <p className="note" data-readonly="customer">Changing customer accounts needs the customers.manage permission.</p>}
        </Section>
        <Section id="acc-h" title="Account" name="account" hint="Disabling ends every session at once; the customer cannot log in until the account is enabled again.">
          <Facts items={[
            { label: 'Status', value: <StatusBadge status={c.status} /> },
            { label: 'Sign-in', value: c.platformLogin ? 'Store account (email and password)' : 'Account from before the M6 login (password not yet set here)' },
            { label: 'Last login', value: formatDateTime(c.lastLoginAt) },
            { label: 'Active sessions', value: <span data-active-sessions>{activeSessions}</span> },
          ]} />
          {d.canManage && (
            <Drawer trigger={disabling ? 'Disable account…' : 'Enable account…'} triggerClass={`btn ghost sm${disabling ? ' danger' : ''}`} name="status" scope="ord" title={disabling ? 'Disable this account' : 'Enable this account'}
              description={disabling ? 'The customer is signed out everywhere and cannot log in until the account is enabled again.' : 'The customer can log in again.'}>
              <ActionForm action={setCustomerStatusAction} id="customer-status-form" label={disabling ? 'Disable account' : 'Enable account'}
                submitLabel={disabling ? 'Disable account' : 'Enable account'} pendingLabel="Saving…" variant={disabling ? 'danger' : undefined}
                confirmText={disabling ? `Disable ${c.email}? They are signed out everywhere and cannot log in until the account is enabled again.` : `Enable ${c.email}?`}>
                <Hidden name="customerId" value={c.id} />
                <Hidden name="expectedStatus" value={c.status} />
                <Hidden name="status" value={disabling ? 'disabled' : 'active'} />
                <TextArea name="note" label="Reason (kept in the audit log)" rows={2} required />
              </ActionForm>
            </Drawer>
          )}
        </Section>
        <Section id="sum-h" title="Orders" name="summary" hint={d.orders.length > 0 ? <NavLink href={href('orders')}>All orders of this customer</NavLink> : undefined}>
          <div data-customer-kpis>
            <Figures items={[
              { label: 'Orders', value: formatNumber(d.summary.ordersCount), note: `${formatNumber(d.summary.paidOrdersCount)} paid` },
              { label: 'Lifetime value', value: formatPaise(d.summary.lifetimeValuePaise), note: 'paid orders' },
              { label: 'Last order', value: d.summary.lastOrderAt ? formatDateTime(d.summary.lastOrderAt) : '—' },
            ]} />
          </div>
          {d.orders.length === 0 ? <p className="empty">This customer has not placed an order.</p> : (
            <ul className="plain cust-recent" data-recent-orders>{d.orders.slice(0, 3).map(o => (
              <li key={o.id}>{canOrders ? <NavLink className="mono" href={orderLink(o.id)}>{o.order_number}</NavLink> : <span className="mono">{o.order_number}</span>} <StagePill status={o.status} packingState={o.packing_state} />
                <span className="note"> {formatPaise(o.total_paise)} · {formatDateTime(o.created_at)}</span></li>))}
            </ul>
          )}
        </Section>
        {(canOrders || canReturns || canLoyalty || canSupport) && (
          <Section id="rel-h" title="Related records" name="related" hint="Each opens the tab that lists them; the work is done on the order or the ticket.">
            <Facts attr="data-customer-related" items={[
              ...(canOrders ? [{ label: 'Payments', value: <><NavLink href={href('payments')}>{codDue.length ? `${codDue.length} COD to collect` : failed.length ? `${failed.length} failed` : 'Nothing waiting'}</NavLink>{refunded.length > 0 && <span className="note"> · {refunded.length} refunded</span>}</> }] : []),
              ...(canReturns ? [{ label: 'Returns', value: <NavLink href={href('returns')}>{returns.length === 0 ? 'None' : `${openReturns.length} open of ${returns.length}`}</NavLink> }] : []),
              ...(loyalty ? [{ label: 'Loyalty', value: <NavLink href={href('loyalty')}>{formatNumber(loyalty.balance)} points available</NavLink> }] : []),
              ...(canSupport ? [{ label: 'Support', value: <NavLink href={href('support')}>{tickets.length === 0 ? 'No tickets' : `${openTickets.length} open of ${tickets.length}`}</NavLink> }] : []),
            ]} />
          </Section>
        )}
        <Section id="addr-h" title="Saved addresses" name="addresses">
          {d.addresses.length === 0 ? <p className="empty">No saved addresses.</p> : (
            <ul className="plain" data-addresses>{d.addresses.map(a => (
              <li key={a.id}>{a.is_default && <span className="badge">Default</span>}<b>{a.full_name}</b> <span className="note">{a.phone}</span>
                <div>{[a.line1, a.line2, `${a.city}, ${a.state} ${a.pin}`, a.country].filter(Boolean).join(' · ')}</div></li>))}
            </ul>
          )}
        </Section>
        <Section id="basket-h" title="Cart and wishlist now" name="basket" hint={can(actor, 'carts.read') ? <Link href="/carts">Carts &amp; wishlists of every customer</Link> : undefined}>
          <Facts items={[
            { label: 'Cart', value: basket?.cart.length ? <ul className="plain" data-cart>{basket.cart.map(i => <li key={i.id}>{i.name} · size {i.size} × {i.qty} <span className="note mono">{i.sku}</span></li>)}</ul> : <span className="note">The cart is empty.</span> },
            { label: 'Wishlist', value: basket?.wishlist.length ? <ul className="plain" data-wishlist>{basket.wishlist.map(i => <li key={i.id}>{i.name} <span className="note mono">{i.sku}</span></li>)}</ul> : <span className="note">The wishlist is empty.</span> },
          ]} />
        </Section>
        <Section id="notes-h" title="Service notes" name="notes" hint="Internal only; the customer never sees them.">
          {notes.length ? <ul className="plain notes-list" data-notes>{notes.map(n => (
            <li key={n.id}><p className="note-body">{n.body}</p><span className="note">{n.author ?? 'staff'} · {formatDateTime(n.created_at as Date)}</span></li>
          ))}</ul> : <p className="empty" data-empty="notes">No notes yet.</p>}
          {can(actor, 'customers.note') && (
            <ActionForm action={addCustomerNoteAction} submitLabel="Add note" id="note-form" label="Add a note" resetOnSuccess>
              <Hidden name="customerId" value={id} />
              <TextArea name="body" label="Note" rows={3} required />
            </ActionForm>
          )}
        </Section>
        <Section id="recent-h" title="Recent activity" name="recent" wide hint={<NavLink href={href('activity')}>All activity</NavLink>}>
          {timeline(moments.slice(0, 5))}
        </Section>
      </>}

      {tab === 'orders' && (!canOrders ? denied('orders.read', 'Orders') : <>
        <Section id="ord-h" title="Orders" name="orders" wide meta={formatNumber(d.summary.ordersCount)} hint="Newest first, 25 a page. An order opens in Orders, where it is managed.">
          {!orderPage || orderPage.rows.length === 0 ? (page > 1 ? pastEnd('orders') : <StateBlock title="No orders" name="customer-orders">This customer has not placed an order.</StateBlock>) : (
            <div className="table-wrap"><table data-customer-orders>
              <thead><tr><th>Order</th><th>Placed</th><th>Stage</th><th>Payment</th><th className="num">Total</th></tr></thead>
              <tbody>{orderPage.rows.map(o => (
                <tr key={o.id} data-order-row={o.order_number}>
                  <td className="mono"><NavLink className="row-link" href={orderLink(o.id)}>{o.order_number}</NavLink><div className="note" data-order-channel={o.channel}>{channelOf(o)}</div></td>
                  <td className="nowrap">{formatDateTime(o.created_at)}</td>
                  <td><StagePill status={o.status} packingState={o.packing_state} /></td>
                  <td><PaymentPill method={o.payment_method} paymentStatus={o.payment_status} codStatus={o.cod_status} orderStatus={o.status} note={false} /></td>
                  <td className="num money">{money(o.total_paise, o.currency)}</td>
                </tr>))}
              </tbody></table></div>
          )}
          {pager('orders')}
        </Section>
        {/* 2026-10-01: draft orders, abandoned checkouts (placed, not paid) and every discount on this customer's orders. */}
        {flows && flows.drafts.length > 0 && (
          <Section id="cdr-h" title="Draft orders" name="customer-drafts" wide meta={`${flows.drafts.length}`}>
            <div className="table-wrap"><table data-customer-drafts>
              <thead><tr><th>Draft</th><th>Updated</th><th className="num">Units</th><th>Status</th></tr></thead>
              <tbody>{flows.drafts.map(x => (
                <tr key={x.id}><td className="mono"><Link className="row-link" href={`/drafts/${x.id}`}>{x.number}</Link></td><td className="nowrap">{formatDateTime(x.updated_at as Date)}</td>
                  <td className="num">{formatNumber(x.units)}</td><td>{x.status === 'confirmed' && x.order_id ? <Link href={`/orders/${x.order_id}`}>{x.order_number}</Link> : <StatusBadge status={x.status === 'open' ? 'draft' : x.status} />}</td></tr>))}
              </tbody></table></div>
          </Section>
        )}
        {flows && flows.unpaid.length > 0 && (
          <Section id="cab-h" title="Abandoned checkouts" name="customer-abandoned" wide meta={`${flows.unpaid.length}`} hint="Orders placed and not paid (the items are held until the payment time runs out).">
            <div className="table-wrap"><table data-customer-abandoned>
              <thead><tr><th>Order</th><th>Placed</th><th className="num">Units</th><th className="num">Total</th><th>Reminder</th></tr></thead>
              <tbody>{flows.unpaid.map(x => (
                <tr key={x.id}><td className="mono"><Link className="row-link" href={`/orders/${x.id}`}>{x.order_number}</Link></td><td className="nowrap">{formatDateTime(x.created_at as Date)}</td>
                  <td className="num">{formatNumber(x.units)}</td><td className="num money">{formatPaise(x.total_paise)}</td>
                  <td>{x.reminder_status ? `${x.reminder_status}${x.reminder_sent_at ? ' ' + formatDateTime(x.reminder_sent_at as Date) : ''}` : 'Not sent'}</td></tr>))}
              </tbody></table></div>
          </Section>
        )}
        {flows && flows.discounts.length > 0 && (
          <Section id="cdi-h" title="Discount history" name="customer-discounts" wide meta={`${flows.discounts.length}`}>
            <div className="table-wrap"><table data-customer-discounts>
              <thead><tr><th>When</th><th>Order</th><th>Discount</th><th className="num">Amount</th><th>By</th></tr></thead>
              <tbody>{flows.discounts.map((x, i) => (
                <tr key={i} data-discount-kind={x.kind}><td className="nowrap">{formatDateTime(x.at)}</td><td className="mono"><Link href={`/orders/${x.orderId}`}>{x.orderNumber}</Link></td>
                  <td>{x.label}</td><td className="num money">−{formatPaise(x.amountPaise)}</td><td>{x.by ?? '—'}</td></tr>))}
              </tbody></table></div>
          </Section>
        )}
      </>)}

      {tab === 'payments' && <>
        {!canOrders ? denied('orders.read', 'Payments by order') : (
        <Section id="pay-h" title="Payments" name="payments" wide meta={formatNumber(d.summary.ordersCount)} hint="One line per order: how it is paid and where the money stands. A row opens the order on its Payment tab, where payments are handled.">
          {!orderPage || orderPage.rows.length === 0 ? (page > 1 ? pastEnd('payments') : <StateBlock title="No payments" name="customer-payments">A payment appears here for every order this customer places.</StateBlock>) : (
            <div className="table-wrap"><table data-customer-payments>
              <thead><tr><th>Payment for</th><th>Method</th><th>Status</th><th className="num">Amount</th><th>Date (IST)</th><th>Next step</th></tr></thead>
              <tbody>{orderPage.rows.map(o => {
                const due = o.payment_method === 'cod' && o.cod_status === 'to_collect' && o.status !== 'cancelled';
                const collect = due && can(actor, 'orders.cod') && (o.status === 'shipped' || o.status === 'delivered');
                return (
                  <tr key={o.id} data-payment-of={o.order_number}>
                    <td className="mono"><NavLink className="row-link" href={orderLink(o.id, 'payment')} aria-label={`Payment for order ${o.order_number}`}>{o.order_number}</NavLink></td>
                    <td>{methodLabel(o.payment_method)}</td>
                    <td><PaymentPill method={o.payment_method} paymentStatus={o.payment_status} codStatus={o.cod_status} orderStatus={o.status} note={false} /></td>
                    <td className="num money">{money(o.total_paise, o.currency)}</td>
                    <td className="nowrap">{formatDateTime(o.paid_at ?? o.created_at)}<div className="note">{o.paid_at ? 'paid' : 'order placed'}</div></td>
                    <td data-next-step>{collect ? <NavLink className="btn sm" href={orderLink(o.id, 'payment', '#collect')}>Record COD cash<span aria-hidden="true"> →</span></NavLink>
                      : <NavLink className="btn ghost sm" href={orderLink(o.id, 'payment')}>View</NavLink>}</td>
                  </tr>);
              })}</tbody></table></div>
          )}
          {pager('payments')}
        </Section>)}
        {/* 2026-10-10: what was actually recorded. An order can have several attempts (failed, then paid) or none (cash on
            delivery not collected yet); a refund is listed whether or not it came from a return. */}
        {!paid ? denied('billing.read', 'Payment attempts and refunds') : <>
          <Section id="pat-h" title="Payment attempts" name="payment-attempts" wide meta={`${paid.attempts.length}${paid.attemptsMore ? '+' : ''}`} hint="Every attempt recorded for this customer's orders, newest first: failed and successful ones each have their own line. A row opens the order on its Payment tab.">
            {paid.attempts.length === 0 ? <StateBlock title="No payment attempts" name="customer-attempts">No payment has been recorded for this customer's orders. Cash on delivery has no payment record until the cash is recorded.</StateBlock> : (
              <div className="table-wrap"><table data-customer-attempts>
                <thead><tr><th>Date (IST)</th><th>Order</th><th>Through</th><th>Reference</th><th>Status</th><th className="num">Amount</th></tr></thead>
                <tbody>{paid.attempts.map(p => (
                  <tr key={p.id} data-attempt={p.provider_payment_id ?? p.id} data-attempt-status={p.status}>
                    <td className="nowrap">{formatDateTime(p.captured_at ?? p.created_at)}</td>
                    <td className="mono"><NavLink className="row-link" href={orderLink(p.order_id, 'payment')} aria-label={`Payment attempt for order ${p.order_number}`}>{p.order_number}</NavLink></td>
                    <td>{providerLabel(p.provider)}{p.method && <div className="note">{p.method}</div>}</td>
                    <td className="mono">{p.provider_payment_id ?? <span className="note">—</span>}</td>
                    <td><StatusBadge status={p.status} />{p.failure_reason && <div className="note">{p.failure_reason}</div>}</td>
                    <td className="num money">{money(p.amount_paise, p.currency)}</td>
                  </tr>))}
                </tbody></table></div>
            )}
            {paid.attemptsMore && <p className="note" data-more="attempts">The newest {paid.attempts.length} are shown. Older attempts are on each order's Payment tab.</p>}
          </Section>
          <Section id="rfd-h" title="Refunds" name="refunds" wide meta={`${paid.refunds.length}${paid.refundsMore ? '+' : ''}`} hint="Every refund recorded for this customer's orders, with or without a return. Requested and pending refunds have not been paid out yet; a refund is made on the order or its return.">
            {paid.refunds.length === 0 ? <StateBlock title="No refunds" name="customer-refunds">Nothing has been refunded to this customer, and no refund is waiting.</StateBlock> : (
              <div className="table-wrap"><table data-customer-refunds>
                <thead><tr><th>Date (IST)</th><th>Order</th><th>Refund for</th><th>How</th><th>Status</th><th className="num">Amount</th></tr></thead>
                <tbody>{paid.refunds.map(r => (
                  <tr key={r.id} data-refund={r.id} data-refund-status={r.status} data-refund-return={r.return_number ?? ''}>
                    <td className="nowrap">{formatDateTime(r.processed_at ?? r.created_at)}<div className="note">{r.processed_at ? 'paid out' : 'recorded'}</div></td>
                    <td className="mono"><NavLink className="row-link" href={orderLink(r.order_id, 'payment')} aria-label={`Refund on order ${r.order_number}`}>{r.order_number}</NavLink></td>
                    <td>{r.return_id && r.return_number ? <>Return <span className="mono">{r.return_number}</span></> : <span className="note">Not from a return</span>}{r.reason && <div className="note">{r.reason}</div>}</td>
                    <td>{r.method === 'provider' ? 'Payment provider' : r.method === 'manual' ? 'Outside the platform' : <span className="note">Not set</span>}{(r.reference ?? r.provider_refund_id) && <div className="note mono">{r.reference ?? r.provider_refund_id}</div>}</td>
                    <td><StatusBadge status={r.status} />{r.failure_reason && <div className="note">{r.failure_reason}</div>}</td>
                    <td className="num money">{money(r.amount_paise, r.currency)}</td>
                  </tr>))}
                </tbody></table></div>
            )}
            {paid.refundsMore && <p className="note" data-more="refunds">The newest {paid.refunds.length} are shown. Older refunds are on each order's Payment tab.</p>}
          </Section>
        </>}
        {!invoices ? denied('finance.read', 'Invoices') : (
          <Section id="inv-h" title="Invoices" name="invoices" wide meta={`${invoices.rows.length}${invoices.hasNext ? '+' : ''}`} hint={<>Invoices issued to this customer, newest first. An invoice opens in <Link href="/finance/invoices">Finance → Invoices</Link>, where invoices are issued and voided.</>}>
            {invoices.rows.length === 0 ? <StateBlock title="No invoices" name="customer-invoices">No invoice has been issued to this customer.</StateBlock> : (
              <div className="table-wrap"><table data-customer-invoices>
                <thead><tr><th>Invoice</th><th>Order</th><th>Issued</th><th>Status</th><th className="num">Total</th></tr></thead>
                <tbody>{invoices.rows.map(i => (
                  <tr key={i.id} data-invoice={i.invoice_number ?? 'draft'} data-invoice-status={i.status}>
                    <td className="mono"><Link className="row-link" href={`/finance/invoices/${i.id}`}>{i.invoice_number ?? 'draft'}</Link></td>
                    <td className="mono">{i.order_number ?? <span className="note">—</span>}</td>
                    <td className="nowrap">{formatDateTime(i.issued_at as Date | null)}</td>
                    <td><StatusBadge status={i.status} /></td>
                    <td className="num money">{money(i.total_paise, i.currency)}</td>
                  </tr>))}
                </tbody></table></div>
            )}
            {invoices.hasNext && <p className="note" data-more="invoices">The newest {invoices.rows.length} are shown. All invoices are in Finance → Invoices.</p>}
          </Section>
        )}
      </>}

      {tab === 'returns' && (!canReturns ? denied('returns.read', 'Returns') : (
        <Section id="ret-h" title="Returns and exchanges" name="returns" wide meta={`${returns.length}${returnList?.more ? '+' : ''}`} hint="Every return of this customer, whatever the age of the order. A row opens the order on its Returns tab, where the return is handled.">
          {returns.length === 0 ? <StateBlock title="No returns or exchanges" name="customer-returns">This customer has not returned anything. A return is started from a delivered order.</StateBlock> : (
            <div className="table-wrap"><table data-customer-returns>
              <thead><tr><th>Return</th><th>Order</th><th>Items</th><th>Reason</th><th>Status</th><th className="num">Refund</th><th>Requested</th></tr></thead>
              <tbody>{returns.map(r => {
                const to = canOrders ? orderLink(r.order_id, 'returns', `&return=${r.id}`) : `/returns/${r.id}`;
                return (
                  <tr key={r.id} data-return={r.number}>
                    <td className="mono"><NavLink className="row-link" href={to}>{r.number}</NavLink></td>
                    <td className="mono">{r.order_number}</td>
                    <td data-return-items>{r.items.length === 0 ? <span className="note">—</span> : <ul className="plain">{r.items.map(i => (
                      <li key={i.id}>{i.name} <span className="note">{i.colour ? `${i.colour}, ` : ''}size {i.size} × {i.qty}{i.exchange_size ? ` → size ${i.exchange_size}` : ''}</span></li>))}</ul>}</td>
                    <td>{r.reason}</td>
                    <td><StatusBadge status={r.status} />{r.resolution && <div className="note">{r.resolution}</div>}</td>
                    <td className="num money" data-return-refund>{r.refunds.length > 0 ? r.refunds.map(f => <div key={f.id}>{formatPaise(f.amount_paise)} <span className="note">{words(f.status)}</span></div>)
                      : r.refund_amount_paise ? <>{formatPaise(r.refund_amount_paise)} <span className="note">no refund recorded</span></> : <span className="note">—</span>}</td>
                    <td className="nowrap">{formatDateTime(r.requested_at as Date)}</td>
                  </tr>);
              })}</tbody></table></div>
          )}
          {returnList?.more && <p className="note" data-more="returns">The newest {returns.length} are shown. Older returns are in the Returns queue.</p>}
        </Section>
      ))}

      {tab === 'loyalty' && (!loyalty ? denied('loyalty.read', 'Loyalty points') : <>
        <Section id="loy-h" title="Loyalty points" name="loyalty" hint={<>The same balance and history as <Link href="/loyalty">Customers → Loyalty</Link>, where the rules are shown.</>}>
          <Figures items={[
            { label: 'Available', value: <span data-loyalty-balance>{formatNumber(loyalty.balance)}</span>, note: 'points' },
            { label: 'Earned', value: formatNumber(loyalty.totals.earned) }, { label: 'Used', value: formatNumber(loyalty.totals.used) }, { label: 'Expired', value: formatNumber(loyalty.totals.expired) },
            ...(loyalty.totals.reversed ? [{ label: 'Taken back', value: formatNumber(loyalty.totals.reversed) }] : []),
          ]} />
        </Section>
        <Section id="loy-hist" title="Points history" name="loyalty-history" wide meta={`${loyalty.rows.length}`}>
          {loyalty.rows.length === 0 ? <p className="empty">No point changes yet.</p> : (
            <div className="table-wrap"><table data-loyalty-history>
              <thead><tr><th>When</th><th>Change</th><th className="num">Points</th><th>Details</th></tr></thead>
              <tbody>{loyalty.rows.map(t => (
                <tr key={t.id}><td className="nowrap">{formatDateTime(t.created_at as Date)}</td><td>{LOYALTY_KIND_LABELS[t.kind] ?? t.kind}</td>
                  <td className="num">{t.points > 0 ? `+${t.points}` : t.points}</td>
                  <td>{t.order_number && <Link href={`/orders/${t.order_id}`}>{t.order_number}</Link>}{t.reason && <span className="note"> {t.reason}</span>}
                    {t.staff_email && <span className="note"> · {t.staff_email}</span>}{t.expires_at && (t.remaining ?? 0) > 0 && <span className="note"> · {t.remaining} expire {formatDateTime(t.expires_at as Date)}</span>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
        {can(actor, 'loyalty.adjust') && (
          <Section id="loy-adjust" title="Add or remove points" name="loyalty-adjust" hint="A correction by staff. The reason is kept in the points history.">
            <ActionForm action={adjustPointsAction} submitLabel="Save" id="loyalty-adjust-form" label="Add or remove points" resetOnSuccess>
              <Hidden name="customerId" value={id} />
              <div className="cols">
                <Field name="points" label="Points" hint="e.g. 100 to add, -50 to remove" required />
                <Field name="reason" label="Reason" required hint="Kept in the points history" />
              </div>
            </ActionForm>
          </Section>
        )}
      </>)}

      {tab === 'support' && (!canSupport ? denied('support.read', 'Support tickets') : (
        <Section id="sup-h" title="Support tickets" name="support" wide meta={`${tickets.length}${(counts.tickets ?? 0) > tickets.length ? '+' : ''}`}
          hint={`${(counts.tickets ?? 0) > tickets.length ? `The ${tickets.length} most recently updated of ${formatNumber(counts.tickets ?? 0)} tickets. ` : ''}A row opens the ticket in Support, where it is answered.`}>
          {tickets.length === 0 ? <StateBlock title="No support tickets" name="customer-tickets">This customer has not contacted support through a ticket.</StateBlock> : (
            <div className="table-wrap"><table data-customer-tickets>
              <thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Priority</th><th>Updated</th></tr></thead>
              <tbody>{tickets.map(t => (
                <tr key={t.id} data-ticket={t.number}>
                  <td className="mono"><Link className="row-link" href={`/support/${t.id}`}>{t.number}</Link></td><td>{t.subject}</td>
                  <td><StatusBadge status={t.status} /></td><td>{t.priority}</td><td className="nowrap">{formatDateTime(t.updated_at as Date)}</td>
                </tr>))}
              </tbody></table></div>
          )}
        </Section>
      ))}

      {tab === 'activity' && <>
        <Section id="act-h" title="Timeline" name="activity" wide hint="Orders, payments, returns, support tickets, point changes, service notes and staff actions on this account, newest first.">
          {timeline(moments)}
          {d.audit === undefined && <p className="note">Staff actions on the account need the audit.read permission.</p>}
        </Section>
        {/* 2026-10-10: the customer emails the platform tried to send (notification log). Only those tied to this customer
            for certain; what was tried and the result, never the message. */}
        {!emails ? denied('orders.read', 'Emails sent') : (
          <Section id="mail-h" title="Emails sent" name="emails" wide meta={`${emails.rows.length}${emails.more ? '+' : ''}`}
            hint={<>Emails about this customer's orders{emails.direct ? ', and other emails sent to their verified address since they joined' : ''}. “Sent” means the email service accepted the message, not that it was delivered or read; without an email provider it was only written to the server log.{!emails.direct && ' Emails that are not about an order (support replies, cart reminders) are listed only for staff who may see the email outbox, and only for a verified address.'}</>}>
            {emails.rows.length === 0 ? <StateBlock title="No emails" name="customer-emails">No email to this customer has been recorded.</StateBlock> : (
              <div className="table-wrap"><table data-customer-emails>
                <thead><tr><th>When</th><th>Email</th><th>To</th><th>Order</th><th>Result</th></tr></thead>
                <tbody>{emails.rows.map(m => (
                  <tr key={m.id} data-email={m.event} data-email-status={m.status}>
                    <td className="nowrap">{formatDateTime(m.created_at as Date)}</td>
                    <td>{EMAIL_LABEL[m.event] ?? words(m.event.replace('.', ' '))}<div className="note mono">{m.event}</div></td>
                    <td>{m.recipient}</td>
                    <td className="mono">{m.order_id && m.order_number ? <NavLink href={orderLink(m.order_id)}>{m.order_number}</NavLink> : <span className="note">—</span>}</td>
                    <td><span className={`badge ${m.status === 'sent' ? 'active' : 'failed'}`}>{m.status === 'sent' ? 'Sent' : 'Failed'}</span></td>
                  </tr>))}
                </tbody></table></div>
            )}
            {emails.more && <p className="note" data-more="emails">The newest {emails.rows.length} are shown.</p>}
          </Section>
        )}
        <Section id="ses-h" title="Sign-in history" name="sessions" wide hint="Safe details only: no addresses or devices are stored for display.">
          {d.sessions.length === 0 ? <p className="empty">No sessions.</p> : (
            <div className="table-wrap"><table data-sessions-table>
              <thead><tr><th>Started</th><th>Last seen</th><th>Ends</th><th>State</th></tr></thead>
              <tbody>{d.sessions.map(s => (
                <tr key={s.id}><td>{formatDateTime(s.createdAt)}</td><td>{formatDateTime(s.lastSeenAt)}</td><td>{formatDateTime(s.expiresAt)}</td>
                  <td>{s.active ? <StatusBadge status="active" /> : s.revokedAt ? <span className="note">ended {formatDateTime(s.revokedAt)}</span> : <span className="note">expired</span>}</td></tr>))}
              </tbody></table></div>
          )}
          {d.loginAttempts.length > 0 && (
            <ul className="plain" data-login-attempts>{d.loginAttempts.map((a, i) => (
              <li key={i}>{a.success ? 'Signed in' : 'Failed sign-in'} <span className="note">· {formatDateTime(a.at)}{a.reason ? ` · ${words(a.reason)}` : ''}</span></li>))}
            </ul>
          )}
        </Section>
        <Section id="aud-h" title="Audit" name="audit" wide hint="Every recorded action on this account, as kept in the audit log.">
          {d.audit === undefined ? <p className="note">The audit trail needs the audit.read permission.</p>
            : d.audit.length === 0 ? <p className="empty">No recorded actions.</p>
            : <ul className="activity" data-customer-audit>{d.audit.map(a => (
                <li key={a.id}><span className="mono activity-action">{a.action}</span>
                  <span className="activity-meta">{a.staff_email ?? a.actor_type} · {formatDateTime(a.occurred_at)}</span></li>))}
              </ul>}
        </Section>
      </>}
    </Entity>
  );
}
