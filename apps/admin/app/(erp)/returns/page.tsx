import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { RETURN_STATUSES, returnListQuery } from '@kitsyuu/contracts';
import { listReturns, returnSettings } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { FilterLink, NavFrame, NavLink } from '@/components/NavFrame';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import ReturnsNav from './ReturnsNav';

export const metadata: Metadata = { title: 'Returns' };
const words = (s: string) => s.replace(/_/g, ' ');
const title = (s: string) => words(s).replace(/^./, c => c.toUpperCase());
/* What staff do next with a return in each existing status (the steps themselves are the return workflow's: core
   RETURN_FLOW). The queue only names the step and opens the order's Returns tab, where it is taken and checked. */
const NEXT: Record<string, { label: string; why?: string }> = {
  requested: { label: 'Review request', why: 'new request' },
  under_review: { label: 'Approve or reject', why: 'being reviewed' },
  info_requested: { label: 'Review reply', why: 'waiting for the customer' },
  approved: { label: 'Schedule pickup or receive', why: 'approved, items not back yet' },
  pickup_scheduled: { label: 'Mark picked up', why: 'pickup booked' },
  picked_up: { label: 'Mark received', why: 'on its way back' },
  received: { label: 'Inspect items', why: 'items are back' },
  inspection: { label: 'Record inspection', why: 'being inspected' },
  refund_pending: { label: 'Make refund', why: 'refund owed to the customer' },
  exchange_pending: { label: 'Send replacement', why: 'replacement to send' },
  refunded: { label: 'Complete return', why: 'refunded, not closed' },
  exchanged: { label: 'Complete return', why: 'replacement sent, not closed' },
};

/* Returns: the queue of return and exchange requests across orders. It finds the work; the work is done on the order's
   Returns tab (one return record, one workflow). Customers can only file requests when Configuration → Returns is
   switched on with a window. */
export default async function ReturnsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'returns.read')) return <><PageHead title="Returns" /><Forbidden permission="returns.read" /></>;
  const sp = await searchParams;
  const parsed = returnListQuery.safeParse({ q: one(sp.q), status: one(sp.status) || undefined, page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : returnListQuery.parse({});
  const [list, settings] = await Promise.all([listReturns(db(), actor, query), returnSettings(db())]);
  // Who the return is for: the order's own contact (a walk-in customer has no account email).
  const ids = [...new Set(list.rows.map(r => r.order_id))];
  const contacts = ids.length ? await db().selectFrom('orders').select(['id', 'contact']).where('id', 'in', ids).execute() : [];
  const nameOf = (orderId: string) => { const c = (contacts.find(x => x.id === orderId)?.contact ?? {}) as { name?: string | null; email?: string | null }; return c.name || c.email || null; };
  const canOrders = can(actor, 'orders.read'), manage = can(actor, 'returns.manage'), canRefund = manage && can(actor, 'refunds.create');
  const href = (change: Partial<Record<'q' | 'status' | 'page', string | undefined>>) => {
    const next = { q: query.q, status: query.status as string, page: undefined as string | undefined, ...change };
    const qs = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === 'status' && v === 'open')) as [string, string][]).toString();
    return qs ? `/returns?${qs}` : '/returns';
  };
  const open = (id: string, orderId: string) => (canOrders ? `/orders/${orderId}?tab=returns&return=${id}` : `/returns/${id}`);
  const total = Object.values(list.counts).reduce((n, c) => n + c, 0);
  const openCount = Object.entries(list.counts).filter(([s]) => !['completed', 'rejected', 'cancelled'].includes(s)).reduce((n, [, c]) => n + c, 0);
  const filtered = !!query.q || query.status !== 'open';
  // Status chips: Open, every existing status that has returns (or is selected), and All.
  const chips = RETURN_STATUSES.filter(s => (list.counts[s] ?? 0) > 0 || query.status === s);
  return (
    <NavFrame className="ord ws queue" data-workspace="returns">
      <PageHead title="Returns" eyebrow={`${openCount} open · ${settings.enabled && settings.windowDays
        ? `customers can request a return within ${settings.windowDays} days of delivery`
        : 'returns are OFF for customers (Configuration → Returns): the store says all sales are final'}`} />
      <ReturnsNav current="/returns" />
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <div className="ord-toolbar">
        <FilterForm debounce={200} role="search" aria-label="Filter returns" data-return-filters>
          <label className="sr-only" htmlFor="rt-q">Search</label>
          <input id="rt-q" name="q" className="input" placeholder="Search return no., order no. or customer email" defaultValue={query.q ?? ''} />
          {query.status !== 'open' && <input type="hidden" name="status" value={query.status} />}
          <button className="btn ghost sr-only" type="submit">Apply</button>
        </FilterForm>
        {filtered && <FilterLink className="btn link" group="clear" current={false} href="/returns" data-clear-filters>Clear all</FilterLink>}
      </div>
      <nav className="ord-chipset ord-stages" aria-label="Filter by return status" data-return-status-chips>
        <span className="ord-chip-label" aria-hidden="true">Status</span>
        <FilterLink className="ord-chip" group="status" href={href({ status: 'open' })} current={query.status === 'open'} data-return-status-chip="open">Open<span className="ord-count">{openCount}</span></FilterLink>
        {chips.map(s => <FilterLink key={s} className="ord-chip" group="status" href={href({ status: s })} current={query.status === s} data-return-status-chip={s}>{title(s)}<span className="ord-count">{list.counts[s] ?? 0}</span></FilterLink>)}
        <FilterLink className="ord-chip" group="status" href={href({ status: 'all' })} current={query.status === 'all'} data-return-status-chip="all">All<span className="ord-count">{total}</span></FilterLink>
      </nav>
      {list.rows.length === 0 ? (
        <Empty title={total === 0 ? 'No returns yet' : query.q ? 'No matching returns' : query.status === 'open' ? 'No open returns' : 'No returns in this status'} kind="returns"
          action={filtered ? <Link className="btn ghost" href="/returns">Show open returns</Link> : undefined}>
          {total === 0 ? 'A return appears here when a customer requests one, or when staff start one from a delivered order.'
            : query.q ? 'No return matches this search.' : query.status === 'open' ? 'Every return has been completed, rejected or cancelled.' : 'Choose another status above.'}
        </Empty>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={href({ page: String(query.page) })}><table data-returns-table>
          <thead><tr><th>Return for</th><th>Reason</th><th>Status</th><th className="num">Refund</th><th>Requested (IST)</th><th>Next step</th></tr></thead>
          <tbody>{list.rows.map(r => {
            const n = NEXT[r.status];
            // A step is offered only where the workflow has one and this person may take it (refunds also need refunds.create).
            const actionable = !!n && (r.status === 'refund_pending' ? canRefund : manage);
            return (
              <tr key={r.id} data-return={r.number} data-return-state={r.status}>
                <td className="ord-who"><NavLink prefetch className="row-link" href={open(r.id, r.order_id)} aria-label={`Return ${r.number}, order ${r.order_number}`}>{nameOf(r.order_id) ?? r.customer_email ?? 'No customer details'}</NavLink>
                  <div className="ord-no"><span className="mono">{r.number}</span><span> · order {r.order_number}</span></div></td>
                <td className="ord-items">{r.reason}<div className="note">{r.units} unit{r.units === 1 ? '' : 's'}{r.resolution ? ` · ${r.resolution}` : ''}</div></td>
                <td className="ord-stage"><StatusBadge status={r.status} />{n?.why && <div className="note" data-return-why>{n.why}</div>}</td>
                <td className="num money ord-amount">{r.refund_amount_paise ? formatPaise(r.refund_amount_paise) : <span className="note">—</span>}</td>
                <td className="nowrap ord-placed">{formatDateTime(r.requested_at as Date)}<div className="note">updated {formatDateTime(r.updated_at as Date)}</div></td>
                <td className="ord-next" data-next-step>{actionable
                  ? <NavLink className="btn sm" href={open(r.id, r.order_id)} aria-label={`${n!.label}: return ${r.number}`}>{n!.label}<span aria-hidden="true"> →</span></NavLink>
                  : <NavLink className="btn ghost sm" href={open(r.id, r.order_id)} aria-label={`View return ${r.number}`}>View</NavLink>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {(query.page > 1 || list.hasNext) && (
        <nav className="pager" aria-label="Return pages">
          {query.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page - 1) })}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {list.hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={href({ page: String(query.page + 1) })}>Older →</FilterLink> : <span />}
        </nav>
      )}
    </NavFrame>
  );
}
