import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listSubscribers, NEWSLETTER_CONSENT } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { unsubscribeAction } from '../actions';
import MarketingNav from '../MarketingNav';

export const metadata: Metadata = { title: 'Newsletter subscribers' };

/* Client change request: people who signed up in the store, with their consent. No newsletter is sent from here (no
   marketing-email provider is set up yet). */
export default async function SubscribersPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const sp = await searchParams;
  const status = (['all', 'subscribed', 'unsubscribed'].includes(one(sp.status)) ? one(sp.status) : 'subscribed') as 'all' | 'subscribed' | 'unsubscribed';
  const q = one(sp.q).trim().slice(0, 80) || undefined;
  const page = pageOf(sp.page);
  const list = await listSubscribers(db(), actor, { q, status, page });
  const qs = (p: number) => `/marketing/subscribers?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}&page=${p}`;
  return (
    <>
      <PageHead title="Marketing" eyebrow={`${formatNumber(list.counts.subscribed)} subscribed · ${formatNumber(list.counts.unsubscribed)} unsubscribed. Consent wording: “${NEWSLETTER_CONSENT}”`}>
        {can(actor, 'customers.read') && <a className="btn ghost" href="/marketing/subscribers/export" download data-subscribers-export>Download CSV</a>}
      </PageHead>
      <MarketingNav current="/marketing/subscribers" />
      <FilterForm className="actions" role="search" aria-label="Filter subscribers" data-subscriber-filters>
        <label className="sr-only" htmlFor="ns-q">Email</label>
        <input id="ns-q" name="q" className="input" placeholder="Email" defaultValue={q ?? ''} />
        <label className="sr-only" htmlFor="ns-s">Status</label>
        <select id="ns-s" name="status" className="input" defaultValue={status}><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option><option value="all">All</option></select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No subscribers here" kind="subscribers">People who sign up for the newsletter in the store appear here.</Empty> : (
        <div className="table-wrap"><table data-subscribers-table>
          <thead><tr><th>Email</th><th>Status</th><th>Signed up</th><th>Where</th><th>Unsubscribed</th>{can(actor, 'marketing.manage') && <th />}</tr></thead>
          <tbody>{list.rows.map(s => (
            <tr key={s.id} data-subscriber={s.email}>
              <td>{s.customer_id && can(actor, 'customers.read') ? <Link href={`/customers/${s.customer_id}`}>{s.email}</Link> : s.email}</td>
              <td><StatusBadge status={s.status === 'subscribed' ? 'active' : 'inactive'} /></td>
              <td className="nowrap">{formatDateTime(s.consented_at as Date)}</td><td>{s.source}</td><td className="nowrap">{formatDateTime(s.unsubscribed_at as Date | null)}</td>
              {can(actor, 'marketing.manage') && <td>{s.status === 'subscribed' && <ActionForm action={unsubscribeAction} submitLabel="Unsubscribe" variant="danger" className="inline-form"
                id={`unsub-${s.id}`} label="Unsubscribe" confirmText={`Unsubscribe ${s.email}? Only the person can sign up again.`}><Hidden name="subscriberId" value={s.id} /></ActionForm>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={qs(page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(page + 1)}>Next</Link>}
      </nav>
    </>
  );
}
