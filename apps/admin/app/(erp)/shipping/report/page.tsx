import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { DomainError } from '@kitsyuu/contracts';
import { shippingReport } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import ShippingNav from '../ShippingNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Shipping report' };

export default async function ShippingReportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'shipping.read')) return <><PageHead title="Shipping" /><Forbidden permission="shipping.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(30);
  const range = { from: one(sp.from) || d.from, to: one(sp.to) || d.to };
  let r: Awaited<ReturnType<typeof shippingReport>> | null = null; let error: string | null = null;
  try { if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.from > range.to) throw new DomainError('invalid', 'Choose a valid date range.'); r = await shippingReport(db(), actor, range); }
  catch (e) { if (e instanceof DomainError) error = e.message; else throw e; }
  return (
    <Workspace name="shipping-report" title="Shipping" summary="Shipments dispatched in the period, by courier; delivery charges collected on paid orders.">
      <ShippingNav current="/shipping/report" />
      <RangeForm from={range.from} to={range.to} />
      {error && <p className="msg error" role="alert">{error}</p>}
      {r && <>
        <dl className="report-kpis" data-shipping-kpis>
          <div><dt>Paid orders</dt><dd>{formatNumber(r.charges.orders)}</dd></div>
          <div><dt>Delivery charges collected</dt><dd>{formatPaise(r.charges.shipping_paise)}</dd></div>
          <div><dt>Orders with free delivery</dt><dd>{formatNumber(r.charges.free)}</dd></div>
        </dl>
        <section className="card" aria-labelledby="bc-h"><h2 id="bc-h">By courier</h2>
          {r.byCourier.length === 0 ? <Empty compact title="Nothing shipped in this period" /> : (
            <div className="table-wrap"><table data-report-couriers>
              <thead><tr><th>Courier</th><th className="num">Shipped</th><th className="num">Delivered</th><th className="num">Failed attempts</th><th className="num">Avg. days to deliver</th></tr></thead>
              <tbody>{r.byCourier.map(c => <tr key={c.carrier_code}><td>{c.courier_name ?? c.carrier_code}</td><td className="num">{c.shipped}</td><td className="num">{c.delivered}</td>
                <td className="num">{c.failed}</td><td className="num">{c.avg_days ?? '—'}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
        <section className="card" aria-labelledby="bs-h"><h2 id="bs-h">Current status of those shipments</h2>
          {r.byStatus.length === 0 ? <Empty compact title="No shipments" /> : <p>{r.byStatus.map(s => <span key={s.status}><StatusBadge status={s.status} /> {s.n} </span>)}</p>}
        </section>
      </>}
    </Workspace>
  );
}
