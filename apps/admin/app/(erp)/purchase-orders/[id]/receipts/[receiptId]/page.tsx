import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { companyDetails, getGoodsReceipt } from '@kitsyuu/core';
import { Forbidden, PageHead } from '@/components/ui';
import PrintButton from '@/components/PrintButton';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Goods receipt' };
type Params = Promise<{ id: string; receiptId: string }>;
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

/* One goods receipt (GRN): what physically arrived in one delivery against a purchase order, with the order's totals so far.
   Printable on A4 from the browser (print / save as PDF), like the purchase order print-out. */
export default async function GoodsReceiptPage({ params }: { params: Params }) {
  const actor = await requireActor();
  if (!can(actor, 'procurement.read')) return <><PageHead section="Supply" title="Goods receipt" /><Forbidden permission="procurement.read" /></>;
  const { id, receiptId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(receiptId)) notFound();
  const [d, company] = await Promise.all([getGoodsReceipt(db(), actor, receiptId).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; }), companyDetails(db())]);
  const g = d.receipt;
  if (g.po_id !== id) notFound();
  const number = g.receipt_number ?? 'Delivery';
  return (
    <>
      <div className="no-print">
        <PageHead section="Supply" title={number} crumbs={[{ href: '/purchase-orders', label: 'Purchase orders' }, { href: `/purchase-orders/${id}`, label: g.po_number }]}>
          <PrintButton label="Print GRN" />
        </PageHead>
        <p className="note" data-grn-trace>What this delivery added to stock is listed, row by row from the stock ledger, under <Link href={`/purchase-orders/${id}?tab=receiving`} data-link="po-receiving">Receiving on {g.po_number}</Link>.</p>
      </div>
      <article className="slip card" data-grn-print>
        <header className="slip-head">
          <div>
            <p className="slip-brand">{company.legalName ?? 'KITSYUU'}</p>
            {company.address && <p className="slip-addr">{company.address}</p>}
            {company.gstin && <p className="note mono">GSTIN {company.gstin}</p>}
          </div>
          <dl className="slip-meta">
            <div><dt>Goods receipt</dt><dd className="mono" data-grn-number>{number}</dd></div>
            <div><dt>Purchase order</dt><dd className="mono"><Link href={`/purchase-orders/${id}`}>{g.po_number}</Link></dd></div>
            <div><dt>Received</dt><dd>{formatDateTime(g.received_at as Date)}</dd></div>
            {g.received_by && <div><dt>Received by</dt><dd>{g.received_by}</dd></div>}
            {g.location_name && <div><dt>Received at</dt><dd>{g.location_name}</dd></div>}
            {g.vendor_ref && <div><dt>Vendor's ref</dt><dd className="mono">{g.vendor_ref}</dd></div>}
          </dl>
        </header>
        <section className="slip-to" aria-label="Vendor">
          <h2>Vendor</h2>
          <div className="mono-strong">{g.vendor}</div>
          {g.vendor_address && <div>{g.vendor_address}</div>}
          {g.vendor_phone && <div>{g.vendor_phone}</div>}
          {g.vendor_gstin && <div className="note mono">GSTIN {g.vendor_gstin}</div>}
        </section>
        <table className="slip-items" data-grn-items>
          <thead><tr><th>#</th><th>Item</th><th>Code</th><th className="num">Received now</th><th className="num">Ordered</th><th className="num">Received in all</th><th className="num">Remaining</th>
            {d.canSeeCosts && <th className="num">Value</th>}</tr></thead>
          <tbody>{d.lines.map((l, i) => (
            <tr key={l.id} data-grn-line={l.code}><td>{i + 1}</td><td>{l.name}</td><td className="mono">{l.code}</td>
              <td className="num"><b>{fmt(l.qty)}</b> {l.unit}</td><td className="num">{fmt(l.ordered)}</td><td className="num">{fmt(l.receivedSoFar)}</td>
              <td className="num">{fmt(Math.max(0, l.ordered - l.receivedSoFar))}</td>
              {d.canSeeCosts && <td className="num">{l.unitCostPaise == null ? '—' : formatPaise(Math.round(l.unitCostPaise * l.qty))}</td>}</tr>
          ))}</tbody>
          {d.canSeeCosts && d.totalPaise !== undefined && <tfoot><tr><th colSpan={7} className="num">Value received</th><td className="num"><b>{formatPaise(Math.round(d.totalPaise))}</b></td></tr></tfoot>}
        </table>
        <p className="note">"Received in all" and "Remaining" are the order's totals as of now, including any later deliveries.</p>
        {g.note && <section><h2 className="slip-sub">Note</h2><p className="slip-addr">{g.note}</p></section>}
      </article>
    </>
  );
}
