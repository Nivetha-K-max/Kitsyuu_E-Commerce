import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { companyDetails, getPurchaseOrder } from '@kitsyuu/core';
import { Forbidden, PageHead } from '@/components/ui';
import PrintButton from '@/components/PrintButton';
import { formatDateTime, formatDay, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Purchase order' };
type Params = Promise<{ id: string }>;

/* Client change request: a printable purchase order (A4, the browser's print dialog; no PDF service). Everything comes
   from the purchase order, the vendor record and Settings → Company; anything not entered there is left out (never
   invented). Purchase orders record no tax or discount, so none is shown; prices only for staff with costs.read. */
export default async function PrintPurchaseOrder({ params }: { params: Params }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Purchase order" /><Forbidden permission="procurement.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [d, company] = await Promise.all([getPurchaseOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; }), companyDetails(db())]);
  const o = d.order;
  const vendor = [o.vendor, o.vendor_contact, o.vendor_address, o.vendor_phone, o.vendor_email].filter(Boolean) as string[];
  return (
    <>
      <div className="no-print">
        <PageHead section="Supply" title={`Print · ${o.po_number}`} crumbs={[{ href: '/purchase-orders', label: 'Purchase orders' }, { href: `/purchase-orders/${o.id}`, label: o.po_number }]}>
          <PrintButton label="Print PO" />
        </PageHead>
        {!company.legalName && <p className="msg" data-company-missing>Company details are not entered yet. Add them under <Link href="/settings">Settings → Company</Link> to print them.</p>}
        {o.status === 'draft' && <p className="msg" role="status">This purchase order is still a draft (not placed with the vendor).</p>}
      </div>
      <article className="slip card" data-po-print>
        <header className="slip-head">
          <div>
            <p className="slip-brand">{company.legalName ?? 'KITSYUU'}</p>
            {company.address && <p className="slip-addr">{company.address}</p>}
            {company.gstin && <p className="note mono">GSTIN {company.gstin}</p>}
            {(company.supportEmail || company.phone) && <p className="note">{[company.supportEmail, company.phone].filter(Boolean).join(' · ')}</p>}
          </div>
          <dl className="slip-meta">
            <div><dt>Purchase order</dt><dd className="mono">{o.po_number}</dd></div>
            <div><dt>Date</dt><dd>{formatDateTime((o.ordered_at ?? o.created_at) as Date)}</dd></div>
            <div><dt>Deliver to</dt><dd>{o.location}</dd></div>
            {o.expected_on && <div><dt>Expected delivery</dt><dd>{formatDay(o.expected_on)}</dd></div>}
            <div><dt>Status</dt><dd>{String(o.status).replace(/_/g, ' ')}</dd></div>
            {o.created_by && <div><dt>Created by</dt><dd>{o.created_by}</dd></div>}
          </dl>
        </header>
        <section className="slip-to" aria-label="Vendor">
          <h2>Vendor</h2>
          {vendor.map((l, i) => <div key={i} className={i ? undefined : 'mono-strong'}>{l}</div>)}
          {o.vendor_gstin && <div className="note mono">GSTIN {o.vendor_gstin}</div>}
        </section>
        <table className="slip-items" data-po-print-items>
          <thead><tr><th>#</th><th>Item</th><th>Code</th><th className="num">Qty</th><th>Unit</th>{d.canSeeCosts && <><th className="num">Unit price</th><th className="num">Total</th></>}</tr></thead>
          <tbody>{d.lines.map((l, i) => (
            <tr key={l.id}><td>{i + 1}</td><td>{l.name}</td><td className="mono">{l.code}</td><td className="num">{l.ordered}</td><td>{l.unit}</td>
              {d.canSeeCosts && <><td className="num">{l.unitCostPaise == null ? '—' : formatPaise(l.unitCostPaise)}</td>
                <td className="num">{l.unitCostPaise == null ? '—' : formatPaise(Math.round(l.unitCostPaise * l.ordered))}</td></>}</tr>
          ))}</tbody>
          {d.canSeeCosts && d.totalPaise !== undefined && (
            <tfoot>
              <tr><th colSpan={6} className="num">Subtotal</th><td className="num">{formatPaise(Math.round(d.totalPaise))}</td></tr>
              <tr><th colSpan={6} className="num">Grand total</th><td className="num"><b>{formatPaise(Math.round(d.totalPaise))}</b></td></tr>
            </tfoot>
          )}
        </table>
        {d.canSeeCosts && d.lines.some(l => l.unitCostPaise == null) && <p className="note">Lines without a price are not included in the total.</p>}
        {o.notes && <section><h2 className="slip-sub">Notes / terms</h2><p className="slip-addr">{o.notes}</p></section>}
      </article>
    </>
  );
}
