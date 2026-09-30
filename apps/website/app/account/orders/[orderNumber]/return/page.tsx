import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, orderNumberInput } from '@kitsyuu/contracts';
import { customerReturnOptions } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import { ActionForm, Hidden } from '@/components/forms';
import { rupees } from '@/lib/account-format';
import { db, requireCustomer } from '@/lib/server';
import { requestReturnAction } from '../../../erp-actions';

export const metadata: Metadata = { title: 'Request a return' };

/* ERP module 3: only offered while the business has returns switched on, for delivered orders inside the window. */
export default async function ReturnRequestPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const orderNumber = decodeURIComponent((await params).orderNumber);
  const me = await requireCustomer(`/account/orders/${encodeURIComponent(orderNumber)}/return`);
  if (!orderNumberInput.safeParse({ orderNumber }).success) notFound();
  const opts = await customerReturnOptions(db(), me, orderNumber).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  return (
    <>
      <Crumbs list={[{ label: 'Orders', href: '/account/orders' }, { label: orderNumber, href: `/account/orders/${encodeURIComponent(orderNumber)}` }, { label: 'Return' }]} />
      <header className="st-plp-head"><h1 id="st-page-title">Request a return</h1>
        <div className="st-plp-aside"><p>Order {orderNumber}.{opts.allowed && opts.until ? ` Requests are accepted until ${new Date(opts.until).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}.` : ''}</p></div>
      </header>
      {!opts.allowed ? <p className="st-form-alert" role="status" data-returns-closed>{opts.reason}</p> : (
        <ActionForm action={requestReturnAction} submitLabel="Send return request" pendingLabel="Sending…" label="Request a return" id="st-return-form" className="st-auth-form">
          <Hidden name="orderNumber" value={orderNumber} />
          <fieldset className="st-form-group"><legend>Items to return</legend>
            {opts.lines.map(l => (
              <div key={l.id} className="st-field st-field-wide">
                <label htmlFor={`q-${l.id}`}>{l.name} · Size {l.size} · {rupees(l.unit_price_paise)}</label>
                <select id={`q-${l.id}`} name={`qty_${l.id}`} defaultValue="0">
                  {Array.from({ length: l.returnable + 1 }, (_, n) => <option key={n} value={n}>{n === 0 ? 'Not returning' : `${n} of ${l.returnable}`}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
          <div className="st-field st-field-wide">
            <label htmlFor="rt-reason">Reason</label>
            <select id="rt-reason" name="reasonCode" defaultValue="" required>
              <option value="">Choose…</option>{opts.reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
          <div className="st-field st-field-wide">
            <label htmlFor="rt-desc">Tell us more (optional)</label>
            <textarea id="rt-desc" name="description" rows={4} maxLength={2000} className="st-textarea" />
          </div>
          <p className="st-note">Our team reviews every request and tells you the next step. Nothing is refunded or exchanged until the items are back and checked.</p>
        </ActionForm>
      )}
      <p className="st-account-more"><Link className="text-link" href={`/account/orders/${encodeURIComponent(orderNumber)}`}>Back to the order</Link></p>
    </>
  );
}
