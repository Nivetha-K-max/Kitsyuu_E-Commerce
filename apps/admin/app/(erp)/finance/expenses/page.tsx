import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { financeLookups, listExpenses } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import RangeForm from '@/components/RangeForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { defaultRange, istDate, one, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { saveExpenseAction, voidExpenseAction } from '../actions';
import FinanceNav from '../FinanceNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Expenses' };

export default async function ExpensesPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const sp = await searchParams;
  const d = defaultRange(90);
  const range = { from: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : d.from, to: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : d.to };
  const [rows, look] = await Promise.all([listExpenses(db(), actor, range), financeLookups(db(), actor)]);
  const manage = can(actor, 'finance.manage');
  const live = rows.filter(r => !r.voided_at);
  return (
    <Workspace name="finance-expenses" title="Finance" summary={`${live.length} expense(s) · ${formatPaise(live.reduce((n, r) => n + r.amount_paise, 0))} in the period`}>
      <FinanceNav current="/finance/expenses" />
      <RangeForm from={range.from} to={range.to} />
      {rows.length === 0 ? <Empty title="No expenses in this period" kind="expenses" /> : (
        <div className="table-wrap"><table data-expenses-table>
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Vendor</th><th className="num">Amount</th><th className="num">Tax</th><th>Reference</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(e => (
            <tr key={e.id} className={e.voided_at ? 'strike' : undefined}><td className="nowrap">{String(e.expense_date).slice(0, 10)}</td><td>{e.category}</td><td>{e.description}{e.voided_at && <span className="badge void">void</span>}</td>
              <td>{e.vendor ?? '—'}</td><td className="num money">{formatPaise(e.amount_paise)}</td><td className="num money">{formatPaise(e.tax_paise)}</td><td className="mono">{e.reference ?? '—'}</td>
              {manage && <td>{!e.voided_at && <ActionForm action={voidExpenseAction} submitLabel="Void" variant="danger" className="inline-form" id={`void-exp-${e.id}`} label="Void expense" confirmText="Void this expense?">
                <Hidden name="expenseId" value={e.id} /></ActionForm>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (
        <section className="card form-panel" aria-labelledby="ne-h"><h2 id="ne-h">Record an expense</h2>
          <ActionForm action={saveExpenseAction} submitLabel="Save expense" id="expense-form" label="Record expense" resetOnSuccess>
            <div className="cols">
              <Field name="date" label="Date" type="date" defaultValue={istDate(new Date())} required />
              <Select name="categoryCode" label="Category" options={look.categories.map(c => ({ value: c.code, label: c.label }))} />
              <Field name="amount" label="Amount incl. tax (₹)" required />
              <Field name="tax" label="Of which GST (₹)" />
              <Select name="vendorId" label="Vendor" options={[{ value: '', label: 'None' }, ...look.vendors.map(v => ({ value: v.id, label: v.name }))]} />
              <Field name="reference" label="Bill / reference number" />
            </div>
            <Field name="description" label="Description" required />
          </ActionForm>
        </section>
      )}
    </Workspace>
  );
}
