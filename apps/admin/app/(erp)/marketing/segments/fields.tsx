/* The fields of a segment, shared by "New segment" (the list) and the Rules tab of the segment's page. */
import type { listSegments } from '@kitsyuu/core';
import { Checkbox, Field, Hidden, TextArea } from '@/components/forms';
import { rupeesField } from '@/lib/erp';

export type Segment = Awaited<ReturnType<typeof listSegments>>[number];

export function SegmentFields({ s }: { s?: Segment }) {
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
      <Checkbox name="hasAbandonedCart" label="Has an abandoned cart" defaultChecked={r?.hasAbandonedCart} hint="Uses Configuration → Carts → Abandoned cart after." />
    </>
  );
}
