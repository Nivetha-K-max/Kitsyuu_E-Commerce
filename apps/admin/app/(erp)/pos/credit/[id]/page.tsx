import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { companyDetails, getCreditBill, posContext } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import PrintButton from '@/components/PrintButton';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { istDate } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { repayCreditAction } from '../../actions';

export const metadata: Metadata = { title: 'Credit bill' };
type Params = Promise<{ id: string }>;

/* One credit bill (2026-10-13): what was sold on credit, what has been repaid, what is still owed. The statement prints as
   the repayment receipt. Recording a repayment needs credit.repay; cash taken at a till goes into the cashier's open session. */
export default async function CreditBillPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }, { href: '/pos/credit', label: 'Credit and store credit' }];
  if (!can(actor, 'pos.access')) return <><PageHead title="Credit bill" crumbs={crumbs} /><Forbidden permission="pos.access" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = await getCreditBill(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const [company, c] = await Promise.all([companyDetails(db()), posContext(db(), actor)]);
  const b = v.bill, number = b.pos_number ?? b.order_number;
  const due = String(b.due_on instanceof Date ? istDate(b.due_on) : b.due_on).slice(0, 10);
  return (
    <>
      <div className="no-print">
        <PageHead title={`Credit bill · ${number}`} crumbs={crumbs} eyebrow={`${b.full_name ?? b.email}${b.phone ? ` · ${b.phone}` : ''}`}>
          <PrintButton label="Print statement" />
          <Link className="btn ghost" href={b.pos_number ? `/pos/sale/${b.order_id}` : `/orders/${b.order_id}`}>Original bill</Link>
        </PageHead>
      </div>
      <article className="pos-receipt" data-credit-statement aria-label="Credit bill statement">
        <header>
          <p className="pos-brand">KITSYUU</p>
          {company.legalName && <p>{company.legalName}</p>}
          <p className="pos-receipt-title">{b.status === 'paid' ? 'CREDIT BILL — PAID IN FULL' : b.status === 'cancelled' ? 'CREDIT BILL — CANCELLED' : 'CREDIT BILL — STATEMENT'}</p>
        </header>
        <dl className="pos-receipt-meta">
          <dt>Bill no.</dt><dd>{number}</dd>
          <dt>Customer</dt><dd>{b.full_name ?? b.email}{b.phone ? ` · ${b.phone}` : ''}</dd>
          <dt>Sold on</dt><dd>{formatDateTime(b.created_at as Date)}</dd>
          <dt>Due by</dt><dd data-credit-due>{due}{b.overdue ? ' (overdue)' : ''}</dd>
          <dt>Terms at the sale</dt><dd>{b.due_days_at_sale} days · limit {formatPaise(b.limit_paise_at_sale)}</dd>
        </dl>
        <table className="pos-receipt-lines">
          <thead><tr><th>Repayment</th><th>How</th><th className="num">Amount</th><th className="num">Left</th></tr></thead>
          <tbody>
            <tr><td>Sold on credit</td><td /><td className="num">{formatPaise(b.amount_paise)}</td><td className="num">{formatPaise(b.amount_paise)}</td></tr>
            {v.repayments.map(r => (
              <tr key={r.id} data-credit-repayment={r.number}><td>{r.number}<br /><small>{formatDateTime(r.created_at as Date)}</small></td><td>{r.method.toUpperCase()}{r.reference ? <><br /><small>Ref {r.reference}</small></> : null}</td>
                <td className="num">− {formatPaise(r.amount_paise)}</td><td className="num">{formatPaise(r.outstanding_after)}</td></tr>
            ))}
          </tbody>
        </table>
        <dl className="pos-receipt-totals">
          <dt>Repaid</dt><dd>{formatPaise(b.amount_paise - b.outstanding_paise)}</dd>
          <dt className="pos-total">Still owed</dt><dd className="pos-total" data-credit-owed={b.outstanding_paise}>{formatPaise(b.outstanding_paise)}</dd>
        </dl>
      </article>
      <div className="no-print pos-after" id="repay">
        {b.status === 'open' && can(actor, 'credit.repay') && (
          <section className="card" aria-labelledby="rp-h">
            <h2 id="rp-h">Record a repayment</h2>
            <p className="note">Enter what was actually received, up to {formatPaise(b.outstanding_paise)}. {c.session ? `Cash goes into your open session at ${c.session.location_name}.` : 'You have no open cashier session: the repayment is recorded without a till.'}</p>
            <ActionForm action={repayCreditAction} submitLabel="Record repayment" id="credit-repay-form" confirmText="Record this repayment? It cannot be edited afterwards." resetOnSuccess>
              <Hidden name="billId" value={b.id} />
              <Hidden name="sessionId" value={c.session?.id ?? ''} />
              <Hidden name="key" value={randomBytes(16).toString('hex')} />
              <Field name="amount" label="Amount received (₹)" required defaultValue={String(b.outstanding_paise / 100)} />
              <Select name="method" label="Paid by" options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }]} />
              <Field name="reference" label="Transaction reference (UPI / card)" hint="Not needed for cash." />
            </ActionForm>
          </section>
        )}
        {b.status === 'open' && !can(actor, 'credit.repay') && <p className="note">Recording a repayment needs the “credit: repay” permission.</p>}
      </div>
    </>
  );
}
