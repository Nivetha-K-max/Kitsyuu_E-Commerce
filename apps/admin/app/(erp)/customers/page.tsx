import ModuleViews from '@/components/ModuleViews';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { customerListQuery, type CustomerListQuery } from '@kitsyuu/contracts';
import { listCustomers } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';
import { FilterLink, NavFrame, NavLink } from '@/components/NavFrame';

export const metadata: Metadata = { title: 'Customers' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Every filter in the URL (2026-10-01: segments, channel, payment, counts, spend, points, dates, subscription, place, sort). */
const KEYS = ['q', 'status', 'verified', 'orders', 'segment', 'channel', 'payment', 'minOrders', 'maxOrders', 'minSpend', 'minPoints', 'maxPoints',
  'lastOrderFrom', 'lastOrderTo', 'joinedFrom', 'joinedTo', 'subscribed', 'place', 'sort'] as const;
const DEFAULTS: Record<string, string> = { status: 'all', verified: 'all', orders: 'all', segment: 'all', channel: 'all', payment: 'all', subscribed: 'all', sort: 'newest' };

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'customers.read')) return <><PageHead section="Commerce" title="Customers" /><Forbidden permission="customers.read" /></>;
  const sp = await searchParams;
  const raw = Object.fromEntries(KEYS.map(k => [k, one(sp[k])]));
  const parsed = customerListQuery.safeParse({ ...raw, page: one(sp.page) });
  const query: CustomerListQuery = parsed.success ? parsed.data : customerListQuery.parse({});
  const { rows, hasNext, totals } = await listCustomers(db(), actor, query);
  const active = Object.entries(raw).filter(([k, v]) => v && v !== DEFAULTS[k]) as [string, string][];
  const filtered = active.length > 0;
  const link = (page: number) => `/customers?${new URLSearchParams({ ...Object.fromEntries(active), page: String(page) })}`;
  const v = (k: string) => raw[k] ?? '';
  return (
    <NavFrame className="ord ws queue" data-workspace="customers">
      <PageHead section="Commerce" title="Customers"
        eyebrow={`${formatNumber(totals.total)} account${totals.total === 1 ? '' : 's'} · ${formatNumber(totals.disabled)} disabled${query.page > 1 ? ` · page ${query.page}` : ''}`} />
      <ModuleViews module="customers" label="Customers" current="/customers" />
      {!parsed.success && <p className="msg error" role="alert">Some filters were not valid and were ignored.</p>}
      <div className="ord-toolbar cust-toolbar">
      <FilterForm debounce={200} role="search" aria-label="Filter customers" data-customer-filters>
        <label className="sr-only" htmlFor="c-q">Search</label>
        <input id="c-q" name="q" className="input" placeholder="Search name, email or phone" defaultValue={query.q ?? ''} />
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
        <details className="more-filters" open={active.some(([k]) => !['q', 'status', 'verified', 'orders'].includes(k)) || undefined}>
          <summary>More filters</summary>
          <div className="actions" data-more-filters>
            <select name="segment" className="input" aria-label="New or existing" defaultValue={v('segment') || 'all'}>
              <option value="all">New and existing</option><option value="new">New (joined in the last 30 days)</option><option value="existing">Existing (joined earlier)</option></select>
            <select name="channel" className="input" aria-label="Where they bought" defaultValue={v('channel') || 'all'}>
              <option value="all">Online or offline</option><option value="online">Bought online</option><option value="offline">Bought in a branch</option></select>
            <select name="payment" className="input" aria-label="How they paid" defaultValue={v('payment') || 'all'}>
              <option value="all">Any payment</option><option value="cod">Used cash on delivery</option><option value="online">Paid online</option></select>
            <input name="minOrders" className="input" inputMode="numeric" placeholder="Orders from" aria-label="At least this many orders" defaultValue={v('minOrders')} />
            <input name="maxOrders" className="input" inputMode="numeric" placeholder="Orders up to" aria-label="At most this many orders" defaultValue={v('maxOrders')} />
            <input name="minSpend" className="input" inputMode="numeric" placeholder="Spent at least ₹" aria-label="Spent at least (rupees)" defaultValue={v('minSpend')} />
            <input name="minPoints" className="input" inputMode="numeric" placeholder="Points from" aria-label="Loyalty points at least" defaultValue={v('minPoints')} />
            <input name="maxPoints" className="input" inputMode="numeric" placeholder="Points up to" aria-label="Loyalty points at most" defaultValue={v('maxPoints')} />
            <label className="inline-label">Last order <input type="date" name="lastOrderFrom" className="input" aria-label="Last order from" defaultValue={v('lastOrderFrom')} /> – <input type="date" name="lastOrderTo" className="input" aria-label="Last order to" defaultValue={v('lastOrderTo')} /></label>
            <label className="inline-label">Joined <input type="date" name="joinedFrom" className="input" aria-label="Joined from" defaultValue={v('joinedFrom')} /> – <input type="date" name="joinedTo" className="input" aria-label="Joined to" defaultValue={v('joinedTo')} /></label>
            <select name="subscribed" className="input" aria-label="Newsletter" defaultValue={v('subscribed') || 'all'}>
              <option value="all">Subscribed or not</option><option value="yes">Subscribed to emails</option><option value="no">Not subscribed</option></select>
            <input name="place" className="input" placeholder="City, state or PIN" aria-label="City, state or PIN (saved addresses)" defaultValue={v('place')} />
            <select name="sort" className="input" aria-label="Sort" defaultValue={v('sort') || 'newest'}>
              <option value="newest">Newest first</option><option value="spend">Highest spend</option><option value="orders">Most orders</option><option value="last_order">Last order</option><option value="points">Most points</option></select>
          </div>
        </details>
        <button className="btn ghost sr-only" type="submit">Apply</button>
      </FilterForm>
      {filtered && <FilterLink className="btn link" group="clear" current={false} href="/customers" data-clear-filters>Clear all</FilterLink>}
      </div>
      {rows.length === 0 ? (
        <Empty title={filtered ? 'No matching customers' : 'No customers yet'} kind="customers"
          action={filtered ? <Link className="btn ghost" href="/customers">Clear filters</Link> : undefined}>
          {filtered ? 'No customer accounts match these filters.' : 'Customer accounts appear here once people sign up on the store.'}
        </Empty>
      ) : (
        <div className="table-wrap ord-table" data-fresh key={link(query.page)}><table data-customers-table>
          <thead><tr><th>Customer</th><th>Account</th><th className="num">Orders</th><th className="num">Lifetime value</th><th className="num">Points</th><th>Last order</th><th>Joined</th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id} data-customer-row={c.email}>
              <td className="ord-who"><NavLink prefetch className="row-link" href={`/customers/${c.id}`}>{c.fullName || c.email}</NavLink>
                <div className="ord-no">{c.email}{c.phone ? <span> · {c.phone}</span> : null}</div></td>
              <td className="ord-stage"><StatusBadge status={c.status} />{!c.verified && <div className="note">email not verified</div>}{c.subscribed ? <div className="note">subscribed to emails</div> : null}</td>
              <td className="num ord-extra" data-label="Orders"><span data-orders-count>{formatNumber(c.ordersCount)}</span>{c.ordersCount > 0 && <div className="note">{formatNumber(c.paidOrdersCount)} paid</div>}</td>
              <td className="num money ord-amount" data-lifetime-value>{formatPaise(c.lifetimeValuePaise)}</td>
              <td className="num ord-extra" data-label="Points" data-points>{formatNumber(c.points)}</td>
              <td className="nowrap ord-extra" data-label="Last order">{c.lastOrderAt ? formatDateTime(c.lastOrderAt) : <span className="note">no orders yet</span>}</td>
              <td className="nowrap ord-placed">{formatDateTime(c.createdAt)}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      {(query.page > 1 || hasNext) && (
        <nav className="pager" aria-label="Customer pages">
          {query.page > 1 ? <FilterLink className="btn ghost sm" group="page" current={false} href={link(query.page - 1)}>← Newer</FilterLink> : <span />}
          <span className="pager-page">Page {query.page}</span>
          {hasNext ? <FilterLink className="btn ghost sm" group="page" current={false} href={link(query.page + 1)}>Older →</FilterLink> : <span />}
        </nav>
      )}
    </NavFrame>
  );
}
