import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listSegments } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { describeRules } from './rules';
import { db, requireActor } from '@/lib/server';
import { deleteSegmentAction, saveSegmentAction } from '../actions';
import MarketingNav from '../MarketingNav';
import { SegmentFields } from './fields';

export const metadata: Metadata = { title: 'Customer segments' };
export default async function SegmentsPage() {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const rows = await listSegments(db(), actor);
  const manage = can(actor, 'marketing.manage');
  return (
    <Workspace name="marketing-segments" title="Marketing" summary="Saved customer filters, worked out from orders and carts each time they are opened."
      actions={manage ? (
        <Drawer trigger="New segment" name="new-segment" scope="ord" title="New segment" description="A saved filter of customers. It is a list for staff, not a mailing list.">
          <ActionForm action={saveSegmentAction} submitLabel="Save segment" id="create-segment-form" label="Create segment" resetOnSuccess><SegmentFields /></ActionForm>
        </Drawer>
      ) : undefined}>
      <MarketingNav current="/marketing/segments" />
      {rows.length === 0 ? <StateBlock title="No segments yet" name="segments">{manage ? 'Create a segment to save a filter of customers.' : 'Segments appear here once they are created.'}</StateBlock> : (
        <div className="table-wrap"><table data-segments-table>
          <thead><tr><th>Segment</th><th>Rules</th><th className="num">Customers now</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(s => (
            <tr key={s.id} data-segment={s.name}>
              <td><Link className="row-link" href={`/marketing/segments/${s.id}`}><b>{s.name}</b></Link>{s.description && <div className="note">{s.description}</div>}</td>
              <td className="note">{describeRules(s.rules)}</td><td className="num">{formatNumber(s.members)}</td>
              {manage && <td><div className="actions row-actions">
                <Link className="btn ghost sm" href={`/marketing/segments/${s.id}?tab=rules`} data-link="segment-rules">Edit rules</Link>
                <ActionForm action={deleteSegmentAction} submitLabel="Delete" variant="danger" className="inline-form" id={`segment-del-${s.id}`} label="Delete segment" confirmText={`Delete the segment "${s.name}"? Customers are not affected.`}>
                  <Hidden name="segmentId" value={s.id} /></ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
