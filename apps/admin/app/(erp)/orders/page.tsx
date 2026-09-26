import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { ORDER_STATUSES, orderListQuery, paiseToRupees, PAYMENT_STATUSES, type OrderListQuery } from '@kitsyuu/contracts';
import { listOrders } from '@kitsyuu/core';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, STATUS_LABEL } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Orders' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OrdersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead title="Orders" /><Forbidden permission="orders.read" /></>;
  const sp = await searchParams;
  const parsed = orderListQuery.safeParse({ q: one(sp.q), status: one(sp.status), payment: one(sp.payment), from: one(sp.from), to: one(sp.to), page: one(sp.page) });
  const query: OrderListQuery = parsed.success ? parsed.data : { status: 'all', payment: 'all', page: 1, q: undefined, from: undefined, to: undefined };
  const { rows, hasNext } = await listOrders(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all' || query.payment !== 'all' || query.from || query.to);
  const link = (page: number) => `/orders?${new URLSearchParams({ ...Object.fromEntries(Object.entries({ q: query.q, status: query.status, payment: query.payment, from: query.from, to: query.to })
    .filter(([, v]) => v && v !== 'all') as [string, string][]), page: String(page) })}`;
  return (
    <>
      <PageHead title="Orders" eyebrow={filtered ? 'Filtered' : 'Newest first'} />
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <form className="actions filters" method="get" role="search" aria-label="Filter orders" data-order-filters>
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
      </form>
      {rows.length === 0 ? (
        <p className="empty" data-empty="orders">{filtered ? 'No orders match these filters.' : 'No orders yet. Orders appear here once checkout is live.'}</p>
      ) : (
        <div className="table-wrap"><table data-orders-table>
          <thead><tr><th>Order</th><th>Placed (IST)</th><th>Customer</th><th className="num">Items</th><th className="num">Total</th><th>Payment</th><th>Status</th></tr></thead>
          <tbody>{rows.map(o => (
            <tr key={o.id} data-order-row={o.order_number}>
              <td className="mono"><Link href={`/orders/${o.id}`}>{o.order_number}</Link></td>
              <td>{formatDateTime(o.created_at)}</td>
              <td>{o.contact_name ?? '—'}{o.contact_email && <div className="note">{o.contact_email}</div>}</td>
              <td className="num">{o.units}<div className="note">{o.lines} line{o.lines === 1 ? '' : 's'}</div></td>
              <td className="num" data-total>₹{paiseToRupees(o.total_paise)}</td>
              <td>{o.payment_status ? <StatusBadge status={o.payment_status} /> : <span className="note">—</span>}</td>
              <td><StatusBadge status={o.status} /></td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      <div className="actions" style={{ marginTop: 14 }}>
        {query.page > 1 && <Link className="btn ghost" href={link(query.page - 1)}>Newer</Link>}
        {hasNext && <Link className="btn ghost" href={link(query.page + 1)}>Older</Link>}
        {(query.page > 1 || hasNext) && <span className="note">Page {query.page}</span>}
      </div>
    </>
  );
}
