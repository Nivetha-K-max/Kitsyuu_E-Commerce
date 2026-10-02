import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { companyDetails, getPosSale, returnSettings } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import PrintButton from '@/components/PrintButton';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { issueInvoiceAction, staffReturnAction, voidSaleAction } from '../../actions';
import AutoPrint from './AutoPrint';

export const metadata: Metadata = { title: 'POS bill' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const METHOD: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card' };

export default async function PosSalePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/pos', label: 'POS billing' }];
  if (!can(actor, 'pos.access')) return <><PageHead title="POS bill" crumbs={crumbs} /><Forbidden permission="pos.access" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const v = await getPosSale(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const [company, rs, reasons] = await Promise.all([companyDetails(db()), returnSettings(db()),
    db().selectFrom('return_reasons').select(['code', 'label']).where('is_active', '=', true).orderBy('sort_order').execute()]);
  const { sale: s, items, payment, pos } = v;
  const contact = (s.contact ?? {}) as { name?: string | null; phone?: string | null; email?: string | null };
  const voided = s.status === 'cancelled';
  const autoprint = (await searchParams).print === '1';
  const returnable = !voided && s.status === 'delivered' && rs.enabled && !!rs.windowDays && can(actor, 'returns.manage');
  return (
    <>
      {autoprint && <AutoPrint />}
      <div className="no-print">
        <PageHead title={s.pos_number!} crumbs={crumbs} eyebrow={`${s.location_name} · order ${s.order_number}`}>
          <PrintButton label="Print bill" />
          <Link className="btn ghost" href={`/orders/${s.id}`}>Order</Link>
          <Link className="btn" href="/pos" data-pos-back>New sale</Link>
        </PageHead>
        {voided && <p className="msg error" role="status" data-pos-voided>This sale was voided: the stock went back to {s.location_name} and the payment was returned.</p>}
      </div>

      <article className="pos-receipt" data-pos-receipt aria-label="Bill">
        <header>
          <p className="pos-brand">KITSYUU</p>
          {company.legalName && <p>{company.legalName}</p>}
          <p>{s.location_name}{s.location_address ? `, ${s.location_address}` : ''}</p>
          {company.gstin && <p>GSTIN {company.gstin}</p>}
          {company.phone && <p>Tel {company.phone}</p>}
          <p className="pos-receipt-title">{voided ? 'VOIDED — ' : ''}{v.invoice ? 'TAX INVOICE' : 'BILL'}</p>
        </header>
        <dl className="pos-receipt-meta">
          <dt>Bill no.</dt><dd data-receipt-number>{s.pos_number}</dd>
          {v.invoice && <><dt>Invoice no.</dt><dd data-receipt-invoice>{v.invoice.invoice_number}</dd></>}
          <dt>Order</dt><dd>{s.order_number}</dd>
          <dt>Date</dt><dd>{formatDateTime(s.created_at as Date)}</dd>
          <dt>Cashier</dt><dd>{s.cashier_name || s.cashier_email}</dd>
          <dt>Customer</dt><dd data-receipt-customer>{s.customer_name ?? contact.name ?? 'Walk-in customer'}{(contact.phone) ? ` · ${contact.phone}` : ''}</dd>
        </dl>
        <table className="pos-receipt-lines">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
          <tbody>{items.map(i => (
            <tr key={i.id} data-receipt-line={i.sku}>
              <td>{i.name}<br /><small>{i.sku} · {i.colour ? `${i.colour} · ` : ''}Size {i.size}</small></td>
              <td className="num">{i.qty}</td><td className="num">{formatPaise(i.unit_price_paise)}</td><td className="num">{formatPaise(i.line_total_paise)}</td>
            </tr>
          ))}</tbody>
        </table>
        <dl className="pos-receipt-totals">
          <dt>Subtotal</dt><dd>{formatPaise(s.subtotal_paise)}</dd>
          {s.discount_paise > 0 && <><dt>Discount{s.staff_discount_bp ? ` (${s.staff_discount_bp / 100}%${s.staff_discount_reason ? `: ${s.staff_discount_reason}` : ''})` : ''}</dt><dd>− {formatPaise(s.discount_paise)}</dd></>}
          {v.tax && v.tax.configured
            ? <><dt>{v.tax.label}{s.prices_include_tax ? ' (included)' : ''}</dt><dd>{formatPaise(s.tax_paise)}</dd></>
            : null}
          <dt className="pos-total">Total</dt><dd className="pos-total" data-receipt-total>{formatPaise(s.total_paise)}</dd>
          <dt>Paid by</dt><dd data-receipt-method>{METHOD[payment?.method ?? s.payment_method ?? ''] ?? s.payment_method}{pos?.reference ? ` · Ref ${pos.reference}` : ''}</dd>
          {pos?.tenderedPaise != null && <><dt>Cash received</dt><dd>{formatPaise(pos.tenderedPaise)}</dd><dt>Change</dt><dd>{formatPaise(pos.changePaise ?? 0)}</dd></>}
        </dl>
        <footer>
          <p>{rs.enabled && rs.windowDays ? `Returns within ${rs.windowDays} days with this bill, as per store policy.` : 'All sales are final.'}</p>
          <p>Thank you for shopping at KITSYUU.</p>
        </footer>
      </article>

      <div className="no-print pos-after">
        {v.returns.length > 0 && <p className="note">Returns: {v.returns.map(r => <Link key={r.id} href={`/returns/${r.id}`}>{r.number} ({r.status.replace(/_/g, ' ')}) </Link>)}</p>}
        {!v.invoice && !voided && can(actor, 'finance.manage') && (
          <ActionForm action={issueInvoiceAction} submitLabel="Issue tax invoice" variant="ghost" id="pos-invoice-form" label="Issue tax invoice">
            <Hidden name="orderId" value={s.id} />
          </ActionForm>
        )}
        {v.canVoid && (
          <section className="card" aria-labelledby="void-h">
            <h2 id="void-h">Void this sale</h2>
            <p className="note">Only while the session is open (a mistake at the counter). Stock goes back to {s.location_name}; give the money back to the customer.</p>
            <ActionForm action={voidSaleAction} submitLabel="Void sale" variant="danger" confirmText={`Void ${s.pos_number}?`} id="pos-void-form">
              <Hidden name="orderId" value={s.id} />
              <Field name="reason" label="Reason" />
            </ActionForm>
          </section>
        )}
        {returnable && (
          <section className="card" aria-labelledby="ret-h">
            <h2 id="ret-h">Return / exchange at the counter</h2>
            <p className="note">Opens a return in Returns &amp; refunds (same rules and workflow as every return). Stock goes back to {s.location_name}.</p>
            <ActionForm action={staffReturnAction} submitLabel="Open return" id="pos-return-form">
              <Hidden name="orderId" value={s.id} />
              {items.map(i => <Field key={i.id} name={`qty_${i.id}`} label={`${i.name} · ${i.size} (bought ${i.qty}) — quantity returned`} defaultValue="0" />)}
              <Select name="reasonCode" label="Reason" options={reasons.map(r => ({ value: r.code, label: r.label }))} />
              <TextArea name="description" label="Note (optional)" rows={2} />
            </ActionForm>
          </section>
        )}
      </div>
    </>
  );
}
