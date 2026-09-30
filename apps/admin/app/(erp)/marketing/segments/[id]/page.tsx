import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getSegment } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { describeRules } from '../rules';

export const metadata: Metadata = { title: 'Segment' };

export default async function SegmentPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/marketing/segments', label: 'Segments' }];
  if (!can(actor, 'marketing.read')) return <><PageHead title="Segment" crumbs={crumbs} /><Forbidden permission="marketing.read" /></>;
  const { id } = await params;
  let data;
  try { data = await getSegment(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { segment, members } = data;
  const customers = can(actor, 'customers.read');
  return (
    <>
      <PageHead title={segment.name} crumbs={crumbs} eyebrow={`${formatNumber(members.count)} customer(s) · ${describeRules(segment.rules)}`}>
        {customers && <a className="btn ghost" href={`/marketing/segments/${segment.id}/export`} download>Download CSV</a>}
      </PageHead>
      <p className="note">A list for staff, not a mailing list: customers have not agreed to marketing emails through this list.</p>
      {members.rows.length === 0 ? <Empty title="No customers match right now" kind="segment-members" /> : (
        <div className="table-wrap"><table data-segment-members>
          <thead><tr><th>Customer</th><th className="num">Paid orders</th><th className="num">Spent</th><th>Last order</th><th>Joined</th></tr></thead>
          <tbody>{members.rows.map(m => (
            <tr key={m.id}><td>{customers ? <Link href={`/customers/${m.id}`}>{m.email}</Link> : m.email}{m.full_name && <div className="note">{m.full_name}</div>}</td>
              <td className="num">{m.orders}</td><td className="num money">{formatPaise(m.spent_paise)}</td>
              <td className="nowrap">{formatDateTime(m.last_order_at as Date | null)}</td><td className="nowrap">{formatDateTime(m.created_at as Date)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
