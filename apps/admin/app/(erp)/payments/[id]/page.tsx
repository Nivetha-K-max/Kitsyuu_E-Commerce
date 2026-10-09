import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { getOrderPayment } from '@kitsyuu/core';
import { NavFrame } from '@/components/NavFrame';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { PaymentPanel } from '../../orders/[id]/payment-panel';

export const metadata: Metadata = { title: 'Payment' };
type Params = Promise<{ id: string }>;

/* A payment is managed on its order's Payment tab (2026-10-07: one record, one workflow). This address is kept so old
   links and bookmarks still work: it opens the order on that tab. Staff who may see payments but not orders
   (billing.read without orders.read) get the same payment panel here, on its own. */
export default async function PaymentPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/payments', label: '← Back to payments' }];
  if (!can(actor, 'billing.read')) return <><PageHead section="Commerce" title="Payment" crumbs={crumbs} /><Forbidden permission="billing.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  if (can(actor, 'orders.read')) redirect(`/orders/${id}?tab=payment`);
  const d = await getOrderPayment(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  return (
    <NavFrame className="ord ent" data-entity="payment">
      <PageHead section="Commerce" title={`Payment · ${d.order.order_number}`} eyebrow={d.order.contact_name ?? d.order.contact_email ?? 'No customer details'} crumbs={crumbs} />
      <div className="ent-body"><div className="ent-panel"><PaymentPanel actor={actor} d={d} returnsHref="/returns?" /></div></div>
    </NavFrame>
  );
}
