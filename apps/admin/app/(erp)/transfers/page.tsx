import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listTransfers } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Transfers' };
type Search = Promise<{ status?: string }>;

const STATUSES = [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['received', 'Received'], ['cancelled', 'Cancelled']] as const;

/* Third pass: moving stock between locations. Draft → sent (stock leaves the sender) → received (stock arrives). */
export default async function TransfersPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Transfers" /><Forbidden permission="inventory.read" /></>;
  const { status = '' } = await searchParams;
  const transfers = await listTransfers(db(), actor, { status: status || undefined });
  return (
    <>
      <PageHead section="Catalogue" title="Transfers" eyebrow="Stock leaves the sender when a transfer is sent and arrives when it is received.">
        {can(actor, 'inventory.transfer') && <Link className="btn" href="/transfers/new">New transfer</Link>}
      </PageHead>
      <nav className="tabs" aria-label="Filter by status">
        {STATUSES.map(([v, label]) => <Link key={v} href={v ? `/transfers?status=${v}` : '/transfers'} aria-current={status === v ? 'page' : undefined}>{label}</Link>)}
      </nav>
      {transfers.length === 0 ? <Empty title="No transfers" kind="transfers">{can(actor, 'inventory.transfer') ? 'Start one with New transfer.' : undefined}</Empty> : (
        <div className="table-wrap"><table data-transfers-table>
          <thead><tr><th>Transfer</th><th>From</th><th>To</th><th className="num">Units</th><th>Status</th><th>Received</th></tr></thead>
          <tbody>{transfers.map(t => (
            <tr key={t.id} data-transfer={t.number}>
              <td><Link href={`/transfers/${t.id}`} className="row-link mono-strong">{t.number}</Link><div className="note">{formatDateTime(t.created_at as Date)}</div></td>
              <td>{t.from_name}</td>
              <td>{t.to_name}</td>
              <td className="num">{formatNumber(t.units)}<div className="note">{t.lines} size(s)</div></td>
              <td><StatusBadge status={t.status} /></td>
              <td>{t.received_at ? formatDateTime(t.received_at as Date) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
