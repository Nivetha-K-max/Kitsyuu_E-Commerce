'use client';
/* Order status change. Only the transitions the server allows for the current status are offered; the server checks
   them again, refuses the change if the order moved on since the page was opened, and records it in the history. */
import type { ActionState } from '@kitsyuu/contracts';
import { ActionForm, Hidden, Select, TextArea } from './forms';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
const LABEL: Record<string, string> = { processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };

export default function OrderStatusForm({ action, orderId, orderNumber, current, currentLabel, allowed }: {
  action: Action; orderId: string; orderNumber: string; current: string; currentLabel: string; allowed: string[];
}) {
  // The same form stays mounted when the order reaches a final status, so the result of the last change
  // (e.g. "Returned 2 units to stock") stays visible after the page refreshes; only the controls go away.
  const final = allowed.length === 0;
  return (
    <ActionForm action={action} submitLabel="Update status" pendingLabel="Updating…" id="order-status-form" label="Change order status" hideSubmit={final}
      confirm={data => {
        const to = String(data.get('toStatus') ?? '');
        if (!allowed.includes(to)) return null;                           // the server explains why
        return to === 'cancelled'
          ? `Cancel order ${orderNumber}? Stock it took is returned, and this cannot be undone.`
          : `Mark order ${orderNumber} as ${LABEL[to] ?? to}?`;
      }}>
      <Hidden name="orderId" value={orderId} />
      <Hidden name="expectedStatus" value={current} />
      {final ? <p className="note" data-final="status">No further status changes are possible for a {currentLabel.toLowerCase()} order.</p> : <>
        <Select name="toStatus" label="New status" options={[{ value: '', label: 'Choose…' }, ...allowed.map(s => ({ value: s, label: LABEL[s] ?? s }))]} />
        <TextArea name="note" label="Note for the order history" rows={2} hint="Required when cancelling." />
      </>}
    </ActionForm>
  );
}
