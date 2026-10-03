import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { ORDER_STATUSES, orderListQuery, paiseToRupees, PAYMENT_STATUSES, type OrderListQuery } from '@kitsyuu/contracts';
import { listOrders } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, STATUS_LABEL } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';

export const metadata: Metadata = { title: 'Orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEWS = [{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'draft', label: 'Draft' }, { id: 'abandoned', label: 'Abandoned' }] as const;

export default async function OrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Orders" /><Forbidden permission="orders.read" /></>;
  const sp = await searchParams;
  const parsed = orderListQuery.safeParse({ q: one(sp.q), status: one(sp.status), payment: one(sp.payment), from: one(sp.from), to: one(sp.to), page: one(sp.page), view: one(sp.view) });
  const query: OrderListQuery = parsed.success ? parsed.data : { status: 'all', payment: 'all', page: 1, q: undefined, from: undefined, to: undefined, view: 'all' };
  const { rows, hasNext, abandonHours } = await listOrders(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all' || query.payment !== 'all' || query.from || query.to);
  const link = (page: number) => `/orders?${new URLSearchParams({ ...Object.fromEntries(Object.entries({ q: query.q, status: query.status, payment: query.payment, from: query.from, to: query.to, view: query.view })
    .filter(([, v]) => v && v !== 'all') as [string, string][]), page: String(page) })}`;
  return (
    <>
      <PageHead section="Commerce" title="Orders" eyebrow={`${filtered ? 'Filtered' : 'Newest first'}${query.page > 1 ? ` · page ${query.page}` : ''}`}>
        {/* Plain link (not <Link>): the route answers with a CSV download. */}
        <a className="btn ghost sm" data-export-orders download
          href={`/orders/export?${new URLSearchParams(Object.entries({ q: query.q, status: query.status, payment: query.payment, from: query.from, to: query.to })
            .filter(([, v]) => v && v !== 'all') as [string, string][])}`}>Export CSV</a>
      </PageHead>
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      {/* Client change request: one order list, split into views (no copies of orders). */}
      <nav className="tabs actions" aria-label="Order views" data-order-views>
        {VIEWS.map(v => <Link key={v.id} className={`btn sm ${query.view === v.id ? '' : 'ghost'}`} href={v.id === 'all' ? '/orders' : `/orders?view=${v.id}`}
          aria-current={query.view === v.id ? 'page' : undefined} data-order-view={v.id}>{v.label}</Link>)}
      </nav>
      {query.view !== 'all' && <p className="note" data-order-view-note>{query.view === 'active' ? 'Confirmed orders not yet delivered: paid, being packed or shipped.'
        : query.view === 'draft' ? `Placed but not paid yet, less than ${abandonHours} hours ago. They are not confirmed orders.`
        : <>Still unpaid {abandonHours} hours after they were placed (the abandoned-checkout time in Configuration). Reminder emails are handled under <Link href="/carts/checkouts">Carts → Abandoned checkouts</Link>.</>}</p>}
      <FilterForm className="actions" role="search" aria-label="Filter orders" data-order-filters>
        <label className="sr-only" htmlFor="o-q">Search</label>
        <input id="o-q" name="q" className="input" placeholder="Order no., email, name, phone or SKU" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="o-status">Order status</label>
        <select id="o-status" name="status" className="input" defaultValue={query.status}>
          <option value="all">All statuses</option><option value="open">Open (not finished)</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <label className="sr-only" htmlFor="o-pay">Payment status</label>
        <select id="o-pay" name="payment" className="input" defaultValue={query.payment}>
          <option value="all">Any payment status</option><option value="none">No payment status</option>
          {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <label className="sr-only" htmlFor="o-from">From date</label>
        <input id="o-from" name="from" type="date" className="input" defaultValue={query.from ?? ''} aria-label="Placed on or after" />
        <label className="sr-only" htmlFor="o-to">To date</label>
        <input id="o-to" name="to" type="date" className="input" defaultValue={query.to ?? ''} aria-label="Placed on or before" />
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/orders">Clear</Link>}
      </FilterForm>
      {rows.length === 0 ? (
        <Empty title={filtered ? 'No matching orders' : 'No orders yet'} kind="orders" action={filtered ? <Link className="btn ghost" href="/orders">Clear filters</Link> : undefined}>
          {filtered ? 'No orders match these filters.' : 'There are currently no orders to display. Orders appear here once checkout is live.'}
        </Empty>
      ) : (
        <div className="table-wrap"><table data-orders-table>
          <thead><tr><th>Order</th><th>Customer</th><th>Placed (IST)</th><th className="num">Items</th><th className="num">Total</th><th>Payment</th><th>Status</th>{query.view === 'abandoned' && <><th>Last activity</th><th>Reminder</th></>}<th className="num">Action</th></tr></thead>
          <tbody>{rows.map(o => (
            <tr key={o.id} data-order-row={o.order_number}>
              <td className="mono nowrap"><Link className="row-link" href={`/orders/${o.id}`}>{o.order_number}</Link></td>
              <td>{o.contact_name ?? '—'}{o.contact_email && <div className="note">{o.contact_email}</div>}</td>
              <td className="nowrap">{formatDateTime(o.created_at)}</td>
              <td className="num">{o.units}<div className="note">{o.lines} line{o.lines === 1 ? '' : 's'}</div></td>
              <td className="num money" data-total>₹{paiseToRupees(o.total_paise)}</td>
              <td>{o.payment_status ? <StatusBadge status={o.payment_status} /> : <span className="note">—</span>}</td>
              <td><StatusBadge status={o.status} />{o.payment_method === 'cod' && <div className="note">cash on delivery</div>}
                {o.channel === 'retail' && <div className="note" data-order-channel="retail">{o.pos_number ? `POS ${o.pos_number} · ` : ''}Offline · {o.branch}</div>}</td>
              {query.view === 'abandoned' && <><td className="nowrap">{formatDateTime(o.updated_at)}</td><td>{o.reminder ? o.reminder : <span className="note">not sent</span>}</td></>}
              <td className="num"><Link className="btn ghost sm" href={`/orders/${o.id}`} aria-label={`View order ${o.order_number}`}>View</Link></td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Order pages">
          {query.page > 1 ? <Link className="btn ghost sm" href={link(query.page - 1)}>← Newer</Link> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <Link className="btn ghost sm" href={link(query.page + 1)}>Older →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
