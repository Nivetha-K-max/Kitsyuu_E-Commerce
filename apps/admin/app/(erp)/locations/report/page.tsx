import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { locationReportQuery } from '@kitsyuu/contracts';
import { locationReport } from '@kitsyuu/core';
import { Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Location report' };
type Search = Promise<Record<string, string | undefined>>;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const signed = (n: number) => (n > 0 ? `+${formatNumber(n)}` : formatNumber(n));

/* Third pass: stock by location and what moved in a period, and sales by channel. Retail takings are not recorded until
   a till / POS is decided (client input), so the retail channel shows units only. */
export default async function LocationReportPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/locations', label: 'Locations' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Location report" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const parsed = locationReportQuery.safeParse(await searchParams);
  const today = new Date(), monthAgo = new Date(today.getTime() - 30 * 86_400_000);
  const fromDay = (parsed.success && parsed.data.from) || iso(monthAgo), toDay = (parsed.success && parsed.data.to) || iso(today);
  const from = new Date(`${fromDay}T00:00:00+05:30`), to = new Date(new Date(`${toDay}T00:00:00+05:30`).getTime() + 86_400_000);
  const r = await locationReport(db(), actor, { from, to });
  return (
    <>
      <PageHead section="Catalogue" title="Location report" crumbs={crumbs} eyebrow={`${fromDay} to ${toDay} (India time)`} />
      <form className="toolbar" method="get" aria-label="Report period">
        <label className="field-inline">From <input className="input" type="date" name="from" defaultValue={fromDay} /></label>
        <label className="field-inline">To <input className="input" type="date" name="to" defaultValue={toDay} /></label>
        <button className="btn ghost" type="submit">Show</button>
      </form>

      <section className="card" aria-labelledby="rc-h" data-section="channels">
        <SectionTitle id="rc-h">Sales by channel</SectionTitle>
        <div className="table-wrap"><table data-channels>
          <thead><tr><th>Channel</th><th className="num">Orders</th><th className="num">Units</th><th className="num">Takings</th></tr></thead>
          <tbody>
            <tr data-channel="online"><td>Online store</td><td className="num">{formatNumber(r.channels.online.orders)}</td><td className="num">{formatNumber(r.channels.online.units)}</td><td className="num">{formatPaise(r.channels.online.revenuePaise)}</td></tr>
            <tr data-channel="retail"><td>Retail (in-store)</td><td className="num">—</td><td className="num">{formatNumber(r.channels.retail.units)}</td><td className="num">—</td></tr>
          </tbody>
        </table></div>
        <p className="note">Online: paid, processing, shipped and delivered orders placed in the period. Retail: units recorded as “Retail sale” at retail locations; takings are not recorded until a till / POS is set up.</p>
      </section>

      <section className="card" aria-labelledby="rl-h" data-section="by-location">
        <SectionTitle id="rl-h">By location</SectionTitle>
        <div className="table-wrap"><table data-by-location>
          <thead><tr><th>Location</th><th className="num">Stock now</th><th className="num">Sold online</th><th className="num">Retail sales</th><th className="num">Transfers in</th><th className="num">Transfers out</th><th className="num">Other changes</th></tr></thead>
          <tbody>{r.locations.map(l => (
            <tr key={l.id} data-location={l.code}>
              <td><Link href={`/locations/${l.id}`}>{l.name}</Link>{l.is_online ? <div className="note">Online store stock</div> : null}</td>
              <td className="num">{formatNumber(l.units)}</td>
              <td className="num">{formatNumber(l.soldOnline)}</td>
              <td className="num">{formatNumber(l.retailSales)}</td>
              <td className="num">{formatNumber(l.transfersIn)}</td>
              <td className="num">{formatNumber(l.transfersOut)}</td>
              <td className="num">{signed(l.adjustments)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="note">Units in the period. “Sold online” is net of cancelled orders. “Other changes” covers deliveries, returns, damage, counts and corrections.</p>
      </section>
    </>
  );
}
