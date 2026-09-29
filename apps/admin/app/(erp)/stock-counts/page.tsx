import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listStockCounts } from '@kitsyuu/core';
import { ActionForm, Field } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { openStockCountAction } from './actions';

export const metadata: Metadata = { title: 'Stock counts' };

/* M15: stock-take. Opening a count records what the system expects for every size; posting applies only the
   differences found, through the stock ledger. */
export default async function StockCountsPage() {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Stock counts" /><Forbidden permission="inventory.read" /></>;
  const counts = await listStockCounts(db(), actor);
  const open = counts.find(c => c.status === 'open');
  return (
    <>
      <PageHead section="Catalogue" title="Stock counts" eyebrow="Count what is on the shelf; only differences are posted to stock." />
      {counts.length === 0 ? <Empty title="No stock counts yet" kind="stock-counts">Open a count to check physical stock against the system.</Empty> : (
        <div className="table-wrap"><table data-counts-table>
          <thead><tr><th>Count</th><th className="num">Sizes counted</th><th>Status</th><th>Posted</th></tr></thead>
          <tbody>{counts.map(c => (
            <tr key={c.id} data-count={c.number}>
              <td><Link href={`/stock-counts/${c.id}`} className="row-link mono-strong">{c.number}</Link><div className="note">{formatDateTime(c.created_at as Date)}{c.created_by ? ` · ${c.created_by}` : ''}{c.note ? ` · ${c.note}` : ''}</div></td>
              <td className="num">{c.counted} / {c.lines}</td>
              <td><StatusBadge status={c.status} /></td>
              <td>{c.posted_at ? formatDateTime(c.posted_at as Date) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {can(actor, 'inventory.count') && (open
        ? <p className="note">Count <Link href={`/stock-counts/${open.id}`}>{open.number}</Link> is open. Post or cancel it before starting another.</p>
        : <section className="card form-panel" aria-labelledby="nc-h" data-section="new-count">
            <h2 id="nc-h">New stock count</h2>
            <ActionForm action={openStockCountAction} submitLabel="Open count" id="open-count-form" label="Open a stock count">
              <Field name="note" label="Note (optional)" hint="e.g. Month-end count, shelf A" />
            </ActionForm>
          </section>)}
    </>
  );
}
