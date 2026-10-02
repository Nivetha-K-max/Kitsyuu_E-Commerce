import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { posContext, posReport } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Forbidden, PageHead } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { istDate, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'POS report' };

export default async function PosReportPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }];
  if (!can(actor, 'pos.reports')) return <><PageHead title="POS report" crumbs={crumbs} /><Forbidden permission="pos.reports" /></>;
  const sp = await searchParams;
  const today = istDate(new Date());
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
  const from = valid(one(sp.from)), to = valid(one(sp.to)) < from ? from : valid(one(sp.to));
  const locationId = /^[0-9a-f-]{36}$/i.test(one(sp.location)) ? one(sp.location) : null;
  const [r, c] = await Promise.all([posReport(db(), actor, { from, to, locationId }), posContext(db(), actor)]);
  const card = (label: string, value: string, attr: string) => <div className="kpi" data-kpi={attr}><span className="kpi-label">{label}</span><b>{value}</b></div>;
  return (
    <>
      <PageHead title="POS report" crumbs={crumbs} eyebrow={from === to ? from : `${from} to ${to}`} />
      <RangeForm from={from} to={to}>
        <select name="location" className="input" defaultValue={locationId ?? ''} aria-label="Branch">
          <option value="">All branches</option>
          {c.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </RangeForm>
      <section className="kpis pos-kpis" aria-label="Totals" data-pos-report>
        {card('Total sales', formatPaise(r.grossPaise), 'gross')}
        {card('Transactions', String(r.transactions), 'transactions')}
        {card('Discounts', formatPaise(r.discountPaise), 'discounts')}
        {card('Voided / refunded', formatPaise(r.voidRefundsPaise + r.returnRefundsPaise), 'refunds')}
        {card('Net sales', formatPaise(r.netPaise), 'net')}
        {card('Tax', formatPaise(r.taxPaise), 'tax')}
      </section>
      <section className="card" aria-labelledby="m-h">
        <h2 id="m-h">By payment method</h2>
        <div className="table-wrap"><table data-pos-methods>
          <thead><tr><th>Method</th><th className="num">Transactions</th><th className="num">Amount</th></tr></thead>
          <tbody>{r.methods.map(m => <tr key={m.method} data-method={m.method}><td>{m.label}</td><td className="num">{m.count}</td><td className="num">{formatPaise(m.amountPaise)}</td></tr>)}</tbody>
        </table></div>
        <p className="note">Voided sales: {r.voided} ({formatPaise(r.voidRefundsPaise)} returned at the counter). Refunds of returns: {formatPaise(r.returnRefundsPaise)}.</p>
      </section>
      <div className="pos-grid2">
        {(['byCashier', 'byLocation'] as const).map(k => (
          <section className="card" key={k} aria-labelledby={`${k}-h`}>
            <h2 id={`${k}-h`}>{k === 'byCashier' ? 'By cashier' : 'By store / branch'}</h2>
            <div className="table-wrap"><table data-pos-group={k}>
              <thead><tr><th>{k === 'byCashier' ? 'Cashier' : 'Branch'}</th><th className="num">Sales</th><th className="num">Amount</th><th className="num">Voided</th></tr></thead>
              <tbody>{r[k].length ? r[k].map(g => <tr key={g.name}><td>{g.name}</td><td className="num">{g.count}</td><td className="num">{formatPaise(g.amountPaise)}</td><td className="num">{g.voided}</td></tr>)
                : <tr><td colSpan={4} className="note">No POS sales in this period.</td></tr>}</tbody>
            </table></div>
          </section>
        ))}
      </div>
    </>
  );
}
