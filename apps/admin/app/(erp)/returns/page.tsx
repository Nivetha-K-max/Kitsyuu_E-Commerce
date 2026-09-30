import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { RETURN_STATUSES, returnListQuery } from '@kitsyuu/contracts';
import { listReturns, returnSettings } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import ReturnsNav from './ReturnsNav';

export const metadata: Metadata = { title: 'Returns & refunds' };

/* ERP module 3: return requests. Customers can only file them when Settings → Returns is switched on with a window. */
export default async function ReturnsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'returns.read')) return <><PageHead title="Returns & refunds" /><Forbidden permission="returns.read" /></>;
  const sp = await searchParams;
  const parsed = returnListQuery.safeParse({ q: one(sp.q), status: one(sp.status) || undefined, page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : returnListQuery.parse({});
  const [list, settings] = await Promise.all([listReturns(db(), actor, query), returnSettings(db())]);
  const qs = (p: number) => `/returns?status=${query.status}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}&page=${p}`;
  const open = Object.entries(list.counts).filter(([s]) => !['completed', 'rejected', 'cancelled'].includes(s)).reduce((n, [, c]) => n + c, 0);
  return (
    <>
      <PageHead title="Returns & refunds" eyebrow={settings.enabled && settings.windowDays
        ? `Customers can request returns within ${settings.windowDays} days of delivery · ${open} open`
        : `Returns are OFF for customers (Settings → Returns): the store says all sales are final · ${open} open`} />
      <ReturnsNav current="/returns" />
      <FilterForm className="actions" role="search" aria-label="Filter returns" data-return-filters>
        <label className="sr-only" htmlFor="rt-q">Search</label>
        <input id="rt-q" name="q" className="input" placeholder="Return no., order no. or email" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="rt-s">Status</label>
        <select id="rt-s" name="status" className="input" defaultValue={query.status}>
          <option value="open">Open</option><option value="all">All</option>
          {RETURN_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')} ({list.counts[s] ?? 0})</option>)}
        </select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No return requests here" kind="returns" /> : (
        <div className="table-wrap"><table data-returns-table>
          <thead><tr><th>Return</th><th>Order</th><th>Customer</th><th>Reason</th><th className="num">Units</th><th>Status</th><th className="num">Refund</th><th>Requested</th></tr></thead>
          <tbody>{list.rows.map(r => (
            <tr key={r.id} data-return={r.number}>
              <td className="mono"><Link className="row-link" href={`/returns/${r.id}`}>{r.number}</Link></td>
              <td className="mono">{r.order_number}</td><td>{r.customer_email ?? '—'}</td><td>{r.reason}</td><td className="num">{r.units}</td>
              <td><StatusBadge status={r.status} />{r.resolution && <div className="note">{r.resolution}</div>}</td>
              <td className="num money">{r.refund_amount_paise ? formatPaise(r.refund_amount_paise) : '—'}</td>
              <td className="nowrap">{formatDateTime(r.requested_at as Date)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {query.page > 1 && <Link className="btn ghost sm" href={qs(query.page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(query.page + 1)}>Next</Link>}
      </nav>
    </>
  );
}
