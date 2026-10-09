import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { financeLookups, listVendorPayments } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { istDate, rupeesField } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { saveVendorPaymentAction } from '../actions';
import FinanceNav from '../FinanceNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Vendor payments' };
const METHODS = [['bank_transfer', 'Bank transfer'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']] as const;
type Row = Awaited<ReturnType<typeof listVendorPayments>>[number];
type Look = Awaited<ReturnType<typeof financeLookups>>;

function PaymentFields({ p, look }: { p?: Row; look: Look }) {
  return (
    <>
      {p && <Hidden name="paymentId" value={p.id} />}
      <div className="cols">
        <Select name="vendorId" label="Vendor" defaultValue={p?.vendor_id} options={look.vendors.map(v => ({ value: v.id, label: v.name }))} />
        <Select name="purchaseOrderId" label="Purchase order" defaultValue={p?.purchase_order_id ?? ''} options={[{ value: '', label: 'None' }, ...look.purchaseOrders.map(o => ({ value: o.id, label: o.po_number }))]} />
        <Field name="amount" label="Amount (₹)" defaultValue={rupeesField(p?.amount_paise)} required />
        <Select name="status" label="Status" defaultValue={p?.status ?? 'scheduled'} options={[{ value: 'scheduled', label: 'Scheduled (to pay)' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }]} />
        <Field name="paidOn" label="Paid on" type="date" defaultValue={p?.paid_on ? String(p.paid_on).slice(0, 10) : istDate(new Date())} />
        <Select name="method" label="Method" defaultValue={p?.method ?? ''} options={[{ value: '', label: '—' }, ...METHODS.map(([v, l]) => ({ value: v, label: l }))]} />
        <Field name="reference" label="Reference (UTR / cheque no.)" defaultValue={p?.reference ?? ''} />
      </div>
      <TextArea name="notes" label="Notes" defaultValue={p?.notes ?? ''} rows={2} />
    </>
  );
}

export default async function VendorPaymentsPage() {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const [rows, look] = await Promise.all([listVendorPayments(db(), actor), financeLookups(db(), actor)]);
  const manage = can(actor, 'finance.manage');
  const due = rows.filter(r => r.status === 'scheduled').reduce((n, r) => n + r.amount_paise, 0);
  return (
    <Workspace name="finance-vendor-payments" title="Finance" summary={`Payments to suppliers, recorded by staff (no bank connection). Scheduled to pay: ${formatPaise(due)}.`}>
      <FinanceNav current="/finance/vendor-payments" />
      {rows.length === 0 ? <Empty title="No vendor payments recorded" kind="vendor-payments" /> : (
        <div className="table-wrap"><table data-vendor-payments>
          <thead><tr><th>Vendor</th><th>PO</th><th className="num">Amount</th><th>Status</th><th>Paid on</th><th>Method / reference</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id}><td>{p.vendor}{p.notes && <div className="note">{p.notes}</div>}</td><td className="mono">{p.po_number ?? '—'}</td><td className="num money">{formatPaise(p.amount_paise)}</td>
              <td><StatusBadge status={p.status} /></td><td>{p.paid_on ? String(p.paid_on).slice(0, 10) : '—'}</td><td>{p.method ?? '—'}{p.reference && <div className="note mono">{p.reference}</div>}</td>
              {manage && <td>{p.status !== 'void' && <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                <ActionForm action={saveVendorPaymentAction} submitLabel="Save" className="form compact row-edit-form" id={`vp-${p.id}`} label="Edit payment"><PaymentFields p={p} look={look} /></ActionForm></details>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && (look.vendors.length === 0 ? <p className="note">Add a vendor under Supply → Vendors first.</p> : (
        <section className="card form-panel" aria-labelledby="nvp-h"><h2 id="nvp-h">Record a vendor payment</h2>
          <ActionForm action={saveVendorPaymentAction} submitLabel="Save payment" id="vendor-payment-form" label="Record vendor payment" resetOnSuccess><PaymentFields look={look} /></ActionForm></section>
      ))}
    </Workspace>
  );
}
