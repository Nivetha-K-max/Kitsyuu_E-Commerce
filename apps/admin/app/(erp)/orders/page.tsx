import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { can } from '@kitsyuu/auth';
import { ORDER_TRANSITIONS, orderListQuery, paiseToRupees, type OrderListQuery, type OrderStatusCode } from '@kitsyuu/contracts';
import { listDraftOrders, listOrders, ORDER_PAGE_SIZE } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Icon } from '@/components/icons';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';
import { FilterLink, NavFrame, NavLink } from '@/components/NavFrame';
import { createDraftAction } from '../drafts/actions';
import { PaymentPill } from '../payments/payment-ui';
import { orderStage } from './order-ui';

export const metadata: Metadata = { title: 'Orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/* One Orders screen for the whole order lifecycle: Draft (prepared by staff, not placed yet) → Placed → Confirmed → Being
   packed → Packed → Shipped → Delivered, with Cancelled and Abandoned beside it. The view comes first, the stage narrows
   it, and the payment is only an optional filter: the money itself is managed under Payments. */
const VIEWS = [{ id: 'all', label: 'All orders' }, { id: 'active', label: 'Active' }, { id: 'draft', label: 'Draft' }, { id: 'abandoned', label: 'Abandoned' }] as const;
type Stage = { id: string; label: string; status: OrderListQuery['status']; packing?: 'open' | 'packed'; views: readonly string[] };
/* Stage chips: each sets filters the list already has (the order status, and for an order being processed how far
   packing has got). No stage is stored anywhere new. */
const STAGES: Stage[] = [
  { id: 'open', label: 'Open', status: 'open', views: ['all'] },
  { id: 'pending_payment', label: 'Awaiting payment', status: 'pending_payment', views: ['all', 'active'] },
  { id: 'paid', label: 'Confirmed', status: 'paid', views: ['all', 'active'] },
  { id: 'packing', label: 'Being packed', status: 'processing', packing: 'open', views: ['all', 'active'] },
  { id: 'packed', label: 'Packed', status: 'processing', packing: 'packed', views: ['all', 'active'] },
  { id: 'shipped', label: 'Shipped', status: 'shipped', views: ['all', 'active'] },
  { id: 'delivered', label: 'Delivered', status: 'delivered', views: ['all'] },
  { id: 'cancelled', label: 'Cancelled', status: 'cancelled', views: ['all'] },
];
/** Readable stage names in a link (/orders?status=packed) map onto the same filters as the chips. */
const STATUS_ALIAS: Record<string, { status: string; packing?: string }> = {
  placed: { status: 'pending_payment' }, awaiting_payment: { status: 'pending_payment' }, confirmed: { status: 'paid' },
  packing: { status: 'processing', packing: 'open' }, being_packed: { status: 'processing', packing: 'open' }, packed: { status: 'processing', packing: 'packed' },
};
const PAYMENT_OPTIONS: { value: OrderListQuery['payment']; label: string }[] = [
  { value: 'all', label: 'Any payment' }, { value: 'paid', label: 'Paid' }, { value: 'pending', label: 'Pending' }, { value: 'unpaid', label: 'Unpaid' },
  { value: 'failed', label: 'Failed' }, { value: 'refunded', label: 'Refunded' },
];
const DRAFT_TABS = [['open', 'Open'], ['confirmed', 'Became orders'], ['cancelled', 'Cancelled'], ['all', 'All']] as const;
type DraftStatus = (typeof DRAFT_TABS)[number][0];

type Row = Awaited<ReturnType<typeof listOrders>>['rows'][number];
type Next = { label: string; href: string; primary?: boolean } | { wait: string } | null;
/** The next thing staff do with this order, from the transitions the system allows staff (ORDER_TRANSITIONS) and the cash
    still to collect on a COD order. It is a pointer: the action itself is taken, and checked, on the page it opens. */
function nextStep(o: Row, p: { status: boolean; cod: boolean; billing: boolean }): Next {
  const order = (hash: string) => `/orders/${o.id}#${hash}`;
  // Recording the cash is a payment action: it opens the payment (or the order's payment panel without billing.read).
  const collect = { label: 'Record cash collected', href: p.billing ? `/payments/${o.id}#collect` : order('pay-h') };
  const codDue = o.payment_method === 'cod' && o.cod_status === 'to_collect';
  if (codDue && p.cod && o.status === 'delivered') return { ...collect, primary: true };
  const to = ORDER_TRANSITIONS[o.status as OrderStatusCode] ?? [];
  if (o.status === 'pending_payment' || o.status === 'payment_failed') return { wait: 'Waiting for customer payment' };
  if (p.status && to.includes('processing')) return { label: 'Start packing', href: order('next-h'), primary: true };
  if (p.status && to.includes('shipped')) return o.packing_state === 'packed' ? { label: 'Mark shipped', href: order('next-h'), primary: true } : { label: 'Finish packing', href: order('next-h'), primary: true };
  if (p.status && to.includes('delivered')) return { label: 'Mark delivered', href: order('next-h'), primary: true };
  return null;
}

export default async function OrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Orders" /><Forbidden permission="orders.read" /></>;
  const sp = await searchParams;
  const alias = STATUS_ALIAS[one(sp.status) ?? ''];
  const parsed = orderListQuery.safeParse({ q: one(sp.q), status: alias?.status ?? one(sp.status), packing: alias?.packing ?? one(sp.packing), payment: one(sp.payment),
    from: one(sp.from), to: one(sp.to), page: one(sp.page), view: one(sp.view) });
  const query: OrderListQuery = parsed.success ? parsed.data : { status: 'all', payment: 'all', page: 1, q: undefined, from: undefined, to: undefined, view: 'all', packing: undefined };
  const perms = { status: can(actor, 'orders.update_status'), cod: can(actor, 'orders.cod'), billing: can(actor, 'billing.read') };
  const canCreate = can(actor, 'orders.create');
  /** The list URL with some filters changed (page always back to 1 unless given). */
  const href = (change: Partial<Record<'q' | 'status' | 'packing' | 'payment' | 'from' | 'to' | 'view' | 'page' | 'draft', string | undefined>>) => {
    const next = { view: query.view, q: query.q, status: query.status, packing: query.packing, payment: query.payment, from: query.from, to: query.to, page: undefined as string | undefined, ...change };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v && v !== 'all') as [string, string][]).toString();
    return qs ? `/orders?${qs}` : '/orders';
  };
  const openDrafts = Number((await db().selectFrom('draft_orders').select(eb => eb.fn.countAll<number>().as('n')).where('status', '=', 'open').executeTakeFirst())?.n ?? 0);
  const head = (eyebrow: string, extra?: ReactNode) => (
    <PageHead section="Commerce" title="Orders" eyebrow={eyebrow}>
      {extra}
      {canCreate && <NavLink className="btn" href="/orders?view=draft#new-draft" data-new-order><Icon name="plus" size={15} />New order</NavLink>}
    </PageHead>
  );
  const views = (
    <nav className="tabs ord-views" aria-label="Order views" data-order-views>
      {VIEWS.map(v => <FilterLink key={v.id} className="btn ghost sm" group="view" resets={['stage']} current={query.view === v.id} currentValue="page" data-order-view={v.id}
        // the stage belongs to the view it was picked in; the search and dates carry over
        href={href({ view: v.id, status: 'all', packing: undefined, payment: v.id === 'draft' ? 'all' : query.payment })}>
        {v.label}{v.id === 'draft' && openDrafts > 0 && <span className="ord-count" data-open-drafts>{openDrafts}</span>}</FilterLink>)}
    </nav>
  );

  // ---------------------------------------------------------------- Draft: orders staff are still preparing
  if (query.view === 'draft') {
    const draftStatus = (DRAFT_TABS.find(t => t[0] === one(sp.draft))?.[0] ?? 'open') as DraftStatus;
    const presetId = one(sp.customer) ?? '';
    const [all, branches, preset] = await Promise.all([
      listDraftOrders(db(), actor, { status: draftStatus }),
      db().selectFrom('locations').select(['id', 'name']).where('is_online', '=', false).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
      /^[0-9a-f-]{36}$/i.test(presetId) ? db().selectFrom('customers').select(['id', 'email', 'full_name']).where('id', '=', presetId).executeTakeFirst() : null,
    ]);
    const term = query.q?.toLowerCase();
    const drafts = !term ? all : all.filter(d => { const c = (d.contact ?? {}) as { name?: string | null; phone?: string | null; email?: string | null };
      return [d.number, d.customer_name, d.customer_email, c.name, c.phone, c.email, d.order_number].some(x => x?.toLowerCase().includes(term)); });
    return (
      <NavFrame className="ord" data-orders-screen data-view="draft">
        {head(`${drafts.length} draft order${drafts.length === 1 ? '' : 's'}${term ? ' matching' : ''} · newest first`)}
        {views}
        <p className="note ord-view-note" data-order-view-note>Orders staff are preparing for a customer (by phone, in a branch). A draft holds no stock and is not an order yet: confirming it places the order.</p>
        <div className="ord-toolbar">
          <FilterForm debounce={200} role="search" aria-label="Search draft orders" data-order-filters>
            <label className="sr-only" htmlFor="o-q">Search</label>
            <input id="o-q" name="q" className="input" placeholder="Search draft no., customer or phone" defaultValue={query.q ?? ''} />
            <input type="hidden" name="view" value="draft" />
            {draftStatus !== 'open' && <input type="hidden" name="draft" value={draftStatus} />}
            <button className="btn ghost sr-only" type="submit">Apply</button>
          </FilterForm>
          <nav className="ord-chipset" aria-label="Draft order status" data-draft-tabs>
            <span className="ord-chip-label" aria-hidden="true">Show</span>
            {DRAFT_TABS.map(([k, label]) => <FilterLink key={k} className="ord-chip" group="draft" href={href({ draft: k === 'open' ? undefined : k })} current={k === draftStatus} data-draft-tab={k}>{label}</FilterLink>)}
          </nav>
        </div>
        {drafts.length === 0 ? (
          <Empty title={term ? 'No matching draft orders' : 'No draft orders here'} kind="drafts" action={canCreate ? <a className="btn ghost" href="#new-draft">Start a draft order</a> : undefined}>
            {term ? 'No draft matches this search.' : draftStatus === 'open' ? 'There is no order being prepared right now.' : 'Nothing in this list yet.'}
          </Empty>
        ) : (
          <div className="table-wrap ord-table" data-fresh key={`${draftStatus}:${term ?? ''}`}><table data-drafts-table>
            <thead><tr><th>Customer / draft</th><th>Last updated (IST)</th><th className="ord-channel">Channel</th><th>Items</th><th>Stage</th><th>Prepared by</th><th>Next step</th></tr></thead>
            <tbody>{drafts.map(d => {
              const contact = (d.contact ?? {}) as { name?: string | null; phone?: string | null };
              const who = d.customer_name ?? d.customer_email ?? contact.name ?? contact.phone ?? 'Walk-in customer';
              return (
                <tr key={d.id} data-draft={d.number} data-stage={d.status === 'open' ? 'draft' : d.status}>
                  <td className="ord-who"><NavLink prefetch className="row-link" href={`/drafts/${d.id}`} aria-label={`Draft ${d.number}, ${who}`}>{who}</NavLink>
                    <div className="ord-no">{d.number}</div>{d.customer_email && d.customer_name ? <div className="note ord-mail">{d.customer_email}</div> : null}</td>
                  <td className="nowrap ord-placed">{formatDateTime(d.updated_at as Date)}</td>
                  <td className="ord-channel">{d.channel === 'retail' ? <><span className="ord-type">In store</span><div className="note">{d.location_name}</div></> : <span className="ord-type">Online</span>}</td>
                  <td className="ord-items">{formatNumber(d.units)} unit{d.units === 1 ? '' : 's'}{d.discount_bp ? <div className="note">staff discount {d.discount_bp / 100}%</div> : null}</td>
                  <td className="ord-stage">{d.status === 'open' ? <span className="badge draft" data-order-stage="draft">Draft</span>
                    : d.status === 'confirmed' ? <><span className="badge processed" data-order-stage="placed">Placed</span>{d.order_number && <div className="note">order {d.order_number}</div>}</>
                    : <span className="badge cancelled" data-order-stage="cancelled">Cancelled</span>}</td>
                  <td className="ord-extra" data-label="Prepared by">{d.owner_email ?? '—'}</td>
                  <td className="ord-next" data-next-step>{d.status === 'open' ? <NavLink className={`btn sm${canCreate ? '' : ' ghost'}`} href={`/drafts/${d.id}`}>{canCreate ? 'Continue draft' : 'View draft'}<span aria-hidden="true"> →</span></NavLink>
                    : d.order_id ? <NavLink className="btn ghost sm" href={`/orders/${d.order_id}`}>View order<span aria-hidden="true"> →</span></NavLink>
                    : <NavLink className="btn ghost sm" href={`/drafts/${d.id}`}>View</NavLink>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {canCreate && (
          <section className="card form-panel ord-new-draft" id="new-draft" aria-labelledby="dn-h" data-section="new-draft">
            <h2 id="dn-h">New draft order</h2>
            <p className="note"><b>Online</b>: delivered to the customer, who pays from their account (or cash on delivery where allowed). <b>In a branch</b>: the customer is in the store,
              pays there and takes the items; the stock comes from that branch{branches.length ? '' : ' (add a retail location under Locations first)'}.</p>
            <ActionForm action={createDraftAction} submitLabel="Create draft" id="new-draft-form" label="New draft order">
              <Select name="channel" label="Where" required defaultValue={preset ? 'online' : ''} options={[{ value: '', label: 'Choose…' }, { value: 'online', label: 'Online (delivered to the customer)' }, ...(branches.length ? [{ value: 'retail', label: 'In a branch (paid and collected in the store)' }] : [])]} />
              {preset
                ? <><Hidden name="customerId" value={preset.id} /><p className="note" data-draft-customer>Customer: <b>{preset.full_name ?? preset.email}</b> ({preset.email})</p></>
                : <Field name="customerEmail" label="Customer account email" hint="Needed for online orders. Optional in a branch (for a walk-in customer, give a name or phone below)." autoComplete="off" />}
              {branches.length > 0 && <Select name="locationId" label="Branch (in-store orders)" options={[{ value: '', label: '—' }, ...branches.map(b => ({ value: b.id, label: b.name }))]} />}
              <Field name="contactName" label="Walk-in customer name (no account)" autoComplete="off" />
              <Field name="contactPhone" label="Walk-in customer phone" autoComplete="off" />
              <Field name="contactEmail" label="Walk-in customer email (optional)" autoComplete="off" />
              <TextArea name="note" label="Note (optional)" rows={2} />
            </ActionForm>
          </section>
        )}
      </NavFrame>
    );
  }

  // ---------------------------------------------------------------- All / Active / Abandoned: placed orders
  const { rows, hasNext, abandonHours, matching, total } = await listOrders(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all' || query.packing || query.payment !== 'all' || query.from || query.to);
  const narrowed = filtered || query.view !== 'all';
  const exportHref = `/orders/export?${new URLSearchParams(Object.entries({ q: query.q, status: query.status, packing: query.packing, payment: query.payment, from: query.from, to: query.to, view: query.view })
    .filter(([, v]) => v && v !== 'all') as [string, string][])}`;
  const first = (query.page - 1) * ORDER_PAGE_SIZE + 1;
  const stages = STAGES.filter(s => s.views.includes(query.view));
  const stageOn = (s: Stage) => query.status === s.status && (query.packing ?? undefined) === s.packing;
  return (
    <NavFrame className="ord" data-orders-screen data-view={query.view}>
      {head(`${total} order${total === 1 ? '' : 's'} · ${narrowed ? `${matching} shown here` : 'newest first'}${rows.length && (hasNext || query.page > 1) ? ` · ${first}–${first + rows.length - 1}` : ''}`,
        /* Plain link (not <Link>): the route answers with a CSV download. */
        <a className="btn ghost" data-export-orders download href={exportHref}><Icon name="download" size={15} />Export CSV</a>)}
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      {views}
      <p className="note ord-view-note" data-order-view-note>{query.view === 'all' ? 'Every placed order, newest first. Orders still being prepared by staff are under Draft.' : query.view === 'active'
        ? `Orders in progress: placed and waiting for payment (less than ${abandonHours} hours), confirmed, being packed or shipped.`
        : <>Placed but still unpaid {abandonHours} hours later (the abandoned-checkout time in Configuration). Reminder emails are handled under <Link href="/carts/checkouts">Carts → Abandoned checkouts</Link>.</>}</p>
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter orders" data-order-filters>
          <label className="sr-only" htmlFor="o-q">Search</label>
          <input id="o-q" name="q" className="input" placeholder="Search order no., customer, phone or SKU" defaultValue={query.q ?? ''} />
          {/* the view tabs and stage chips own these; kept in the form so searching or picking dates does not drop them */}
          {query.view !== 'all' && <input type="hidden" name="view" value={query.view} />}
          {query.status !== 'all' && <input type="hidden" name="status" value={query.status} />}
          {query.packing && <input type="hidden" name="packing" value={query.packing} />}
          <span className="ord-dates">
            <label htmlFor="o-from">Placed</label>
            <input id="o-from" name="from" type="date" className="input" defaultValue={query.from ?? ''} aria-label="Placed on or after" />
            <span aria-hidden="true">–</span>
            <input id="o-to" name="to" type="date" className="input" defaultValue={query.to ?? ''} aria-label="Placed on or before" />
          </span>
          {/* Payment is an optional, secondary filter here; the money itself is managed under Payments. */}
          <label className="sr-only" htmlFor="o-pay">Payment</label>
          <select id="o-pay" name="payment" className="input ord-pay-filter" defaultValue={query.payment === 'all' ? '' : query.payment} data-order-payment-filter>
            {PAYMENT_OPTIONS.map(p => <option key={p.value} value={p.value === 'all' ? '' : p.value}>{p.label}</option>)}
            {!PAYMENT_OPTIONS.some(p => p.value === query.payment) && <option value={query.payment}>{query.payment}</option>}
          </select>
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {narrowed && <FilterLink className="btn link" group="clear" current={false} href="/orders" data-clear-filters>Clear all</FilterLink>}
      </div>
      {query.view !== 'abandoned' && (
        <nav className="ord-chipset ord-stages" aria-label="Filter by order stage" data-order-status-chips>
          <span className="ord-chip-label" aria-hidden="true">Stage</span>
          <FilterLink className="ord-chip" group="stage" fallback href={href({ status: 'all', packing: undefined })} current={query.status === 'all' && !query.packing} data-status-chip="all">Any stage</FilterLink>
          {stages.map(s => { const on = stageOn(s); return (
            <FilterLink key={s.id} className="ord-chip" group="stage" href={href({ status: s.status, packing: s.packing })} offHref={href({ status: 'all', packing: undefined })} current={on} data-status-chip={s.id}>{s.label}</FilterLink>); })}
        </nav>
      )}
      {rows.length === 0 ? (
        <Empty title={narrowed ? 'No matching orders' : 'No orders yet'} kind="orders" action={narrowed ? <Link className="btn ghost" href="/orders">Clear filters</Link> : undefined}>
          {narrowed ? 'No orders match this view and these filters.' : 'There are currently no orders to display. Orders appear here once checkout is live.'}
        </Empty>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={href({ page: String(query.page) })}><table data-orders-table>
          <thead><tr><th>Customer / order</th><th className="ord-placed">Placed (IST)</th><th className="ord-channel">Channel</th><th>Items</th><th>Order stage</th><th>Payment</th><th className="num">Total</th>
            {query.view === 'abandoned' && <><th className="ord-last">Last activity</th><th>Reminder</th></>}<th>Next step</th></tr></thead>
          <tbody>{rows.map(o => {
            const st = orderStage(o.status, o.packing_state), next = nextStep(o, perms);
            return (
              <tr key={o.id} data-order-row={o.order_number} data-stage={st.code}>
                <td className="ord-who"><NavLink prefetch className="row-link" href={`/orders/${o.id}`} aria-label={`Order ${o.order_number}${o.contact_name ? `, ${o.contact_name}` : ''}`}>{o.contact_name ?? o.contact_email ?? 'No customer details'}</NavLink>
                  <div className="ord-no">{o.order_number}</div>{o.contact_name && o.contact_email ? <div className="note ord-mail">{o.contact_email}</div> : null}
                  <div className="note ord-when" data-folded-placed>{formatDateTime(o.created_at)}{o.channel === 'retail' ? ' · In store' : ''}</div></td>
                <td className="nowrap ord-placed">{formatDateTime(o.created_at)}</td>
                <td className="ord-channel" data-order-channel={o.channel === 'retail' ? 'retail' : undefined}>{o.channel === 'retail'
                  ? <><span className="ord-type">In store</span><div className="note">{o.pos_number ? `POS ${o.pos_number} · ` : ''}Offline · {o.branch}</div></>
                  : <span className="ord-type">Online</span>}</td>
                <td className="ord-items">{o.item_names ?? '—'}{o.lines > 3 ? ', …' : ''}<div className="note">{o.units} unit{o.units === 1 ? '' : 's'} · {o.lines} line{o.lines === 1 ? '' : 's'}</div></td>
                <td className="ord-stage"><span className={`badge ${st.code}`} data-order-stage={st.code}>{st.label}</span></td>
                <td className="ord-pay" data-payment-method={o.payment_method ?? undefined}><PaymentPill method={o.payment_method} paymentStatus={o.payment_status} codStatus={o.cod_status} orderStatus={o.status} note={false} /></td>
                <td className="num money ord-amount" data-total>₹{paiseToRupees(o.total_paise)}</td>
                {query.view === 'abandoned' && <><td className="nowrap ord-extra ord-last" data-label="Last activity">{formatDateTime(o.updated_at)}</td><td className="ord-extra" data-label="Reminder">{o.reminder ? o.reminder : <span className="note">not sent</span>}</td></>}
                <td className="ord-next" data-next-step>{!next ? <NavLink className="btn ghost sm" href={`/orders/${o.id}`} aria-label={`View order ${o.order_number}`}>View</NavLink>
                  : 'wait' in next ? <span className="note">{next.wait}</span>
                  : <NavLink className={`btn sm${next.primary ? '' : ' ghost'}`} href={next.href} aria-label={`${next.label}: order ${o.order_number}`}>{next.label}<span aria-hidden="true"> →</span></NavLink>}</td>
              </tr>);
          })}
          </tbody>
        </table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Order pages">
          {query.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page - 1) })}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page + 1) })}>Older →</FilterLink> : <span />}
        </nav>
      )}
    </NavFrame>
  );
}
