import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getStockCount } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cancelStockCountAction, postStockCountAction, recordCountsAction } from '../actions';

export const metadata: Metadata = { title: 'Stock count' };
type Params = Promise<{ id: string }>;

export default async function StockCountPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/stock-counts', label: 'Stock counts' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Stock count" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { count: c, lines } = await getStockCount(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const edit = can(actor, 'inventory.count') && c.status === 'open';
  const counted = lines.filter(l => l.counted_qty !== null), differ = counted.filter(l => l.difference !== 0);
  return (
    <>
      <PageHead section="Catalogue" title={c.number} crumbs={crumbs} eyebrow={`${c.location} · Opened ${formatDateTime(c.created_at as Date)} · ${counted.length} of ${lines.length} sizes counted · ${differ.length} different`}>
        <StatusBadge status={c.status} />
      </PageHead>
      <section className="card" aria-labelledby="cl-h" data-section="count-lines">
        <SectionTitle id="cl-h">Counted quantities</SectionTitle>
        {edit && <p className="note">Enter what is physically there. Leave a size empty if it was not counted; it will not be changed.</p>}
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
      </section>
      {edit && (
        <div className="actions">
          <ActionForm action={postStockCountAction} submitLabel="Post differences to stock" id="post-count-form" label="Post the count" className="inline-form"
            confirmText="Post this count? Every difference is written to stock and the count is closed.">
            <Hidden name="stockCountId" value={c.id} />
          </ActionForm>
          <ActionForm action={cancelStockCountAction} submitLabel="Cancel count" variant="danger" id="cancel-count-form" label="Cancel the count" className="inline-form"
            confirmText="Cancel this count? Nothing is changed in stock.">
            <Hidden name="stockCountId" value={c.id} />
          </ActionForm>
        </div>
      )}
    </>
  );
}
