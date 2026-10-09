import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { supportReport } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import SupportNav from '../SupportNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Support report' };

export default async function SupportReportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'support.read')) return <><PageHead title="Support" /><Forbidden permission="support.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(30);
  const range = { from: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : d.from, to: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : d.to };
  const r = await supportReport(db(), actor, range);
  const total = r.byStatus.reduce((n, s) => n + s.n, 0);
  return (
    <Workspace name="support-report" title="Support" summary="Tickets opened in the period.">
      <SupportNav current="/support/report" manage={can(actor, 'support.manage')} />
      <RangeForm from={range.from} to={range.to} />
      <dl className="report-kpis">
        <div><dt>Tickets opened</dt><dd>{formatNumber(total)}</dd></div>
        <div><dt>Resolved</dt><dd>{formatNumber(r.resolved)}</dd></div>
        <div><dt>Median first reply</dt><dd>{r.medianFirstResponseHours === null ? '—' : `${r.medianFirstResponseHours} h`}</dd></div>
      </dl>
      <div className="grid-2">
        <section className="card"><h2>By category</h2>{r.byCategory.length === 0 ? <Empty compact title="No tickets" /> : (
          <table><tbody>{r.byCategory.map(x => <tr key={x.label}><td>{x.label}</td><td className="num">{x.n}</td></tr>)}</tbody></table>)}</section>
        <section className="card"><h2>By status now</h2>{r.byStatus.length === 0 ? <Empty compact title="No tickets" /> : (
          <table><tbody>{r.byStatus.map(x => <tr key={x.status}><td><StatusBadge status={x.status} /></td><td className="num">{x.n}</td></tr>)}</tbody></table>)}</section>
      </div>
    </Workspace>
  );
}
