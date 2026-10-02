import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listPosSales, listPosSessions, posContext, posSessionSummary } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, TextArea } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { closeSessionAction } from '../actions';

export const metadata: Metadata = { title: 'POS sessions' };

export default async function PosSessionsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }];
  if (!can(actor, 'pos.access')) return <><PageHead title="POS sessions" crumbs={crumbs} /><Forbidden permission="pos.access" /></>;
  const sp = await searchParams;
  const c = await posContext(db(), actor);
  const [sessions, sum, sales] = await Promise.all([
    listPosSessions(db(), actor, { all: true }),
    c.session ? posSessionSummary(db(), c.session.id) : null,
    c.session ? listPosSales(db(), actor, { sessionId: c.session.id, limit: 200 }) : [],
  ]);
  return (
    <>
      <PageHead title="Cashier sessions" crumbs={crumbs} eyebrow={can(actor, 'pos.reports') ? 'Every cashier' : 'Your sessions'} />
      {one(sp.closed) === '1' && <p className="msg ok" role="status" data-session-closed>Session closed.</p>}
      {c.session && sum && (
        <section className="card" id="close" aria-labelledby="cur-h" data-session-current>
          <h2 id="cur-h">Open session {c.session.number} · {c.session.location_name}</h2>
          <dl className="facts">
            <dt>Opened</dt><dd>{formatDateTime(c.session.opened_at as Date)}</dd>
            <dt>Transactions</dt><dd data-session-count>{sum.transactions}{sum.voidedTransactions ? ` (${sum.voidedTransactions} voided)` : ''}</dd>
            <dt>Cash sales</dt><dd>{formatPaise(sum.byMethod.cash.amountPaise)}{sum.byMethod.cash.voidedPaise ? ` (− ${formatPaise(sum.byMethod.cash.voidedPaise)} voided)` : ''}</dd>
            <dt>UPI</dt><dd>{formatPaise(sum.byMethod.upi.amountPaise)}</dd>
            <dt>Card</dt><dd>{formatPaise(sum.byMethod.card.amountPaise)}</dd>
            <dt>Opening cash</dt><dd>{formatPaise(c.session.opening_cash_paise)}</dd>
            <dt>Expected cash in drawer</dt><dd data-session-expected>{formatPaise(sum.expectedCashPaise)}</dd>
          </dl>
          <ActionForm action={closeSessionAction} submitLabel="Close session" id="pos-close-form" confirmText="Close this session? No more sales can be rung up in it.">
            <Hidden name="sessionId" value={c.session.id} />
            <Field name="countedCash" label="Cash counted in the drawer (₹)" />
            <TextArea name="note" label="Note (required if the count differs from the expected cash)" rows={2} />
          </ActionForm>
          {sales.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Bill</th><th>When</th><th>Payment</th><th className="num">Total</th><th>Status</th></tr></thead>
              <tbody>{sales.map(s => <tr key={s.id}><td><Link href={`/pos/sale/${s.id}`}>{s.pos_number}</Link></td><td>{formatDateTime(s.created_at as Date)}</td>
                <td>{s.payment_method?.toUpperCase()}</td><td className="num">{formatPaise(s.total_paise)}</td><td>{s.status === 'cancelled' ? 'Voided' : 'Paid'}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      )}
      <section className="card" aria-labelledby="hist-h">
        <h2 id="hist-h">Session history</h2>
        {sessions.length === 0 ? <p className="note">No sessions yet.</p> : (
          <div className="table-wrap"><table data-session-history>
            <thead><tr><th>Session</th><th>Branch</th><th>Cashier</th><th>Opened</th><th>Closed</th><th className="num">Sales</th><th className="num">Txns</th>
              <th className="num">Expected cash</th><th className="num">Counted</th><th className="num">Variance</th><th>Note</th></tr></thead>
            <tbody>{sessions.map(s => (
              <tr key={s.id} data-session={s.number}>
                <td>{s.number}{s.status === 'open' ? ' (open)' : ''}</td><td>{s.location_name}</td><td>{s.cashier_name || s.cashier_email}</td>
                <td>{formatDateTime(s.opened_at as Date)}</td><td>{s.closed_at ? formatDateTime(s.closed_at as Date) : '—'}</td>
                <td className="num">{formatPaise(s.sales_paise)}</td><td className="num">{s.transactions}</td>
                <td className="num">{s.expected_cash_paise != null ? formatPaise(s.expected_cash_paise) : '—'}</td>
                <td className="num">{s.counted_cash_paise != null ? formatPaise(s.counted_cash_paise) : '—'}</td>
                <td className="num">{s.variance_paise != null ? formatPaise(s.variance_paise) : '—'}</td><td>{s.close_note ?? ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
