import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { DomainError } from '@kitsyuu/contracts';
import { reconciliation } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { defaultRange, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import FinanceNav from '../FinanceNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Reconciliation' };

export default async function ReconciliationPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(30);
  const range = { from: one(sp.from) || d.from, to: one(sp.to) || d.to };
  let r: Awaited<ReturnType<typeof reconciliation>> | null = null; let error: string | null = null;
  try { r = await reconciliation(db(), actor, range); } catch (e) { if (e instanceof DomainError) error = e.message; else throw e; }
  return (
    <Workspace name="finance-reconciliation" title="Finance" summary="Orders marked paid vs captured payments vs refunds, day by day (India time).">
      <FinanceNav current="/finance/reconciliation" />
      <RangeForm from={range.from} to={range.to} />
      {error && <p className="msg error" role="alert">{error}</p>}
      {r && <>
        <p className={`msg ${r.allMatch ? 'ok' : 'error'}`} role="status" data-reconciliation-state>{r.allMatch
          ? 'Platform records agree: every day’s paid orders equal the payments captured.'
          : 'Some days differ: check them on the Payments page (exceptions).'} {r.note}</p>
        {r.days.length === 0 ? <Empty title="No payments in this period" kind="reconciliation" /> : (
          <div className="table-wrap"><table data-reconciliation>
            <thead><tr><th>Day</th><th className="num">Orders paid</th><th className="num">Order totals</th><th className="num">Payments</th><th className="num">Captured</th><th className="num">Refunds</th><th className="num">Difference</th><th>Agrees</th></tr></thead>
            <tbody>{r.days.map(x => (
              <tr key={x.day}><td>{x.day}</td><td className="num">{x.orders_paid}</td><td className="num money">{formatPaise(x.orders_paise)}</td><td className="num">{x.payments}</td>
                <td className="num money">{formatPaise(x.captured_paise)}</td><td className="num money">{formatPaise(x.refunds_paise)}</td><td className="num money">{formatPaise(x.difference)}</td>
                <td>{x.matches ? <span className="badge active">yes</span> : <span className="badge failed">no</span>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </>}
    </Workspace>
  );
}
