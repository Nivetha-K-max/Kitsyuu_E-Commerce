import Link from 'next/link';
import { randomBytes } from 'node:crypto';
import { can, type StaffPrincipal } from '@kitsyuu/auth';
import { getCustomerCredit, getStoreCredit, STORE_CREDIT_KIND_LABELS } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Figures, Section } from '@/components/frame';
import { formatDateTime, formatPaise } from '@/lib/format';
import { istDate } from '@/lib/erp';
import { db } from '@/lib/server';
import { adjustStoreCreditAction, setCreditAccountAction } from '@/app/(erp)/pos/actions';

/* A customer's two money balances with the shop (2026-10-13), on the customer's Payments tab. They are opposites and are
   never added together: store credit is what the shop owes the customer; a credit account is what the customer may owe
   the shop. Loyalty points are a third thing, on the Loyalty tab. */
export default async function CustomerMoney({ actor, customerId, forms = false }: { actor: StaffPrincipal; customerId: string;
  /** The customer's Payments tab is read-only (rows open the order); the forms are on the customer's own credit page. */
  forms?: boolean }) {
  const manage = `/customers/${customerId}/credit`;
  const [sc, cr] = await Promise.all([getStoreCredit(db(), actor, customerId, 15), getCustomerCredit(db(), actor, customerId)]);
  const a = cr.account, open = cr.bills.filter(b => b.status === 'open');
  const day = (v: unknown) => String(v instanceof Date ? istDate(v) : v).slice(0, 10);
  return (
    <>
      <Section id="sc-h" title="Store credit" name="store-credit" hint="Money the shop owes this customer, to spend on a later purchase. It never expires. Given for a return or exchange, or by an adjustment below.">
        <Figures items={[{ label: 'Available', value: <span data-store-credit-balance>{formatPaise(sc.balancePaise)}</span> }]} />
        {sc.entries.length > 0 && (
          <div className="table-wrap"><table data-store-credit-entries>
            <thead><tr><th>When</th><th>What</th><th>Reason</th><th className="num">Amount</th><th className="num">Balance</th><th>By</th></tr></thead>
            <tbody>{sc.entries.map(e => (
              <tr key={e.id}><td className="nowrap">{formatDateTime(e.created_at as Date)}</td><td>{STORE_CREDIT_KIND_LABELS[e.kind]}</td>
                <td>{e.reason}{e.order_id && can(actor, 'orders.read') ? <> · <Link href={`/orders/${e.order_id}`}>{e.pos_number ?? e.order_number}</Link></> : null}</td>
                <td className="num">{e.amount_paise > 0 ? '+' : '−'} {formatPaise(Math.abs(e.amount_paise))}</td><td className="num">{formatPaise(e.balance_after)}</td><td>{e.staff_email ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {!forms && can(actor, 'store_credit.adjust') && <p className="note"><Link href={`${manage}#store-credit-adjust-form`} data-store-credit-manage>Adjust store credit</Link></p>}
        {forms && can(actor, 'store_credit.adjust') && (
          <ActionForm action={adjustStoreCreditAction} submitLabel="Save adjustment" id="store-credit-adjust-form" label="Adjust store credit" resetOnSuccess
            confirmText="Change this customer's store credit? It is written to the ledger and cannot be edited; a mistake is corrected with another adjustment.">
            <Hidden name="customerId" value={customerId} /><Hidden name="key" value={randomBytes(16).toString('hex')} />
            <Field name="amount" label="Amount (₹)" required hint="For example 500 to add, -200 to take away." />
            <Field name="reason" label="Reason" required hint="Shown in the customer's store-credit history and the audit log." />
          </ActionForm>
        )}
      </Section>

      <Section id="ca-h" title="Credit account" name="credit-account" hint="Money this customer may owe the shop. Nobody has credit until an account is approved here.">
        {a ? (
          <Figures items={[
            { label: 'Owed now', value: <span data-credit-owed>{formatPaise(a.outstanding_paise)}</span>, note: `${open.length} open bill${open.length === 1 ? '' : 's'}` },
            { label: 'Limit', value: formatPaise(a.limit_paise), note: a.status === 'active' ? `${formatPaise(cr.availablePaise)} available` : 'switched off' },
            { label: 'Due period', value: `${a.due_days} days`, note: `approved by ${a.approved_by_email ?? '—'}` },
          ]} />
        ) : <p className="note" data-credit-none>No credit account: every sale to this customer is paid at the time.</p>}
        {cr.bills.length > 0 && (
          <div className="table-wrap"><table data-credit-bills>
            <thead><tr><th>Bill</th><th>Sold</th><th>Due</th><th className="num">Amount</th><th className="num">Still owed</th><th>Status</th></tr></thead>
            <tbody>{cr.bills.map(b => (
              <tr key={b.id}><td><Link href={`/pos/credit/${b.id}`}>{b.pos_number ?? b.order_number}</Link></td><td className="nowrap">{day(b.created_at)}</td><td className="nowrap">{day(b.due_on)}</td>
                <td className="num">{formatPaise(b.amount_paise)}</td><td className="num">{formatPaise(b.outstanding_paise)}</td><td>{b.overdue ? 'Overdue' : b.status === 'open' ? 'Open' : b.status === 'paid' ? 'Paid' : 'Cancelled'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {!forms && can(actor, 'credit.manage') && <p className="note"><Link href={`${manage}#credit-account-form`} data-credit-manage>{a ? 'Change credit terms' : 'Approve a credit account'}</Link></p>}
        {forms && can(actor, 'credit.manage') && (
          <ActionForm action={setCreditAccountAction} submitLabel={a ? 'Save credit terms' : 'Approve credit account'} id="credit-account-form" label="Credit account terms"
            confirmText={a ? 'Change the credit terms? Bills already made keep the terms they were sold on.' : 'Approve a credit account for this customer?'}>
            <Hidden name="customerId" value={customerId} />
            <Field name="limit" label="Credit limit (₹)" required defaultValue={a ? String(a.limit_paise / 100) : ''} />
            <Field name="dueDays" label="Due period (days)" required defaultValue={a ? String(a.due_days) : ''} hint="Each credit bill is due this many days after the sale." />
            <Select name="active" label="Status" options={[{ value: 'yes', label: 'Active: credit sales allowed' }, { value: 'no', label: 'Switched off: no new credit sales' }]} defaultValue={a && a.status !== 'active' ? 'no' : 'yes'} />
            <Field name="note" label="Note (optional)" defaultValue={a?.note ?? ''} />
          </ActionForm>
        )}
      </Section>
    </>
  );
}
