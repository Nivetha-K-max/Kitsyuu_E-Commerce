import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listLocations, listStockCounts } from '@kitsyuu/core';
import { ActionForm, Field, Select } from '@/components/forms';
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
  const [counts, locations] = await Promise.all([listStockCounts(db(), actor), listLocations(db(), actor, { activeOnly: true })]);
  // Third pass: one open count per location.
  const open = counts.filter(c => c.status === 'open'), free = locations.filter(l => !open.some(c => c.location_id === l.id));
  return (
    <>
      <PageHead section="Catalogue" title="Stock counts" eyebrow="Count what is on the shelf; only differences are posted to stock." />
      {counts.length === 0 ? <Empty title="No stock counts yet" kind="stock-counts">Open a count to check physical stock against the system.</Empty> : (
        <div className="table-wrap"><table data-counts-table>
          <thead><tr><th>Count</th><th>Location</th><th className="num">Sizes counted</th><th>Status</th><th>Posted</th></tr></thead>
          <tbody>{counts.map(c => (
            <tr key={c.id} data-count={c.number}>
              <td><Link href={`/stock-counts/${c.id}`} className="row-link mono-strong">{c.number}</Link><div className="note">{formatDateTime(c.created_at as Date)}{c.created_by ? ` · ${c.created_by}` : ''}{c.note ? ` · ${c.note}` : ''}</div></td>
              <td>{c.location}</td>
              <td className="num">{c.counted} / {c.lines}</td>
              <td><StatusBadge status={c.status} /></td>
              <td>{c.posted_at ? formatDateTime(c.posted_at as Date) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {can(actor, 'inventory.count') && open.map(o => <p key={o.id} className="note">Count <Link href={`/stock-counts/${o.id}`}>{o.number}</Link> is open for {o.location}. Post or cancel it before starting another there.</p>)}
      {can(actor, 'inventory.count') && (free.length === 0
        ? null
        : <section className="card form-panel" aria-labelledby="nc-h" data-section="new-count">
            <h2 id="nc-h">New stock count</h2>
            <ActionForm action={openStockCountAction} submitLabel="Open count" id="open-count-form" label="Open a stock count">
              <Select name="locationId" label="Location" required options={free.map(l => ({ value: l.id, label: l.name }))} defaultValue={free[0]?.id} />
              <Field name="note" label="Note (optional)" hint="e.g. Month-end count, shelf A" />
            </ActionForm>
          </section>)}
    </>
  );
}
