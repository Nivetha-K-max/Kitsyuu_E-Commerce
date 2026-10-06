/* How a payment reads, everywhere in the admin: the Orders list, the order page and the Payments area all use this one
   rule. Display only: it reads the order's payment status and, for cash on delivery, its COD status exactly as recorded.
   The payment answers "what happened to the customer's money?"; the order stage (orders/order-ui.tsx) is separate. */
import { STATUS_LABEL } from '@/lib/format';

export interface PaymentFacts { method: string | null; paymentStatus: string | null; codStatus: string | null; orderStatus: string }
export interface PaymentState {
  /** Stable code for tests and filters. */ code: string;
  /** Existing badge colour class. */ cls: string;
  label: string;
  /** One short line of context under the badge. */ note: string | null;
}

export const METHOD_LABEL: Record<string, string> = { online: 'Online', cod: 'COD', cash: 'Cash', card: 'Card', upi: 'UPI' };
/** Method as a sentence part: "cash on delivery", "card in store". */
export const METHOD_LONG: Record<string, string> = { online: 'Online payment', cod: 'Cash on delivery', cash: 'Cash in store', card: 'Card in store', upi: 'UPI in store' };
export const PROVIDER_LABEL: Record<string, string> = { razorpay: 'Razorpay', test: 'Test provider', cod: 'Cash on delivery', pos: 'POS counter' };
export const methodLabel = (m: string | null) => METHOD_LABEL[m ?? 'online'] ?? m ?? 'Online';
export const providerLabel = (p: string | null) => (p ? PROVIDER_LABEL[p] ?? p : '—');

export function paymentState({ method, paymentStatus, codStatus, orderStatus }: PaymentFacts): PaymentState {
  const refunded = paymentStatus === 'refunded' || paymentStatus === 'partially_refunded';
  if (method === 'cod' && !refunded) {
    if (codStatus === 'collected') return { code: 'cod_collected', cls: 'paid', label: 'COD · Cash collected', note: 'paid in cash on delivery' };
    if (codStatus === 'refused') return { code: 'cod_refused', cls: 'cancelled', label: 'COD · Not collected', note: 'parcel refused by the customer' };
    if (orderStatus === 'cancelled') return { code: 'cod_none', cls: 'draft', label: 'COD · Nothing to collect', note: 'order cancelled' };
    return { code: 'cod_to_collect', cls: 'pending', label: 'COD · To collect', note: 'cash due on delivery' };
  }
  const store = method === 'cash' || method === 'card' || method === 'upi';
  switch (paymentStatus) {
    case 'paid': return { code: 'paid', cls: 'paid', label: 'Paid', note: store ? METHOD_LONG[method!].toLowerCase() : null };
    case 'pending': return { code: 'pending', cls: 'pending', label: 'Payment pending', note: 'waiting for the customer' };
    case 'authorized': return { code: 'pending', cls: 'authorized', label: 'Authorised', note: 'not captured yet' };
    case 'failed': return { code: 'failed', cls: 'failed', label: 'Payment failed', note: orderStatus === 'payment_failed' ? 'the customer can try again' : null };
    case 'refunded': return { code: 'refunded', cls: 'refunded', label: 'Refunded', note: method === 'cod' ? 'cash on delivery' : null };
    case 'partially_refunded': return { code: 'refunded', cls: 'partially_refunded', label: 'Partly refunded', note: method === 'cod' ? 'cash on delivery' : null };
    case 'unpaid': return { code: 'unpaid', cls: 'draft', label: 'Unpaid', note: orderStatus === 'cancelled' ? 'order cancelled' : null };
    default: return paymentStatus ? { code: paymentStatus, cls: paymentStatus, label: STATUS_LABEL[paymentStatus] ?? paymentStatus, note: null }
      : { code: 'none', cls: 'draft', label: 'No payment', note: null };
  }
}

/** The compact payment badge (with its one-line note unless note={false}). */
export function PaymentPill({ note = true, ...facts }: PaymentFacts & { note?: boolean }) {
  const s = paymentState(facts);
  return <><span className={`badge ${s.cls} pay-badge`} data-payment-state={s.code}>{s.label}</span>{note && s.note && <div className="note">{s.note}</div>}</>;
}
