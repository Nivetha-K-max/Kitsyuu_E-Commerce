import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { customerEmailEnabled, listAbandonedCheckouts } from '@kitsyuu/core';
import { ActionForm } from '@/components/forms';
import SubNav from '@/components/SubNav';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { pageOf, type SP } from '@/lib/erp';
import { db, mailer, requireActor } from '@/lib/server';
import { sendCheckoutRemindersAction } from '../actions';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Abandoned checkouts' };

/* Client change request: orders placed but not paid after the abandoned-checkout time (24 hours unless changed in Configuration).
   One reminder per order at most, only with the reminder switch on and a real email provider configured. */
export default async function AbandonedCheckoutsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'carts.read')) return <><PageHead title="Carts & wishlists" /><Forbidden permission="carts.read" /></>;
  const page = pageOf((await searchParams).page);
  const [list, on] = await Promise.all([listAbandonedCheckouts(db(), actor, { page }), customerEmailEnabled(db(), 'checkout.reminder')]);
  const provider = mailer().kind !== 'console';
  const state = !on ? 'Reminder emails are OFF (Configuration → Customer emails).' : !provider ? 'Reminder emails are on, but no email provider is configured, so nothing is sent.' : 'Reminder emails are on.';
  return (
    <Workspace name="carts-checkouts" title="Carts & wishlists" summary={`Orders still unpaid ${list.hours} hours after they were placed · ${list.total} now. ${state}`}>
      <SubNav label="Carts" current="/carts/checkouts" items={[{ href: '/carts', label: 'Carts' }, { href: '/carts/checkouts', label: 'Abandoned checkouts' }, { href: '/carts/wishlists', label: 'Wishlists' }]} />
      {can(actor, 'carts.manage') && on && provider && (
        <ActionForm action={sendCheckoutRemindersAction} submitLabel="Send due reminders now" variant="ghost" className="inline-form" id="send-checkout-reminders" label="Send reminders"
          confirmText="Email one reminder to each abandoned checkout that has not had one?" />
      )}
      {list.rows.length === 0 ? <Empty title="No abandoned checkouts" kind="abandoned-checkouts">Unpaid orders appear here once they are older than the abandoned-checkout time.</Empty> : (
        <div className="table-wrap"><table data-abandoned-checkouts>
          <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Status</th><th className="num">Total</th><th>Placed</th><th>Last activity</th><th>Reminder</th></tr></thead>
          <tbody>{list.rows.map(o => (
            <tr key={o.id} data-abandoned={o.order_number}>
              <td className="mono">{can(actor, 'orders.read') ? <Link href={`/orders/${o.id}`}>{o.order_number}</Link> : o.order_number}</td>
              <td>{o.customer_id && can(actor, 'customers.read') ? <Link href={`/customers/${o.customer_id}`}>{o.name ?? o.email}</Link> : (o.name ?? o.email ?? '—')}{o.name && o.email ? <div className="note">{o.email}</div> : null}</td>
              <td>{o.units} unit{o.units === 1 ? '' : 's'}<div className="note">{o.items}</div></td><td><StatusBadge status={o.status} /></td><td className="num money">{formatPaise(o.total_paise)}</td>
              <td className="nowrap">{formatDateTime(o.created_at as Date)}</td>
              <td className="nowrap">{formatDateTime(o.updated_at as Date)}</td>
              <td>{o.reminder_status ? <><StatusBadge status={o.reminder_status} />{o.reminder_sent_at && <div className="note">{formatDateTime(o.reminder_sent_at as Date)}</div>}{o.reminder_error && <div className="note">{o.reminder_error}</div>}</> : <span className="muted">not sent</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={`/carts/checkouts?page=${page - 1}`}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={`/carts/checkouts?page=${page + 1}`}>Next</Link>}
      </nav>
    </Workspace>
  );
}
