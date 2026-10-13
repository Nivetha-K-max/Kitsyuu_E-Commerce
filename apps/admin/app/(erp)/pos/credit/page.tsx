import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { creditReport, storeCreditReport, STORE_CREDIT_KIND_LABELS } from '@kitsyuu/core';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { istDate, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { Figures, Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Credit and store credit' };

/* Two different things, kept apart on one page (2026-10-13):
   - Credit bills: money customers OWE the shop (receivables). Open and overdue bills, and repayments of the period.
   - Store credit: money the shop OWES customers (a liability). Who holds it, and what was issued and spent.
   Neither is money received; the POS report shows collections. */
export default async function PosCreditPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }];
  if (!can(actor, 'pos.reports')) return <><PageHead title="Credit and store credit" crumbs={crumbs} /><Forbidden permission="pos.reports" /></>;
  const sp = await searchParams, today = istDate(new Date());
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
  const from = valid(one(sp.from)), to = valid(one(sp.to)) < from ? from : valid(one(sp.to));
  const [cr, sc] = await Promise.all([creditReport(db(), actor, { from, to }), storeCreditReport(db(), actor, { from, to })]);
  const d = (v: unknown) => String(v instanceof Date ? istDate(v) : v).slice(0, 10);
  return (
    <Workspace name="pos-credit" title="Credit and store credit" summary={from === to ? from : `${from} to ${to}`} crumbs={crumbs}>
      <RangeForm from={from} to={to} />
      <section className="card" aria-labelledby="cb-h" data-section="credit-bills">
        <h2 id="cb-h">Credit bills — customers owe the shop</h2>
        <Figures items={[
          { label: 'Outstanding', value: <span data-credit-outstanding>{formatPaise(cr.outstandingPaise)}</span>, note: `${cr.open.length} open bill${cr.open.length === 1 ? '' : 's'}` },
          { label: 'Overdue', value: <span data-credit-overdue>{formatPaise(cr.overduePaise)}</span>, note: `${cr.overdue.length} bill${cr.overdue.length === 1 ? '' : 's'}` },
          { label: 'Sold on credit in the period', value: formatPaise(cr.soldOnCredit.amount), note: `${cr.soldOnCredit.count} bill${cr.soldOnCredit.count === 1 ? '' : 's'}` },
          { label: 'Repaid in the period', value: <span data-credit-repaid>{formatPaise(cr.repaidPaise)}</span>, note: cr.repaid.map(r => `${r.method.toUpperCase()} ${formatPaise(r.amount)}`).join(' · ') || 'nothing' },
        ]} />
        {!cr.reconciled && <p className="msg error" role="alert">The accounts, the open bills and the repayments do not agree. Do not rely on these figures; report this.</p>}
        {cr.open.length === 0 ? <Empty compact title="No open credit bills" /> : (
          <div className="table-wrap"><table data-credit-bills>
            <thead><tr><th>Bill</th><th>Customer</th><th>Due</th><th className="num">Bill amount</th><th className="num">Still owed</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{cr.open.map(b => (
              <tr key={b.id} data-credit-bill={b.pos_number ?? b.order_number}>
                <td><Link href={`/pos/credit/${b.id}`}>{b.pos_number ?? b.order_number}</Link></td>
                <td>{can(actor, 'customers.read') ? <Link href={`/customers/${b.customer_id}?tab=payments`}>{b.full_name ?? b.email}</Link> : b.full_name ?? b.email}<div className="note">{b.phone ?? b.email}</div></td>
                <td className="nowrap">{d(b.due_on)}{b.overdue && <span className="badge pending" data-credit-overdue-flag>Overdue</span>}</td>
                <td className="num">{formatPaise(b.amount_paise)}</td><td className="num"><b>{formatPaise(b.outstanding_paise)}</b></td>
                <td>{can(actor, 'credit.repay') && <Link className="btn ghost sm" href={`/pos/credit/${b.id}#repay`}>Record repayment</Link>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card" aria-labelledby="sc-h" data-section="store-credit">
        <h2 id="sc-h">Store credit — the shop owes customers</h2>
        <Figures items={[
          { label: 'Total held by customers', value: <span data-store-credit-liability>{formatPaise(sc.liabilityPaise)}</span>, note: `${sc.holders.length} customer${sc.holders.length === 1 ? '' : 's'} · never expires` },
          ...sc.moves.map(m => ({ label: STORE_CREDIT_KIND_LABELS[m.kind], value: `${m.issued ? `+${formatPaise(m.issued)}` : ''}${m.issued && m.taken ? ' / ' : ''}${m.taken ? `−${formatPaise(m.taken)}` : ''}`, note: `${m.count} movement${m.count === 1 ? '' : 's'} in the period` })),
        ]} />
        {!sc.reconciled && <p className="msg error" role="alert">The balances and the ledger do not agree. Do not rely on these figures; report this.</p>}
        {sc.holders.length === 0 ? <Empty compact title="No customer holds store credit" /> : (
          <div className="table-wrap"><table data-store-credit-holders>
            <thead><tr><th>Customer</th><th className="num">Store credit</th></tr></thead>
            <tbody>{sc.holders.map(h => (
              <tr key={h.id}><td>{can(actor, 'customers.read') ? <Link href={`/customers/${h.id}?tab=payments`}>{h.full_name ?? h.email}</Link> : h.full_name ?? h.email}<div className="note">{h.email}</div></td><td className="num">{formatPaise(h.balance_paise)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </Workspace>
  );
}
