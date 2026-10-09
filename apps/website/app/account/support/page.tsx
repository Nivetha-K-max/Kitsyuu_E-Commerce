import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerTickets } from '@kitsyuu/core';
import { StatusPill } from '@/components/account-ui';
import { formatDate } from '@/lib/account-format';
import { TICKET_STATUS_LABEL } from '@/lib/erp-format';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Help & support' };

export default async function SupportPage() {
  const me = await requireCustomer('/account/support');
  const rows = await listCustomerTickets(db(), me);
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Help & support</h1>
        <div className="st-plp-aside"><p><Link className="button" href="/account/support/new" data-new-ticket>Contact us</Link></p></div></header>
      {rows.length === 0 ? <div className="st-acc-empty" data-no-tickets><p>You have not contacted us yet. Questions about an order, a payment or your account? Send us a message.</p></div> : (
        <ul className="st-erp-list st-acc-rows" data-tickets-list>{rows.map(t => (
          <li key={t.number}><Link href={`/account/support/${t.number}`}><b>{t.subject}</b></Link>
            <span><StatusPill status={t.status} label={TICKET_STATUS_LABEL[t.status] ?? t.status} /> {t.number}{t.order_number ? ` · Order ${t.order_number}` : ''} · updated {formatDate(t.updated_at as Date)}</span></li>
        ))}</ul>
      )}
    </>
  );
}
