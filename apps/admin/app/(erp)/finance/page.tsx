import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { DomainError } from '@kitsyuu/contracts';
import { financeSummary, FINANCE_EXPORTS } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import FinanceNav from './FinanceNav';

export const metadata: Metadata = { title: 'Finance' };
const EXPORT_LABEL: Record<string, string> = { summary: 'Summary', expenses: 'Expenses', vendor_payments: 'Vendor payments', invoices: 'Invoices (GST)', reconciliation: 'Reconciliation' };

/* ERP module 6: sales, refunds, tax, expenses and payments in a period, from recorded data only. */
export default async function FinancePage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(30);
  const range = { from: one(sp.from) || d.from, to: one(sp.to) || d.to };
  let s: Awaited<ReturnType<typeof financeSummary>> | null = null; let error: string | null = null;
  try { s = await financeSummary(db(), actor, range); } catch (e) { if (e instanceof DomainError) error = e.message; else throw e; }
  return (
    <>
      <PageHead title="Finance" eyebrow="Orders are counted by the day they were placed (paid, processing, shipped, delivered). Amounts come from the orders as charged." />
      <FinanceNav current="/finance" />
      <RangeForm from={range.from} to={range.to} />
      {error && <p className="msg error" role="alert">{error}</p>}
      {s && <>
        <dl className="report-kpis" data-finance-kpis>
          <div><dt>Sales (order totals)</dt><dd>{formatPaise(s.sales.total)}<small>{formatNumber(s.sales.orders)} orders</small></dd></div>
          <div><dt>Refunds made</dt><dd>{formatPaise(s.refunds.paise)}<small>{formatNumber(s.refunds.n)} refunds</small></dd></div>
          <div><dt>Net sales</dt><dd>{formatPaise(s.netSalesPaise)}</dd></div>
          <div><dt>Tax in order totals</dt><dd>{formatPaise(s.sales.tax)}</dd></div>
          <div><dt>Expenses</dt><dd>{formatPaise(s.expenseTotal)}</dd></div>
          <div><dt>Paid to vendors</dt><dd>{formatPaise(s.vendorPaid.paise)}<small>{formatNumber(s.vendorPaid.n)} payments</small></dd></div>
        </dl>
        <div className="grid-2">
          <section className="card" aria-labelledby="sb-h"><h2 id="sb-h">Sales breakdown</h2>
            <table><tbody>
              <tr><td>Goods (before discounts)</td><td className="num money">{formatPaise(s.sales.gross)}</td></tr>
              <tr><td>Discounts</td><td className="num money">−{formatPaise(s.sales.discounts)}</td></tr>
              <tr><td>Delivery charges</td><td className="num money">{formatPaise(s.sales.shipping)}</td></tr>
              <tr><td>Tax (inside or added to prices)</td><td className="num money">{formatPaise(s.sales.tax)}</td></tr>
              <tr><td><b>Order totals</b></td><td className="num money"><b>{formatPaise(s.sales.total)}</b></td></tr>
            </tbody></table>
          </section>
          <section className="card" aria-labelledby="tx-h"><h2 id="tx-h">Tax by the rate orders were charged at</h2>
            {s.taxByRate.length === 0 ? <Empty compact title="No orders in this period" /> : (
              <table><thead><tr><th>Rate</th><th className="num">Orders</th><th className="num">Tax</th></tr></thead>
                <tbody>{s.taxByRate.map(t => <tr key={t.rate}><td>{t.rate}</td><td className="num">{t.orders}</td><td className="num money">{formatPaise(t.tax)}</td></tr>)}</tbody></table>)}
          </section>
          <section className="card" aria-labelledby="ex-h"><h2 id="ex-h">Expenses by category</h2>
            {s.expenses.length === 0 ? <Empty compact title="No expenses recorded" /> : (
              <table><tbody>{s.expenses.map(e => <tr key={e.label}><td>{e.label}</td><td className="num">{e.n}</td><td className="num money">{formatPaise(e.paise)}</td></tr>)}</tbody></table>)}
          </section>
          <section className="card" aria-labelledby="iv-h"><h2 id="iv-h">Invoices issued</h2>
            {s.invoices.length === 0 ? <Empty compact title="No invoices in this period" /> : (
              <table><tbody>{s.invoices.map(i => <tr key={i.status}><td><StatusBadge status={i.status} /></td><td className="num">{i.n}</td><td className="num money">{formatPaise(i.paise)}</td></tr>)}</tbody></table>)}
          </section>
        </div>
        <section className="card" aria-labelledby="dl-h"><h2 id="dl-h">Download (CSV)</h2>
          <div className="actions">{FINANCE_EXPORTS.map(k => <a key={k} className="btn ghost sm" href={`/finance/export?kind=${k}&from=${range.from}&to=${range.to}`} download>{EXPORT_LABEL[k]}</a>)}</div>
        </section>
      </>}
    </>
  );
}
