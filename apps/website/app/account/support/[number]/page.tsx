import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { customerTicketReplyInput, NotFoundError } from '@kitsyuu/contracts';
import { getCustomerTicket } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import { ActionForm, Hidden } from '@/components/forms';
import { formatDateTime } from '@/lib/account-format';
import { TICKET_STATUS_LABEL } from '@/lib/erp-format';
import { db, requireCustomer } from '@/lib/server';
import { replyTicketAction } from '../../erp-actions';

export const metadata: Metadata = { title: 'Message' };

export default async function TicketPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const number = decodeURIComponent((await params).number);
  const me = await requireCustomer(`/account/support/${encodeURIComponent(number)}`);
  if (!customerTicketReplyInput.safeParse({ ticketNumber: number, body: 'x' }).success) notFound();
  const t = await getCustomerTicket(db(), me, number).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const sent = (await searchParams).sent === '1';
  return (
    <>
      <Crumbs list={[{ label: 'Help & support', href: '/account/support' }, { label: t.number }]} />
      <header className="st-plp-head"><h1 id="st-page-title">{t.subject}</h1>
        <div className="st-plp-aside"><p className="st-result-count" data-ticket-status={t.status}>{TICKET_STATUS_LABEL[t.status] ?? t.status}</p>
          <p>{t.number} · {t.category}{t.order_number ? ` · Order ${t.order_number}` : ''}</p></div></header>
      {sent && <p className="st-form-ok" role="status">Your message was sent. We reply here.</p>}
      <ol className="st-ticket-thread" data-ticket-thread>{t.messages.map(m => (
        <li key={m.id} className={m.author_type === 'customer' ? 'is-you' : 'is-us'} data-author={m.author_type}>
          <p className="st-ticket-who">{m.author_type === 'customer' ? 'You' : 'KITSYUU'} · {formatDateTime(m.created_at as Date)}</p>
          <p className="st-ticket-body">{m.body}</p>
        </li>
      ))}</ol>
      {t.status === 'closed' ? <p className="st-note">This conversation is closed. <a href="/account/support/new">Send a new message</a> if you need more help.</p> : (
        <ActionForm action={replyTicketAction} submitLabel="Send reply" pendingLabel="Sending…" label="Reply" id="st-ticket-reply" className="st-auth-form" resetOnSuccess>
          <Hidden name="ticketNumber" value={t.number} />
          <div className="st-field st-field-wide">
            <label htmlFor="tk-reply">Your reply</label>
            <textarea id="tk-reply" name="body" rows={4} maxLength={4000} required className="st-textarea" />
          </div>
        </ActionForm>
      )}
    </>
  );
}
