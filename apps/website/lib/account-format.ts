/* Presentation helpers for the customer account pages. */
import { paiseToRupees } from '@kitsyuu/contracts';

export const rupees = (paise: number) => `₹${paiseToRupees(paise)}`;

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
const DATE_TIME = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const formatDate = (d: Date | string | null) => (d ? DATE.format(new Date(d)) : '—');
export const formatDateTime = (d: Date | string | null) => (d ? DATE_TIME.format(new Date(d)) : '—');

/** Customer-facing wording for order and payment states (never internal codes). */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment', paid: 'Confirmed', processing: 'Being packed', shipped: 'Shipped',
  delivered: 'Delivered', cancelled: 'Cancelled', payment_failed: 'Payment failed', refunded: 'Refunded',
};
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: 'Not paid', pending: 'Pending', authorized: 'Authorised', paid: 'Paid', failed: 'Failed',
  refunded: 'Refunded', partially_refunded: 'Partly refunded',
};

/** What happens next, per order status (customer wording). */
export const NEXT_STEP: Record<string, string> = {
  pending_payment: 'This order is waiting for payment.',
  paid: 'Your order is confirmed. We will let you know when it ships.',
  processing: 'Your order is being packed.',
  shipped: 'Your order is on its way.',
  delivered: 'Your order has been delivered.',
  cancelled: 'This order was cancelled. Any payment taken is refunded to the original payment method.',
  payment_failed: 'The last payment attempt did not go through, so nothing was charged. You can try again.',
  refunded: 'This order has been refunded to the original payment method.',
};

/** Public URL of a product image stored in the product-images bucket (same URLs the catalogue uses). */
export function productImageUrl(path: string | null): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/product-images/${path.split('/').map(encodeURIComponent).join('/')}`;
}
