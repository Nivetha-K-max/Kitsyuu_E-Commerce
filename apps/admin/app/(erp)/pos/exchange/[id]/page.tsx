import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getOrderForCounter, posContext } from '@kitsyuu/core';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, productImageUrl, requireActor } from '@/lib/server';
import { Workspace } from '@/components/frame';
import ExchangeCounter from './ExchangeCounter';

export const metadata: Metadata = { title: 'Return / exchange' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

/* Return or exchange at the counter (2026-10-13): the original order, what can still be returned, and the one-step
   settlement (core pos-exchange.ts). Needs an open cashier session: the stock comes into that branch. */
export default async function PosExchangePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }, { href: '/pos/orders', label: 'Find an order' }];
  for (const p of ['pos.access', 'orders.read', 'returns.manage']) if (!can(actor, p)) return <><PageHead title="Return / exchange" crumbs={crumbs} /><Forbidden permission={p} /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = await getOrderForCounter(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const [c, reasons] = await Promise.all([posContext(db(), actor),
    db().selectFrom('return_reasons').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute()]);
  const o = v.order, number = o.pos_number ?? o.order_number;
  // After saving: the outcome, read back from the saved return (it survives a refresh and cannot show a figure that was not saved).
  const doneId = String((await searchParams).done ?? '');
  const done = /^[0-9a-f-]{36}$/i.test(doneId) ? v.returns.find(r => r.id === doneId && !!r.settlement) ?? null : null;
  if (done) {
    const amount = formatPaise(done.settlement_paise ?? 0);
    return (
      <Workspace name="pos-exchange" title={`Return ${done.number} saved`} crumbs={crumbs} summary={`For ${number}`}>
        <section className="pos-done card" data-exchange-done aria-live="polite">
          <h2>Return {done.number} saved</h2>
          <p className="pos-done-total" data-exchange-outcome={done.settlement}>
            {done.settlement === 'collect' ? `Collected ${amount}` : done.settlement === 'store_credit' ? `Store credit issued ${amount}` : done.settlement === 'refund' ? `Refund ${amount}: give it to the customer` : 'Even — nothing more to settle'}
          </p>
          <div className="pos-done-actions">
            {done.exchange_order_id && <a className="btn pos-big" href={`/pos/sale/${done.exchange_order_id}?print=1`} target="_blank" rel="noreferrer" data-exchange-print>Print replacement bill</a>}
            <Link className="btn ghost pos-big" href={`/returns/${done.id}`}>View return</Link>
            <Link className="btn primary pos-big" href="/pos" data-exchange-new>Back to the counter</Link>
          </div>
        </section>
      </Workspace>
    );
  }
  return (
    <Workspace name="pos-exchange" title={`Return / exchange · ${number}`} crumbs={crumbs}
      summary={`${o.channel === 'online' ? 'Website order' : o.location_name ?? 'Branch sale'} · ${formatDateTime(o.created_at as Date)} · ${formatPaise(o.total_paise)}${v.customer ? ` · ${v.customer.full_name ?? v.customer.email}` : ' · walk-in customer'}`}>
      {v.returns.length > 0 && (
        <p className="note" data-exchange-history>Returns on this order: {v.returns.map(r => <span key={r.id}><Link href={`/returns/${r.id}`}>{r.number}</Link> ({r.status.replace(/_/g, ' ')}{r.settlement ? `, ${r.settlement.replace(/_/g, ' ')} ${formatPaise(r.settlement_paise ?? 0)}` : ''}){' '}</span>)}</p>
      )}
      {!v.eligible ? <p className="msg error" role="status" data-exchange-blocked>{v.reason}</p>
        : !c.session ? <p className="msg" role="status" data-exchange-no-session>Open a cashier session first: returned stock comes into the branch of your session. <Link href="/pos">Open a session</Link></p>
        : v.lines.every(l => l.returnable === 0) ? <p className="msg" role="status" data-exchange-nothing>Everything on this order has already been returned.</p>
        : <ExchangeCounter orderId={o.id} number={number} session={{ id: c.session.id, location_id: c.session.location_id, location_name: c.session.location_name }}
            lines={v.lines.map(l => ({ id: l.id, name: l.name, size: l.size, colour: l.colour, sku: l.sku, bought: l.qty, returnable: l.returnable, unitValuePaise: l.unitValuePaise, image: productImageUrl(l.image_path) }))}
            reasons={reasons} hasCustomer={!!v.customer} canStoreCredit={v.can.storeCredit} canRefund={v.can.refund} />}
    </Workspace>
  );
}
