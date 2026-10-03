import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { companyDetails, getOrder } from '@kitsyuu/core';
import { Forbidden, PageHead } from '@/components/ui';
import PrintButton from '@/components/PrintButton';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Packing slip' };
type Params = Promise<{ id: string }>;

/* M10: a printable packing slip (orders.read). It goes into the parcel, so it shows no prices. Company details come from
   Configuration → Company; anything not entered there is simply left out (never invented). */
export default async function PackingSlip({ params }: { params: Params }) {
  const actor = await requireActor();
  if (!can(actor, 'orders.read')) return <><PageHead section="Commerce" title="Packing slip" /><Forbidden permission="orders.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [d, company] = await Promise.all([
    getOrder(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; }),
    companyDetails(db()),
  ]);
  const o = d.order;
  const address = [d.shipping.name, d.shipping.line1, d.shipping.line2, [d.shipping.city, d.shipping.state, d.shipping.pin].filter(Boolean).join(', '), d.shipping.country].filter(Boolean);
  const units = d.items.reduce((n, i) => n + i.qty, 0);
  return (
    <>
      <div className="no-print">
        <PageHead section="Commerce" title={`Packing slip · ${o.orderNumber}`} crumbs={[{ href: '/orders', label: 'Orders' }, { href: `/orders/${o.id}`, label: o.orderNumber }]}>
          <PrintButton />
        </PageHead>
        {!company.legalName && <p className="msg" data-company-missing>Company details are not entered yet. Add them under <Link href="/settings">Configuration → Company</Link> to print them on slips.</p>}
      </div>
      <article className="slip card" data-packing-slip>
        <header className="slip-head">
          <div>
            <p className="slip-brand">{company.legalName ?? 'KITSYUU'}</p>
            {company.address && <p className="slip-addr">{company.address}</p>}
            {company.gstin && <p className="note mono">GSTIN {company.gstin}</p>}
          </div>
          <dl className="slip-meta">
            <div><dt>Order</dt><dd className="mono">{o.orderNumber}</dd></div>
            <div><dt>Placed</dt><dd>{formatDateTime(o.createdAt)}</dd></div>
            <div><dt>Items</dt><dd>{units}</dd></div>
          </dl>
        </header>
        <section className="slip-to" aria-label="Ship to">
          <h2>Ship to</h2>
          {address.length ? address.map((l, i) => <div key={i}>{l}</div>) : <p className="note">No delivery address on this order.</p>}
          {d.contact.phone && <div className="note">Phone {d.contact.phone}</div>}
        </section>
        <table className="slip-items" data-slip-items>
          <thead><tr><th>Item</th><th>SKU</th><th>Size</th><th className="num">Qty</th><th className="slip-check">Packed</th></tr></thead>
          <tbody>{d.items.map(i => (
            <tr key={i.id}><td>{i.name}</td><td className="mono">{i.sku}</td><td>{i.colour ? `${i.colour} / ` : ''}{i.size ?? '—'}</td><td className="num">{i.qty}</td><td className="slip-check">☐</td></tr>
          ))}</tbody>
        </table>
        {(company.supportEmail || company.phone) && (
          <footer className="slip-foot">Questions about your order? {[company.supportEmail, company.phone].filter(Boolean).join(' · ')}</footer>
        )}
      </article>
    </>
  );
}
