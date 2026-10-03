import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { cartListQuery } from '@kitsyuu/contracts';
import { listCarts } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import SubNav from '@/components/SubNav';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Carts & wishlists' };
const VIEWS = [['active', 'Active'], ['abandoned', 'Abandoned'], ['converted', 'Ordered'], ['all', 'All']] as const;

/* ERP module 7: customer carts, read-only. Staff never change a customer's cart; they can only track recovery of an
   abandoned one and (when switched on) send one reminder email. Values are today's prices; stock is not held for carts. */
export default async function CartsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'carts.read')) return <><PageHead title="Carts & wishlists" /><Forbidden permission="carts.read" /></>;
  const sp = await searchParams;
  const parsed = cartListQuery.safeParse({ view: one(sp.view) || undefined, q: one(sp.q), page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : cartListQuery.parse({});
  const list = await listCarts(db(), actor, query);
  const s = list.summary;
  const qs = (v: string, p = 1) => `/carts?view=${v}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}&page=${p}`;
  return (
    <>
      <PageHead title="Carts & wishlists" eyebrow={list.hours ? `A cart counts as abandoned after ${list.hours} hours without changes.` : 'No abandoned-cart threshold is set (Configuration → Carts), so no cart is counted as abandoned.'} />
      <SubNav label="Carts" current="/carts" items={[{ href: '/carts', label: 'Carts' }, { href: '/carts/checkouts', label: 'Abandoned checkouts' }, { href: '/carts/wishlists', label: 'Wishlists' }]} />
      <dl className="report-kpis" data-cart-kpis>
        <div><dt>Active carts</dt><dd>{formatNumber(s.active)}</dd></div>
        <div><dt>Abandoned carts</dt><dd>{formatNumber(s.abandoned)}<small>{formatPaise(s.abandoned_value)} at today’s prices</small></dd></div>
        <div><dt>Carts that became orders</dt><dd>{formatNumber(s.converted)}</dd></div>
        <div><dt>Marked recovered</dt><dd>{formatNumber(s.recovered)}</dd></div>
      </dl>
      <nav className="tabs actions" aria-label="Carts">{VIEWS.map(([v, l]) => <Link key={v} className={`btn sm ${v === query.view ? '' : 'ghost'}`} href={qs(v)} aria-current={v === query.view ? 'page' : undefined}>{l}</Link>)}</nav>
      <FilterForm className="actions" role="search" aria-label="Search carts">
        <input type="hidden" name="view" value={query.view} />
        <label className="sr-only" htmlFor="ct-q">Customer</label>
        <input id="ct-q" name="q" className="input" placeholder="Customer email or name" defaultValue={query.q ?? ''} />
        <button className="btn ghost" type="submit">Search</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No carts here" kind="carts" /> : (
        <div className="table-wrap"><table data-carts-table>
          <thead><tr><th>Customer</th><th className="num">Units</th><th className="num">Value</th><th>Coupon</th><th>Last activity</th><th>Recovery</th></tr></thead>
          <tbody>{list.rows.map(c => (
            <tr key={c.id} data-cart={c.email ?? c.id}>
              <td><Link className="row-link" href={`/carts/${c.id}`}>{c.email ?? 'Guest cart'}</Link>{c.full_name && <div className="note">{c.full_name}</div>}<div><StatusBadge status={c.status} /></div></td>
              <td className="num">{c.units}</td><td className="num money">{formatPaise(c.value_paise)}</td><td className="mono">{c.coupon_code ?? '—'}</td>
              <td className="nowrap">{formatDateTime(c.last_activity as Date)}</td>
              <td>{c.recovery_status ? <StatusBadge status={c.recovery_status} /> : '—'}{c.email_count ? <div className="note">{c.email_count} reminder(s)</div> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {query.page > 1 && <Link className="btn ghost sm" href={qs(query.view, query.page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(query.view, query.page + 1)}>Next</Link>}
      </nav>
    </>
  );
}
