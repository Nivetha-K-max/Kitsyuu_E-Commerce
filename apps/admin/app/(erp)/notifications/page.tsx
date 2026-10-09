import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { notificationListQuery } from '@kitsyuu/contracts';
import { ALERT_KINDS, listNotificationLog, listStaffNotifications, sweepConditionAlertsThrottled } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { markNotificationsAction } from './actions';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Notifications' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/* ERP module 8: the staff notification centre. Each staff member sees only the kinds their permissions cover (the same
   permission as the page the notification links to), with their own read state. Which kinds are raised at all is set in
   Configuration → Staff alerts. The email outbox (customer emails, sent or failed) is shown to staff with system.read. */
export default async function NotificationsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const parsed = notificationListQuery.safeParse({ show: one(sp.show) || undefined, severity: one(sp.severity) || undefined, page: one(sp.page) || undefined });
  const query = parsed.success ? parsed.data : notificationListQuery.parse({});
  await sweepConditionAlertsThrottled(db());
  const { rows, hasNext } = await listStaffNotifications(db(), actor, query);
  const outbox = can(actor, 'system.read') ? await listNotificationLog(db(), actor, 30) : null;
  const unreadOnPage = rows.filter(r => !r.read);
  const qs = (page: number) => `/notifications?show=${query.show}&severity=${query.severity}&page=${page}`;
  const label = (kind: string) => (ALERT_KINDS as Record<string, { label: string }>)[kind]?.label ?? kind;
  return (
    <Workspace name="notifications" title="Notifications" summary="Alerts for the areas you can access. Choose which kinds are raised in Configuration → Staff alerts."
      actions={<div className="ord-head-actions"><ActionForm action={markNotificationsAction} submitLabel="Mark all as read" variant="ghost" className="inline-form" id="mark-all-read" label="Mark all as read">
          <Hidden name="all" value="true" />
        </ActionForm></div>}>
      <FilterForm aria-label="Filter notifications" data-notification-filters>
        <label className="field inline"><span>Show</span>
          <select name="show" className="input" defaultValue={query.show}><option value="all">All</option><option value="unread">Unread</option></select></label>
        <label className="field inline"><span>Severity</span>
          <select name="severity" className="input" defaultValue={query.severity}>
            <option value="all">All</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option>
          </select></label>
      </FilterForm>
      {rows.length === 0 ? <Empty title={query.show === 'unread' ? 'No unread notifications' : 'No notifications yet'} kind="notifications">
        New orders, payments, low stock, returns, support tickets and other events appear here as they happen.</Empty> : (
        <div className="table-wrap"><table data-notifications-table>
          <thead><tr><th>When</th><th>Notification</th><th>Kind</th><th>Severity</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(n => (
            <tr key={n.id} data-notification={n.id} data-read={n.read ? 'yes' : 'no'}>
              <td className="nowrap">{formatDateTime(n.created_at as Date)}</td>
              <td>{n.read ? n.title : <b>{n.title}</b>}{n.body && <div className="note">{n.body}</div>}</td>
              <td>{label(n.kind)}</td>
              <td><span className={`badge sev-${n.severity}`}>{n.severity}</span></td>
              <td><div className="actions row-actions">
                {n.link && <Link className="btn ghost sm" href={n.link}>Open</Link>}
                {!n.read && <ActionForm action={markNotificationsAction} submitLabel="Mark read" variant="ghost" className="inline-form" id={`read-${n.id}`} label="Mark read">
                  <Hidden name="ids[]" value={n.id} /></ActionForm>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {unreadOnPage.length > 1 && (
        <ActionForm action={markNotificationsAction} submitLabel={`Mark these ${unreadOnPage.length} as read`} variant="ghost" className="inline-form" id="read-page" label="Mark page read">
          {unreadOnPage.map(n => <Hidden key={n.id} name="ids[]" value={n.id} />)}
        </ActionForm>
      )}
      <nav className="pager actions" aria-label="Pages">
        {query.page > 1 && <Link className="btn ghost sm" href={qs(query.page - 1)}>Previous</Link>}
        {hasNext && <Link className="btn ghost sm" href={qs(query.page + 1)}>Next</Link>}
      </nav>
      {outbox && (
        <section className="card" aria-labelledby="outbox-h" data-section="email-outbox">
          <h2 id="outbox-h">Customer email outbox</h2>
          <p className="note">The last 30 customer emails the platform tried to send. Which emails are sent is set in Configuration → Customer emails. Without a configured email provider, messages are only written to the server log.</p>
          {outbox.length === 0 ? <Empty compact title="No customer emails yet" /> : (
            <div className="table-wrap"><table data-outbox-table>
              <thead><tr><th>When</th><th>Email</th><th>To</th><th>Order</th><th>Result</th></tr></thead>
              <tbody>{outbox.map(m => (
                <tr key={String(m.id)}>
                  <td className="nowrap">{formatDateTime(m.created_at as Date)}</td>
                  <td>{m.subject}<div className="note mono">{m.event}</div></td>
                  <td>{m.recipient}</td><td className="mono">{m.order_number ?? '—'}</td>
                  <td><span className={`badge ${m.status === 'sent' ? 'active' : 'failed'}`}>{m.status}</span>{m.error && <div className="note">{m.error}</div>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
    </Workspace>
  );
}
