import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cancelReturnInput, NotFoundError } from '@kitsyuu/contracts';
import { getCustomerReturn } from '@kitsyuu/core';
import { Crumbs } from '@/components/ui';
import { ActionForm, Hidden } from '@/components/forms';
import { formatDateTime, rupees } from '@/lib/account-format';
import { RETURN_STATUS_LABEL } from '@/lib/erp-format';
import { db, requireCustomer } from '@/lib/server';
import { cancelReturnAction } from '../../erp-actions';

export const metadata: Metadata = { title: 'Return' };

export default async function ReturnPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const number = decodeURIComponent((await params).number);
  const me = await requireCustomer(`/account/returns/${encodeURIComponent(number)}`);
  if (!cancelReturnInput.safeParse({ returnNumber: number }).success) notFound();
  const r = await getCustomerReturn(db(), me, number).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const sent = (await searchParams).sent === '1';
  return (
    <>
      <Crumbs list={[{ label: 'Returns', href: '/account/returns' }, { label: r.number }]} />
      <header className="st-plp-head"><h1 id="st-page-title">Return {r.number}</h1>
        <div className="st-plp-aside"><p className="st-result-count" data-return-status={r.status}>{RETURN_STATUS_LABEL[r.status] ?? r.status}</p><p>Order {r.order_number} · {r.reason}</p></div></header>
      {sent && <p className="st-form-ok" role="status">Your return request was sent. We will review it and let you know the next step.</p>}
      <section className="st-form-group"><h2>Items</h2>
        <ul className="st-mini">{r.items.map(i => <li key={i.id}><span className="st-mini-info"><b>{i.name}</b><small>Size {i.size} · Qty {i.qty}</small></span></li>)}</ul>
        {r.description && <p>{r.description}</p>}
        {r.pickup_at && <p>Pickup: {formatDateTime(r.pickup_at as Date)}</p>}
        {r.status === 'refunded' && r.refund_amount_paise && <p>Refund of {rupees(r.refund_amount_paise)} made. How long it takes to reach you depends on your bank or payment method.</p>}
      </section>
      <section className="st-form-group"><h2>Progress</h2>
        <ol className="st-order-timeline">{r.events.map((e, n) => <li key={n}><span>{RETURN_STATUS_LABEL[e.to_status] ?? e.to_status}</span><time dateTime={new Date(e.created_at as Date).toISOString()}>{formatDateTime(e.created_at as Date)}</time></li>)}</ol>
      </section>
      {['requested', 'under_review', 'info_requested'].includes(r.status) && (
        <ActionForm action={cancelReturnAction} submitLabel="Cancel this return request" buttonClass="button button-outline" confirmText="Cancel this return request?" label="Cancel return" id="st-return-cancel">
          <Hidden name="returnNumber" value={r.number} />
        </ActionForm>
      )}
      <p className="st-account-more"><Link className="text-link" href="/account/support/new">Questions? Contact us</Link></p>
    </>
  );
}
