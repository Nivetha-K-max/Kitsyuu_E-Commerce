import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { promotionReport } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import MarketingNav from '../MarketingNav';

export const metadata: Metadata = { title: 'Promotion report' };

export default async function PromotionReportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(30);
  const range = { from: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : d.from, to: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : d.to };
  const rows = await promotionReport(db(), actor, range);
  return (
    <>
      <PageHead title="Marketing" eyebrow="Discount and coupon use on paid orders in the period (from recorded redemptions)." />
      <MarketingNav current="/marketing/report" />
      <RangeForm from={range.from} to={range.to} />
      {rows.length === 0 ? <Empty title="No discounts were used in this period" kind="promotions" /> : (
        <div className="table-wrap"><table data-promotion-report>
          <thead><tr><th>Discount</th><th>Campaign</th><th className="num">Orders</th><th className="num">Customers</th><th className="num">Discount given</th><th className="num">Order revenue</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id}><td>{r.name}{r.code && <div className="note mono">{r.code}</div>}</td><td>{r.campaign_name ?? '—'}</td><td className="num">{formatNumber(r.uses)}</td>
              <td className="num">{formatNumber(r.customers)}</td><td className="num money">{formatPaise(r.discount_paise)}</td><td className="num money">{formatPaise(r.revenue_paise)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
