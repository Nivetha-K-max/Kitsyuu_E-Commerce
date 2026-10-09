/* One stock count (2026-10-09: on the shared entity frame; the count, its rules and its actions are unchanged).

     header  number, status, location, how much is counted and how many sizes differ; Post and Cancel while it is open
     tabs    Counted quantities · Activity

   Posting writes every difference to stock through the stock ledger and closes the count; cancelling changes nothing. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getStockCount } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Entity, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cancelStockCountAction, postStockCountAction, recordCountsAction } from '../actions';

export const metadata: Metadata = { title: 'Stock count' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['lines', 'Counted quantities'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];

export default async function StockCountPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/stock-counts', label: 'Stock counts' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Stock count" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { count: c, lines } = await getStockCount(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const edit = can(actor, 'inventory.count') && c.status === 'open';
  const counted = lines.filter(l => l.counted_qty !== null), differ = counted.filter(l => l.difference !== 0);
  const tabs = TABS.filter(t => t[0] !== 'activity' || can(actor, 'audit.read'));
  const tab: Tab = tabs.find(t => t[0] === sp.tab)?.[0] ?? 'lines';
  const self = `/stock-counts/${c.id}`;
  return (
    <Entity module={{ href: '/stock-counts', label: 'Stock counts' }} name="stock-count" title={c.number} status={<StatusBadge status={c.status} />}
      factsAttr="data-count-facts"
      facts={[
        { label: 'Location', value: c.location },
        { label: 'Opened', value: formatDateTime(c.created_at as Date) },
        { label: 'Counted', value: `${counted.length} of ${lines.length} sizes`, attr: 'counted' },
        { label: 'Different', value: String(differ.length), attr: 'different' },
      ]}
      actions={edit ? <div className="ord-head-actions">
        <ActionForm action={postStockCountAction} submitLabel="Post differences to stock" id="post-count-form" label="Post the count" className="inline-form"
          confirmText="Post this count? Every difference is written to stock and the count is closed.">
          <Hidden name="stockCountId" value={c.id} />
        </ActionForm>
        <ActionForm action={cancelStockCountAction} submitLabel="Cancel count" variant="danger" id="cancel-count-form" label="Cancel the count" className="inline-form"
          confirmText="Cancel this count? Nothing is changed in stock.">
          <Hidden name="stockCountId" value={c.id} />
        </ActionForm>
      </div> : undefined}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'lines' ? lines.length : undefined }))} current={tab} tabHref={t => (t === 'lines' ? self : `${self}?tab=${t}`)}>

      {tab === 'lines' && (
        <Section id="cl-h" title="Counted quantities" name="count-lines" wide
          hint={edit ? 'Enter what is physically there. Leave a size empty if it was not counted; it will not be changed.' : c.status === 'posted' ? 'Posted: the differences below were written to stock.' : undefined}>
          <ActionForm action={recordCountsAction} submitLabel="Save counts" id="counts-form" label="Counted quantities" hideSubmit={!edit}>
            <Hidden name="stockCountId" value={c.id} />
            <div className="table-wrap"><table data-count-lines>
              <thead><tr><th>Piece</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th><th className="num">Stock now</th></tr></thead>
              <tbody>{lines.map(l => (
                <tr key={l.id} data-line={l.variant_sku} data-diff={l.difference ?? ''}>
                  <td>{l.name}<div className="note mono">{l.variant_sku} · {l.size}</div></td>
                  <td className="num">{l.expected_qty}</td>
                  <td className="num">{edit
                    ? <input className="input qty-input" name={`counted:${l.id}`} inputMode="numeric" defaultValue={l.counted_qty ?? ''} aria-label={`Counted ${l.variant_sku}`} />
                    : (l.counted_qty ?? '—')}</td>
                  <td className="num">{l.difference === null ? '—' : l.difference > 0 ? `+${l.difference}` : l.difference}</td>
                  <td className="num">{l.current_qty}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </ActionForm>
        </Section>
      )}

      {tab === 'activity' && (
        <Section id="ca-h" title="Activity" name="activity" wide hint="Every change to this count, from the audit log.">
          <RecordActivity entityType="stock_counts" entityId={c.id} name="stock-count" empty="Changes to this count are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
