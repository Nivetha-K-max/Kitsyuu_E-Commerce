import ModuleViews from '@/components/ModuleViews';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listTransfers } from '@kitsyuu/core';
import { StateBlock, ViewTabs, Workspace } from '@/components/frame';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
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
  const current = STATUSES.some(s => s[0] === status) ? status : '';
  const transfers = await listTransfers(db(), actor, { status: current || undefined });
  const manage = can(actor, 'inventory.transfer');
  return (
    <Workspace name="transfers" title="Transfers" summary="Stock leaves the sender when a transfer is sent and arrives when it is received"
      actions={manage ? <Link className="btn" href="/transfers/new" data-link="new-transfer">New transfer</Link> : undefined}>
      <ModuleViews module="inventory" label="Inventory" current="/transfers" />
      <div data-transfer-views><ViewTabs label="Transfer status" current={current || 'all'} items={STATUSES.map(([v, label]) => ({ id: v || 'all', label: v ? label : 'All transfers', href: v ? `/transfers?status=${v}` : '/transfers' }))} /></div>
      {transfers.length === 0 ? <StateBlock title={current ? `No ${current} transfers` : 'No transfers yet'} name="transfers">{manage ? 'Start one with New transfer: choose the two locations, then the quantities.' : 'Transfers between locations appear here.'}</StateBlock> : (
        <div className="table-wrap ord-table" data-fresh key={current}><table data-transfers-table>
          <thead><tr><th>Transfer</th><th>From</th><th>To</th><th className="num">Units</th><th>Status</th><th>Received</th></tr></thead>
          <tbody>{transfers.map(t => (
            <tr key={t.id} data-transfer={t.number}>
              <td className="ord-who"><Link href={`/transfers/${t.id}`} className="row-link mono-strong">{t.number}</Link><div className="note">{formatDateTime(t.created_at as Date)}</div></td>
              <td className="ord-extra" data-label="From">{t.from_name}</td>
              <td className="ord-extra" data-label="To">{t.to_name}</td>
              <td className="num ord-amount">{formatNumber(t.units)}<div className="note">{t.lines} size(s)</div></td>
              <td className="ord-stage"><StatusBadge status={t.status} /></td>
              <td className="ord-extra" data-label="Received">{t.received_at ? formatDateTime(t.received_at as Date) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
