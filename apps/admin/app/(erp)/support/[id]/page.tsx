import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, TICKET_PRIORITIES, TICKET_STATUSES } from '@kitsyuu/contracts';
import { getTicket } from '@kitsyuu/core';
import { ActionForm, Checkbox, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { replyTicketAction, updateTicketAction } from '../actions';
import { Entity, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';

export const metadata: Metadata = { title: 'Ticket' };

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/support', label: 'Support' }];
  if (!can(actor, 'support.read')) return <><PageHead title="Ticket" crumbs={crumbs} /><Forbidden permission="support.read" /></>;
  const { id } = await params;
  let data;
  try { data = await getTicket(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { ticket: t, messages, staff, categories } = data;
  const manage = can(actor, 'support.manage');
  const seeAudit = can(actor, 'audit.read');
  const tab = (await searchParams).tab === 'activity' && seeAudit ? 'activity' : 'main';
  const selfHref = `/support/${t.id}`;
  return (
    <Entity module={{ href: '/support', label: 'Support' }} name="ticket" title={t.subject}
      factsAttr="data-ticket-facts"
      facts={[{ label: 'Ticket', value: <span className="mono">{t.number}</span> }, { label: 'From', value: `${t.contact_email}${t.contact_name ? ` (${t.contact_name})` : ''}` }, { label: 'Opened', value: formatDateTime(t.created_at as Date) }]}
      tabs={[{ id: 'main', label: 'Conversation' }, ...(seeAudit ? [{ id: 'activity', label: 'Activity' }] : [])]} current={tab} tabHref={x => (x === 'main' ? selfHref : `${selfHref}?tab=${x}`)}
      actions={<div className="ord-head-actions">
        {t.order_id && can(actor, 'orders.read') && <Link className="btn ghost" href={`/orders/${t.order_id}`}>Order {t.order_number}</Link>}
        {t.customer_id && can(actor, 'customers.read') && <Link className="btn ghost" href={`/customers/${t.customer_id}`}>Customer</Link>}
      </div>}>
      {tab === 'activity' && (
        <Section id="act-h" title="Activity" name="activity" wide hint="Changes to this ticket, from the audit log.">
          <RecordActivity entityType="support_tickets" entityId={t.id} name="ticket" empty="Changes to this ticket are listed here as they are made." />
        </Section>
      )}
      {tab === 'main' && <>
      <div className="grid-2">
        <section className="card" aria-labelledby="tm-h" data-section="ticket-messages">
          <h2 id="tm-h">Conversation</h2>
          <ol className="timeline" data-messages>{messages.map(m => (
            <li key={m.id} className={m.is_internal ? 'internal' : undefined} data-message={m.is_internal ? 'internal' : m.author_type}>
              <span className="who">{m.author_type === 'customer' ? 'Customer' : m.staff_email ?? 'Staff'}{m.is_internal ? ' · internal note (not visible to the customer)' : ''} · {formatDateTime(m.created_at as Date)}</span>
              <p className="msg-body">{m.body}</p>
            </li>
          ))}</ol>
          {manage && (
            <ActionForm action={replyTicketAction} submitLabel="Send" id="ticket-reply-form" label="Reply" resetOnSuccess>
              <Hidden name="ticketId" value={t.id} />
              <TextArea name="body" label="Message" rows={4} required />
              <Checkbox name="internal" label="Internal note (staff only; never shown or emailed to the customer)" />
              <Select name="status" label="Then set status to" options={[{ value: '', label: 'Automatic (waiting for the customer after a reply)' }, ...TICKET_STATUSES.map(s => ({ value: s, label: s.replace(/_/g, ' ') }))]} />
            </ActionForm>
          )}
        </section>
        <section className="card" aria-labelledby="td-h" data-section="ticket-details">
          <h2 id="td-h">Details</h2>
          <dl className="dl-grid">
            <dt>Status</dt><dd><StatusBadge status={t.status} /></dd>
            <dt>Priority</dt><dd><span className={`badge ${t.priority}`}>{t.priority}</span></dd>
            <dt>Assigned to</dt><dd>{t.assignee ?? '—'}</dd>
            <dt>Channel</dt><dd>{t.channel === 'staff' ? 'Opened by staff' : 'From the store'}</dd>
            {t.resolved_at && <><dt>Resolved</dt><dd>{formatDateTime(t.resolved_at as Date)}</dd></>}
            {t.closed_at && <><dt>Closed</dt><dd>{formatDateTime(t.closed_at as Date)}</dd></>}
          </dl>
          {manage && (
            <ActionForm action={updateTicketAction} submitLabel="Update ticket" id="ticket-update-form" label="Update ticket">
              <Hidden name="ticketId" value={t.id} />
              <Select name="status" label="Status" defaultValue={t.status} options={TICKET_STATUSES.map(s => ({ value: s, label: s.replace(/_/g, ' ') }))} />
              <Select name="priority" label="Priority" defaultValue={t.priority} options={TICKET_PRIORITIES.map(p => ({ value: p, label: p }))} />
              <Select name="categoryCode" label="Category" defaultValue={t.category_code} options={categories.map(c => ({ value: c.code, label: c.label }))} />
              <Select name="assignedTo" label="Assigned to" defaultValue={t.assigned_to ?? ''} options={[{ value: '', label: 'Nobody' }, ...staff.map(s => ({ value: s.id, label: s.full_name ? `${s.full_name} (${s.email})` : s.email }))]} />
            </ActionForm>
          )}
        </section>
      </div>
      </>}
    </Entity>
  );
}
