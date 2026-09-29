import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { customerListQuery, type CustomerListQuery } from '@kitsyuu/contracts';
import { listCustomers } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';

export const metadata: Metadata = { title: 'Customers' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'customers.read')) return <><PageHead section="Commerce" title="Customers" /><Forbidden permission="customers.read" /></>;
  const sp = await searchParams;
  const parsed = customerListQuery.safeParse({ q: one(sp.q), status: one(sp.status), verified: one(sp.verified), orders: one(sp.orders), page: one(sp.page) });
  const query: CustomerListQuery = parsed.success ? parsed.data : { q: undefined, status: 'all', verified: 'all', orders: 'all', page: 1 };
  const { rows, hasNext, totals } = await listCustomers(db(), actor, query);
  const filtered = !!(query.q || query.status !== 'all' || query.verified !== 'all' || query.orders !== 'all');
  const link = (page: number) => `/customers?${new URLSearchParams({ ...Object.fromEntries(Object.entries({ q: query.q, status: query.status, verified: query.verified, orders: query.orders })
    .filter(([, v]) => v && v !== 'all') as [string, string][]), page: String(page) })}`;
  return (
    <>
      <PageHead section="Commerce" title="Customers"
        eyebrow={`${formatNumber(totals.total)} account${totals.total === 1 ? '' : 's'} · ${formatNumber(totals.disabled)} disabled${query.page > 1 ? ` · page ${query.page}` : ''}`} />
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <FilterForm className="actions" role="search" aria-label="Filter customers" data-customer-filters>
        <label className="sr-only" htmlFor="c-q">Search</label>
        <input id="c-q" name="q" className="input" placeholder="Email, name or phone" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="c-status">Account status</label>
        <select id="c-status" name="status" className="input" defaultValue={query.status}>
          <option value="all">All accounts</option><option value="active">Active</option><option value="disabled">Disabled</option>
        </select>
        <label className="sr-only" htmlFor="c-verified">Email</label>
        <select id="c-verified" name="verified" className="input" defaultValue={query.verified}>
          <option value="all">Any email state</option><option value="verified">Email verified</option><option value="unverified">Email not verified</option>
        </select>
        <label className="sr-only" htmlFor="c-orders">Orders</label>
        <select id="c-orders" name="orders" className="input" defaultValue={query.orders}>
          <option value="all">With or without orders</option><option value="with">Has orders</option><option value="without">No orders</option>
        </select>
        <button className="btn ghost" type="submit">Apply</button>
        {filtered && <Link className="btn link" href="/customers">Clear</Link>}
      </FilterForm>
      {rows.length === 0 ? (
        <Empty title={filtered ? 'No matching customers' : 'No customers yet'} kind="customers"
          action={filtered ? <Link className="btn ghost" href="/customers">Clear filters</Link> : undefined}>
          {filtered ? 'No customer accounts match these filters.' : 'Customer accounts appear here once people sign up on the store.'}
        </Empty>
      ) : (
        <div className="table-wrap"><table data-customers-table>
          <thead><tr><th>Customer</th><th>Status</th><th className="num">Orders</th><th className="num">Paid orders</th><th className="num">Lifetime value</th><th>Last order</th><th>Joined</th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id} data-customer-row={c.email}>
              <td><Link className="row-link" href={`/customers/${c.id}`}>{c.fullName || c.email}</Link>
                <div className="note">{c.email}{c.phone ? ` · ${c.phone}` : ''}{!c.verified && ' · email not verified'}</div></td>
              <td><StatusBadge status={c.status} /></td>
              <td className="num" data-orders-count>{formatNumber(c.ordersCount)}</td>
              <td className="num">{formatNumber(c.paidOrdersCount)}</td>
              <td className="num money" data-lifetime-value>{formatPaise(c.lifetimeValuePaise)}</td>
              <td className="nowrap">{formatDateTime(c.lastOrderAt)}</td>
              <td className="nowrap">{formatDateTime(c.createdAt)}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Customer pages">
          {query.page > 1 ? <Link className="btn ghost sm" href={link(query.page - 1)}>← Newer</Link> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <Link className="btn ghost sm" href={link(query.page + 1)}>Older →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
