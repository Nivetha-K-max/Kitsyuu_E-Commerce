import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { getReturn } from '@kitsyuu/core';
import { NavFrame } from '@/components/NavFrame';
import { Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';
import { ReturnPanel } from '../../orders/[id]/return-panel';

export const metadata: Metadata = { title: 'Return' };

/* A return is handled on its order's Returns tab (2026-10-07: one record, one workflow). This address is kept so old
   links and emails still work: it opens the order on that tab with this return selected. Staff who may see returns but
   not orders (returns.read without orders.read) get the same return panel here, on its own. */
export default async function ReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/returns', label: '← Back to returns' }];
  if (!can(actor, 'returns.read')) return <><PageHead title="Return" crumbs={crumbs} /><Forbidden permission="returns.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  if (can(actor, 'orders.read')) {
    const r = await db().selectFrom('return_requests').select('order_id').where('id', '=', id).executeTakeFirst();
    if (!r) notFound();
    redirect(`/orders/${r.order_id}?tab=returns&return=${id}`);
  }
  const data = await getReturn(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  return (
    <NavFrame className="ord ent" data-entity="return">
      <PageHead title={`Return ${data.ret.number}`} eyebrow={`Order ${data.ret.order_number} · ${data.ret.customer_name ?? data.ret.customer_email ?? 'customer'}`} crumbs={crumbs} />
      <div className="ent-body"><div className="ent-panel"><ReturnPanel actor={actor} data={data} /></div></div>
    </NavFrame>
  );
}
