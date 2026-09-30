import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { returnsReport } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import ReturnsNav from '../ReturnsNav';

export const metadata: Metadata = { title: 'Returns report' };

export default async function ReturnsReportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'returns.read')) return <><PageHead title="Returns & refunds" /><Forbidden permission="returns.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(90);
  const range = { from: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : d.from, to: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : d.to };
  const r = await returnsReport(db(), actor, range);
  const total = r.byStatus.reduce((n, s) => n + s.n, 0);
  return (
    <>
      <PageHead title="Returns & refunds" eyebrow="Return requests made in the period, their reasons, stock put back, and refunds." />
      <ReturnsNav current="/returns/report" />
      <RangeForm from={range.from} to={range.to} />
      <dl className="report-kpis">
        <div><dt>Return requests</dt><dd>{formatNumber(total)}</dd></div>
        <div><dt>Units put back in stock</dt><dd>{formatNumber(r.restockedUnits)}</dd></div>
        <div><dt>Refunds made</dt><dd>{formatPaise(r.refunds.filter(x => x.status === 'processed').reduce((n, x) => n + x.paise, 0))}</dd></div>
      </dl>
      <div className="grid-2">
        <section className="card"><h2>By reason</h2>{r.byReason.length === 0 ? <Empty compact title="No requests" /> : (
          <table><tbody>{r.byReason.map(x => <tr key={x.label}><td>{x.label}</td><td className="num">{x.n}</td></tr>)}</tbody></table>)}</section>
        <section className="card"><h2>By status</h2>{r.byStatus.length === 0 ? <Empty compact title="No requests" /> : (
          <table><tbody>{r.byStatus.map(x => <tr key={x.status}><td><StatusBadge status={x.status} /></td><td className="num">{x.n}</td></tr>)}</tbody></table>)}</section>
      </div>
      <section className="card"><h2>Refunds</h2>{r.refunds.length === 0 ? <Empty compact title="No refunds in this period" /> : (
        <table><thead><tr><th>How</th><th>Status</th><th className="num">Count</th><th className="num">Amount</th></tr></thead>
          <tbody>{r.refunds.map(x => <tr key={`${x.method}-${x.status}`}><td>{x.method === 'provider' ? 'Payment provider' : x.method === 'manual' ? 'Manual' : 'Other (payments page)'}</td>
            <td><StatusBadge status={x.status} /></td><td className="num">{x.n}</td><td className="num money">{formatPaise(x.paise)}</td></tr>)}</tbody></table>)}</section>
    </>
  );
}
