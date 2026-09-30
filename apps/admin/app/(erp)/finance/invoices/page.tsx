import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listInvoices, ordersWithoutInvoice } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { createInvoiceAction } from '../actions';
import FinanceNav from '../FinanceNav';

export const metadata: Metadata = { title: 'Invoices' };

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const sp = await searchParams;
  const status = ['issued', 'void', 'all'].includes(one(sp.status)) ? one(sp.status) : 'all';
  const q = one(sp.q).trim().slice(0, 40) || undefined;
  const page = pageOf(sp.page);
  const [list, pending] = await Promise.all([listInvoices(db(), actor, { q, status, page }), ordersWithoutInvoice(db(), actor, 25)]);
  const manage = can(actor, 'finance.manage');
  return (
    <>
      <PageHead title="Finance" eyebrow="GST invoices for paid orders, built exactly from what the order was charged. Numbers are gap-free per financial year." />
      <FinanceNav current="/finance/invoices" />
      <FilterForm className="actions" role="search" aria-label="Filter invoices">
        <label className="sr-only" htmlFor="iv-q">Search</label>
        <input id="iv-q" name="q" className="input" placeholder="Invoice or order number" defaultValue={q ?? ''} />
        <select name="status" className="input" defaultValue={status} aria-label="Status"><option value="all">All</option><option value="issued">Issued</option><option value="void">Void</option></select>
        <button className="btn ghost" type="submit">Apply</button>
      </FilterForm>
      {list.rows.length === 0 ? <Empty title="No invoices yet" kind="invoices" /> : (
        <div className="table-wrap"><table data-invoices-table>
          <thead><tr><th>Invoice</th><th>Order</th><th>Issued</th><th>Place of supply</th><th className="num">Tax</th><th className="num">Total</th><th>Status</th></tr></thead>
          <tbody>{list.rows.map(i => (
            <tr key={i.id}><td className="mono"><Link className="row-link" href={`/finance/invoices/${i.id}`}>{i.invoice_number ?? 'draft'}</Link></td><td className="mono">{i.order_number ?? '—'}</td>
              <td className="nowrap">{formatDateTime(i.issued_at as Date | null)}</td><td>{i.place_of_supply ?? '—'}</td>
              <td className="num money">{formatPaise(i.tax_paise)}</td><td className="num money">{formatPaise(i.total_paise)}</td><td><StatusBadge status={i.status} /></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={`/finance/invoices?status=${status}&page=${page - 1}`}>Previous</Link>}
        {list.hasNext && <Link className="btn ghost sm" href={`/finance/invoices?status=${status}&page=${page + 1}`}>Next</Link>}
      </nav>
      <section className="card" aria-labelledby="pi-h" data-section="orders-without-invoice">
        <h2 id="pi-h">Paid orders without an invoice</h2>
        {pending.length === 0 ? <Empty compact title="Every paid order has an invoice" /> : (
          <div className="table-wrap"><table data-uninvoiced>
            <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th className="num">Total</th>{manage && <th />}</tr></thead>
            <tbody>{pending.map(o => (
              <tr key={o.id} data-uninvoiced-order={o.order_number}><td className="mono">{o.order_number}</td><td className="nowrap">{formatDateTime(o.created_at as Date)}</td><td><StatusBadge status={o.status} /></td>
                <td className="num money">{formatPaise(o.total_paise)}</td>
                {manage && <td><ActionForm action={createInvoiceAction} submitLabel="Issue invoice" variant="ghost" className="inline-form" id={`inv-${o.id}`} label="Issue invoice"
                  confirmText={`Issue an invoice for order ${o.order_number}? Its number is final.`}><Hidden name="orderId" value={o.id} /></ActionForm></td>}</tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
