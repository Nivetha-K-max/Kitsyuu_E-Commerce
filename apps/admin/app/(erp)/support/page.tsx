import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { TICKET_PRIORITIES, TICKET_STATUSES, ticketListQuery } from '@kitsyuu/contracts';
import { listTickets, supportCategories } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import SupportNav from './SupportNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Support' };

/* ERP module 5: customer support tickets, most urgent first. */
export default async function SupportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'support.read')) return <><PageHead title="Support" /><Forbidden permission="support.read" /></>;
  const sp = await searchParams;
  const parsed = ticketListQuery.safeParse({ q: one(sp.q), status: one(sp.status) || undefined, priority: one(sp.priority) || undefined,
    assignee: one(sp.assignee) || undefined, category: one(sp.category), page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : ticketListQuery.parse({});
  const [list, categories] = await Promise.all([listTickets(db(), actor, query), supportCategories(db())]);
  const qs = (p: number) => `/support?status=${query.status}&priority=${query.priority}&assignee=${query.assignee}${query.category ? `&category=${query.category}` : ''}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}&page=${p}`;
  const open = (list.counts.open ?? 0) + (list.counts.assigned ?? 0) + (list.counts.in_progress ?? 0);
  return (
    <Workspace name="support" title="Support" summary={`${open} open with staff · ${list.counts.waiting_customer ?? 0} waiting for the customer`}>
      <SupportNav current="/support" manage={can(actor, 'support.manage')} />
      <FilterForm className="actions" role="search" aria-label="Filter tickets" data-ticket-filters>
        <label className="sr-only" htmlFor="tk-q">Search</label>
        <input id="tk-q" name="q" className="input" placeholder="Ticket, subject, email or order" defaultValue={query.q ?? ''} />
        <label className="sr-only" htmlFor="tk-s">Status</label>
        <select id="tk-s" name="status" className="input" defaultValue={query.status}>
          <option value="active">Active</option><option value="all">All</option>{TICKET_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <label className="sr-only" htmlFor="tk-p">Priority</label>
        <select id="tk-p" name="priority" className="input" defaultValue={query.priority}><option value="all">Any priority</option>{TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <label className="sr-only" htmlFor="tk-a">Assignee</label>
        <select id="tk-a" name="assignee" className="input" defaultValue={query.assignee}><option value="all">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option></select>
        <label className="sr-only" htmlFor="tk-c">Category</label>
        <select id="tk-c" name="category" className="input" defaultValue={query.category ?? ''}><option value="">All categories</option>{categories.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No tickets here" kind="tickets">Customers open tickets from their account; staff can open one for a phone or email enquiry.</Empty> : (
        <div className="table-wrap"><table data-tickets-table>
          <thead><tr><th>Ticket</th><th>Customer</th><th>Category</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Last update</th></tr></thead>
          <tbody>{list.rows.map(t => (
            <tr key={t.id} data-ticket={t.number}>
              <td><Link className="row-link" href={`/support/${t.id}`}><b>{t.subject}</b></Link><div className="note mono">{t.number}{t.order_number ? ` · ${t.order_number}` : ''}</div></td>
              <td>{t.contact_email}<div className="note">{t.channel === 'staff' ? 'opened by staff' : 'from the store'}</div></td>
              <td>{t.category}</td><td><span className={`badge ${t.priority}`}>{t.priority}</span></td><td><StatusBadge status={t.status} /></td>
              <td>{t.assignee ?? <span className="muted">—</span>}</td><td className="nowrap">{formatDateTime(t.updated_at as Date)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {query.page > 1 && <Link className="btn ghost sm" href={qs(query.page - 1)}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={qs(query.page + 1)}>Next</Link>}
      </nav>
    </Workspace>
  );
}
