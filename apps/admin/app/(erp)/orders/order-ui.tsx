/* Shared presentation of the ORDER side: where an order is in KITSYUU's own flow ("what is happening with this
   purchase?"). Display only: every state comes from the order status and the shipment's packing state as recorded;
   nothing here changes an order or invents a state. How the payment reads is payments/payment-ui.tsx. */
import { STATUS_LABEL } from '@/lib/format';

/** The fulfilment flow staff follow. "Being packed" and "Packed" are the processing status with the packing state. */
export const ORDER_FLOW = ['Placed', 'Confirmed', 'Being packed', 'Packed', 'Shipped', 'Delivered'] as const;

/** Position in ORDER_FLOW (0–5) for a status, or -1 when the order is not in the flow (cancelled, refunded). */
export function flowIndex(status: string, packingState?: string | null): number {
  switch (status) {
    case 'pending_payment': case 'payment_failed': return 0;
    case 'paid': return 1;
    case 'processing': return packingState === 'packed' ? 3 : 2;
    case 'shipped': return 4;
    case 'delivered': return 5;
    default: return -1;
  }
}

/** Stage pill content: `code` picks the badge colour (existing badge classes), `label` is the flow wording. */
export function orderStage(status: string, packingState?: string | null): { code: string; label: string; note?: string } {
  switch (status) {
    case 'pending_payment': return { code: 'pending_payment', label: 'Placed', note: 'awaiting payment' };
    case 'payment_failed': return { code: 'payment_failed', label: 'Placed', note: 'payment failed' };
    case 'paid': return { code: 'paid', label: 'Confirmed' };
    case 'processing': return packingState === 'packed' ? { code: 'packed', label: 'Packed' } : { code: 'processing', label: 'Being packed' };
    case 'shipped': return { code: 'shipped', label: 'Shipped' };
    case 'delivered': return { code: 'delivered', label: 'Delivered' };
    case 'cancelled': return { code: 'cancelled', label: 'Cancelled' };
    default: return { code: status, label: STATUS_LABEL[status] ?? status };
  }
}

/** The stage pill. */
export function StagePill({ status, packingState }: { status: string; packingState?: string | null }) {
  const st = orderStage(status, packingState);
  return <span className={`badge ${st.code}`} data-order-stage={st.code}>{st.label}</span>;
}
