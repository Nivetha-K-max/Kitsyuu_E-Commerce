import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerOrders, supportCategories } from '@kitsyuu/core';
import { ActionForm, Field } from '@/components/forms';
import { db, requireCustomer } from '@/lib/server';
import { openTicketAction } from '../../erp-actions';

export const metadata: Metadata = { title: 'Contact us' };

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireCustomer('/account/support/new');
  const [categories, orders] = await Promise.all([supportCategories(db()), listCustomerOrders(db(), me)]);
  const preset = (await searchParams).order ?? '';
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Contact us</h1><div className="st-plp-aside"><p>We reply here in your account.</p></div></header>
      <ActionForm action={openTicketAction} submitLabel="Send message" pendingLabel="Sending…" label="Contact us" id="st-ticket-form" className="st-auth-form">
        <div className="st-field st-field-wide">
          <label htmlFor="tk-cat">Topic</label>
          <select id="tk-cat" name="categoryCode" defaultValue="" required><option value="">Choose…</option>{categories.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
        </div>
        <div className="st-field st-field-wide">
          <label htmlFor="tk-order">Order (optional)</label>
          <select id="tk-order" name="orderNumber" defaultValue={preset}><option value="">Not about an order</option>{orders.map(o => <option key={o.orderNumber} value={o.orderNumber}>{o.orderNumber}</option>)}</select>
        </div>
        <Field name="subject" label="Subject" maxLength={160} required wide />
        <div className="st-field st-field-wide">
          <label htmlFor="tk-body">Message</label>
          <textarea id="tk-body" name="body" rows={6} maxLength={4000} required className="st-textarea" />
        </div>
      </ActionForm>
      <p className="st-footnote"><Link href="/account/support">Back to your messages</Link></p>
    </>
  );
}
