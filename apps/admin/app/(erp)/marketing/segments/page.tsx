import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listSegments } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { describeRules } from './rules';
import { rupeesField } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { deleteSegmentAction, saveSegmentAction } from '../actions';
import MarketingNav from '../MarketingNav';

export const metadata: Metadata = { title: 'Customer segments' };
type Segment = Awaited<ReturnType<typeof listSegments>>[number];

function SegmentFields({ s }: { s?: Segment }) {
  const r = s?.rules;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  return (
    <>
      {s && <Hidden name="segmentId" value={s.id} />}
      <Field name="name" label="Name" defaultValue={s?.name} required hint="e.g. New customers, Returning, High value, Lapsed." />
      <TextArea name="description" label="Description" defaultValue={s?.description ?? ''} rows={2} />
      <p className="note">Customers matching ALL the rules you fill in. Thresholds are yours to choose; nothing is pre-set.</p>
      <div className="cols">
        <Field name="joinedWithinDays" label="Joined within (days)" defaultValue={n(r?.joinedWithinDays)} />
        <Field name="minOrders" label="Paid orders at least" defaultValue={n(r?.minOrders)} />
        <Field name="maxOrders" label="Paid orders at most" defaultValue={n(r?.maxOrders)} />
        <Field name="minSpend" label="Total spend at least (₹)" defaultValue={rupeesField(r?.minSpendPaise)} />
        <Field name="lastOrderWithinDays" label="Last order within (days)" defaultValue={n(r?.lastOrderWithinDays)} />
        <Field name="lastOrderOlderThanDays" label="No order for (days)" defaultValue={n(r?.lastOrderOlderThanDays)} />
      </div>
      <Checkbox name="hasAbandonedCart" label="Has an abandoned cart" defaultChecked={r?.hasAbandonedCart} hint="Uses Settings → Carts → Abandoned cart after." />
    </>
  );
}

export default async function SegmentsPage() {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const rows = await listSegments(db(), actor);
  const manage = can(actor, 'marketing.manage');
  return (
    <>
      <PageHead title="Marketing" eyebrow="Saved customer filters, worked out from orders and carts each time they are opened." />
      <MarketingNav current="/marketing/segments" />
      {rows.length === 0 ? <Empty title="No segments yet" kind="segments" /> : (
        <div className="table-wrap"><table data-segments-table>
          <thead><tr><th>Segment</th><th>Rules</th><th className="num">Customers now</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(s => (
            <tr key={s.id} data-segment={s.name}>
              <td><Link className="row-link" href={`/marketing/segments/${s.id}`}><b>{s.name}</b></Link>{s.description && <div className="note">{s.description}</div>}</td>
              <td className="note">{describeRules(s.rules)}</td><td className="num">{formatNumber(s.members)}</td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveSegmentAction} submitLabel="Save" className="form compact row-edit-form" id={`segment-${s.id}`} label="Edit segment"><SegmentFields s={s} /></ActionForm></details>
                <ActionForm action={deleteSegmentAction} submitLabel="Delete" variant="danger" className="inline-form" id={`segment-del-${s.id}`} label="Delete segment" confirmText={`Delete the segment "${s.name}"? Customers are not affected.`}>
                  <Hidden name="segmentId" value={s.id} /></ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {manage && <section className="card form-panel" aria-labelledby="ns-h"><h2 id="ns-h">New segment</h2>
        <ActionForm action={saveSegmentAction} submitLabel="Save segment" id="create-segment-form" label="Create segment" resetOnSuccess><SegmentFields /></ActionForm></section>}
    </>
  );
}
