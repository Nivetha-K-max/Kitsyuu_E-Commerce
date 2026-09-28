import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { customerReport, inventoryReport, productionReport, productReport, purchasingReport, salesReport, type ReportKind } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Reports' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const isoDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);   // YYYY-MM-DD in IST

/* M16: reports from recorded data only. Sales count paid orders (paid → delivered); dates are business days (IST). */
export default async function ReportsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'reports.read')) return <><PageHead section="Overview" title="Reports" /><Forbidden permission="reports.read" /></>;
  const sp = await searchParams;
  const tabs: { key: ReportKind; label: string; allowed: boolean }[] = [
    { key: 'sales', label: 'Sales', allowed: true }, { key: 'products', label: 'Best sellers', allowed: true }, { key: 'inventory', label: 'Stock', allowed: true },
    { key: 'customers', label: 'Customers', allowed: can(actor, 'customers.read') }, { key: 'purchasing', label: 'Purchasing', allowed: can(actor, 'procurement.read') },
    { key: 'production', label: 'Production', allowed: can(actor, 'production.read') },
  ];
  const kind = (tabs.find(t => t.key === one(sp.report) && t.allowed)?.key ?? 'sales') as ReportKind;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : isoDay(new Date());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : isoDay(new Date(Date.parse(to) - 29 * 86_400_000));
  const r = { from: from <= to ? from : to, to };
  const q = (k: ReportKind) => `/reports?${new URLSearchParams({ report: k, from: r.from, to: r.to })}`;
  let body: React.ReactNode;
  if (kind === 'sales') {
    const s = await salesReport(db(), actor, r);
    body = <>
      <dl className="kpis report-kpis" data-report-totals>
        <div><dt>Paid orders</dt><dd>{s.totals.orders}</dd></div><div><dt>Units sold</dt><dd>{s.totals.units}</dd></div>
        <div><dt>Revenue</dt><dd>{rupees(s.totals.revenue)}</dd></div><div><dt>Average order</dt><dd>{rupees(s.totals.averageOrderPaise)}</dd></div>
      </dl>
      {s.rows.length ? <div className="table-wrap"><table data-report="sales"><thead><tr><th>Day</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
        <tbody>{s.rows.map(x => <tr key={x.day}><td>{x.day}</td><td className="num">{x.orders}</td><td className="num">{x.units}</td><td className="num">{rupees(x.revenue)}</td></tr>)}</tbody></table></div>
        : <Empty title="No paid orders in this period" kind="report" />}
    </>;
  } else if (kind === 'products') {
    const s = await productReport(db(), actor, r);
    body = s.rows.length ? <>
      <div className="table-wrap"><table data-report="categories"><thead><tr><th>Category</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
        <tbody>{s.byCategory.map(x => <tr key={x.category}><td>{x.category}</td><td className="num">{x.units}</td><td className="num">{rupees(x.revenue)}</td></tr>)}</tbody></table></div>
      <div className="table-wrap"><table data-report="products"><thead><tr><th>Product</th><th>Category</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
        <tbody>{s.rows.map(x => <tr key={x.sku + x.name}><td>{x.name}<div className="note mono">{x.sku}</div></td><td>{x.category}</td><td className="num">{x.units}</td><td className="num">{rupees(x.revenue)}</td></tr>)}</tbody></table></div>
    </> : <Empty title="Nothing sold in this period" kind="report" />;
  } else if (kind === 'inventory') {
    const s = await inventoryReport(db(), actor, r);
    body = <>
      <div className="table-wrap"><table data-report="stock"><thead><tr><th>Category (now)</th><th className="num">Sizes</th><th className="num">Units in stock</th><th className="num">Sizes out of stock</th></tr></thead>
        <tbody>{s.stock.map(x => <tr key={x.category}><td>{x.category}</td><td className="num">{x.sizes}</td><td className="num">{x.units}</td><td className="num">{x.out_of_stock}</td></tr>)}</tbody></table></div>
      <div className="table-wrap"><table data-report="movements"><thead><tr><th>Stock movements in the period</th><th className="num">Movements</th><th className="num">Units in</th><th className="num">Units out</th></tr></thead>
        <tbody>{s.movements.map(x => <tr key={x.reason}><td>{x.label}</td><td className="num">{x.movements}</td><td className="num">{x.units_in}</td><td className="num">{x.units_out}</td></tr>)}</tbody></table></div>
    </>;
  } else if (kind === 'customers') {
    const s = await customerReport(db(), actor, r);
    body = <dl className="kpis report-kpis" data-report="customers"><div><dt>New accounts</dt><dd>{s.new_customers}</dd></div><div><dt>Customers who bought</dt><dd>{s.buyers}</dd></div>
      <div><dt>Of whom returning</dt><dd>{s.returning_buyers}</dd></div></dl>;
  } else if (kind === 'purchasing') {
    const s = await purchasingReport(db(), actor, r);
    body = s.rows.length ? <div className="table-wrap"><table data-report="purchasing"><thead><tr><th>Vendor</th><th className="num">Orders placed</th><th className="num">Lines</th>{s.costs && <th className="num">Spend (priced lines)</th>}</tr></thead>
      <tbody>{s.rows.map(x => <tr key={x.vendor}><td>{x.vendor}</td><td className="num">{x.orders}</td><td className="num">{x.lines}</td>{s.costs && <td className="num">{rupees(x.spend)}</td>}</tr>)}</tbody></table></div>
      : <Empty title="No purchase orders placed in this period" kind="report" />;
  } else {
    const s = await productionReport(db(), actor, r);
    body = s.rows.length ? <>
      <dl className="kpis report-kpis" data-report-totals><div><dt>Pieces passed</dt><dd>{s.totals.passed}</dd></div><div><dt>Rejected</dt><dd>{s.totals.rejected}</dd></div>
        <div><dt>Pass rate</dt><dd>{s.totals.passRate === null ? '—' : `${(s.totals.passRate * 100).toFixed(1)}%`}</dd></div></dl>
      <div className="table-wrap"><table data-report="production"><thead><tr><th>Piece</th><th className="num">Orders</th><th className="num">Passed</th><th className="num">Rejected</th></tr></thead>
        <tbody>{s.rows.map(x => <tr key={x.sku + x.size}><td>{x.name}<div className="note mono">{x.sku} · {x.size}</div></td><td className="num">{x.orders}</td><td className="num">{x.passed}</td><td className="num">{x.rejected}</td></tr>)}</tbody></table></div>
    </> : <Empty title="No production completed in this period" kind="report" />;
  }
  return (
    <>
      <PageHead section="Overview" title="Reports" eyebrow={`${r.from} to ${r.to} · business days (IST)`}>
        <a className="btn ghost sm" href={`/reports/export?${new URLSearchParams({ report: kind, from: r.from, to: r.to })}`} data-export>Download CSV</a>
      </PageHead>
      <nav className="tabs actions" aria-label="Reports" data-report-tabs>
        {tabs.filter(t => t.allowed).map(t => <Link key={t.key} className={`btn sm ${t.key === kind ? '' : 'ghost'}`} href={q(t.key)} aria-current={t.key === kind ? 'page' : undefined}>{t.label}</Link>)}
      </nav>
      <form className="actions filters" method="get" data-report-range>
        <input type="hidden" name="report" value={kind} />
        <label className="field-inline">From <input className="input" type="date" name="from" defaultValue={r.from} /></label>
        <label className="field-inline">To <input className="input" type="date" name="to" defaultValue={r.to} /></label>
        <button className="btn ghost" type="submit">Show</button>
      </form>
      <section className="card report-body" data-report-kind={kind}>{body}</section>
    </>
  );
}
