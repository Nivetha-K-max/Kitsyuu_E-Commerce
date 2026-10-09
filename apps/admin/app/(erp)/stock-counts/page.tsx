/* Inventory → Stock counts (2026-10-09: on the shared workspace frame; the count, its rules and its actions are unchanged).
   A stock-take: opening a count records what the system expects for every size at one location; posting applies only the
   differences found, through the stock ledger. One open count per location. A count opens on its own page. */
import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { listLocations, listStockCounts } from '@kitsyuu/core';
import ModuleViews from '@/components/ModuleViews';
import { ActionForm, Field, Select } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { openStockCountAction } from './actions';

export const metadata: Metadata = { title: 'Stock counts' };

export default async function StockCountsPage() {
  const actor = await requireActor();
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Stock counts" /><Forbidden permission="inventory.read" /></>;
  const [counts, locations] = await Promise.all([listStockCounts(db(), actor), listLocations(db(), actor, { activeOnly: true })]);
  const count = can(actor, 'inventory.count');
  // One open count per location.
  const open = counts.filter(c => c.status === 'open'), free = locations.filter(l => !open.some(c => c.location_id === l.id));
  return (
    <Workspace name="stock-counts" title="Stock counts"
      summary={`${formatNumber(counts.length)} count${counts.length === 1 ? '' : 's'}${open.length ? ` · ${formatNumber(open.length)} open` : ''} · only differences are posted to stock`}
      actions={count && free.length > 0 ? (
        <Drawer trigger="New stock count" name="new-count" scope="ord" title="New stock count"
          description="Opening a count records what the system expects for every size at the location. Nothing changes in stock until the count is posted.">
          <ActionForm action={openStockCountAction} submitLabel="Open count" id="open-count-form" label="Open a stock count">
            <Select name="locationId" label="Location" required options={free.map(l => ({ value: l.id, label: l.name }))} defaultValue={free[0]?.id} />
            <Field name="note" label="Note (optional)" hint="e.g. Month-end count, shelf A" />
          </ActionForm>
        </Drawer>
      ) : undefined}>
      <ModuleViews module="inventory" label="Inventory" current="/stock-counts" />
      {count && open.map(o => <p key={o.id} className="note" data-open-count={o.number}>Count <NavLink href={`/stock-counts/${o.id}`}>{o.number}</NavLink> is open for {o.location}. Post or cancel it before starting another there.</p>)}
      {counts.length === 0 ? (
        <StateBlock title="No stock counts yet" name="stock-counts">{count ? 'Open a count to check physical stock against the system.' : 'Stock counts appear here once one is opened.'}</StateBlock>
      ) : (
        <div className="table-wrap ord-table"><table data-counts-table>
          <thead><tr><th>Count</th><th>Location</th><th className="num">Sizes counted</th><th>Status</th><th>Posted</th></tr></thead>
          <tbody>{counts.map(c => (
            <tr key={c.id} data-count={c.number}>
              <td className="ord-who"><NavLink href={`/stock-counts/${c.id}`} className="row-link mono-strong">{c.number}</NavLink>
                <div className="ord-no">{formatDateTime(c.created_at as Date)}{c.created_by ? <span> · {c.created_by}</span> : null}</div>{c.note && <div className="note">{c.note}</div>}</td>
              <td className="ord-extra" data-label="Location">{c.location}</td>
              <td className="num ord-extra" data-label="Sizes counted">{c.counted} / {c.lines}</td>
              <td className="ord-stage"><StatusBadge status={c.status} /></td>
              <td className="ord-extra nowrap" data-label="Posted">{c.posted_at ? formatDateTime(c.posted_at as Date) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {!count && <p className="note section-foot" data-readonly="stock-counts">Opening and posting a count needs the inventory.count permission.</p>}
    </Workspace>
  );
}
