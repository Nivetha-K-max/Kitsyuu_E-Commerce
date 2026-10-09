/* Presentation helpers for the customer account pages. */
import { paiseToRupees } from '@kitsyuu/contracts';
import { catalogueSource, localImageUrl } from './catalogue-source';

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

/** What happens next, per order status (customer wording). States facts only: no notifications, refund methods or
    delivery promises until those services and policies exist. */
export const NEXT_STEP: Record<string, string> = {
  pending_payment: 'This order is waiting for payment.',
  paid: 'Your order is confirmed.',
  processing: 'Your order is being packed.',
  shipped: 'Your order is on its way.',
  delivered: 'Your order has been delivered.',
  cancelled: 'This order was cancelled.',
  payment_failed: 'The last payment attempt did not go through, so nothing was charged. You can try again.',
  refunded: 'This order has been refunded.',
};

/** Public URL of a product image stored in the product-images bucket (same URLs the catalogue uses). */
export function productImageUrl(path: string | null): string | null {
  // Local development and tests: the picture is served by this app from the repository's own files (lib/catalogue-source.ts).
  if (path && catalogueSource() === 'database') return localImageUrl(path);
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/product-images/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const formatMonthYear = (d: Date | string | null) => (d ? MONTH_YEAR.format(new Date(d)) : '—');

/** Colour tone of a status badge (presentation only): ok, wait, bad, or neutral. */
const TONES: Record<string, 'ok' | 'wait' | 'bad'> = {
  delivered: 'ok', paid: 'ok', approved: 'ok', refunded: 'ok', exchanged: 'ok', completed: 'ok', resolved: 'ok', closed: 'ok',
  pending_payment: 'wait', pending: 'wait', info_requested: 'wait', waiting_customer: 'wait',
  payment_failed: 'bad', failed: 'bad', cancelled: 'bad', rejected: 'bad',
};
export const statusTone = (status: string): 'ok' | 'wait' | 'bad' | undefined => TONES[status];

/** Up to two initials for the account avatar, from the customer's own name (or the first letter of their email). */
export function initialsOf(name: string | null, email: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? email).slice(0, 1);
  return letters.toUpperCase();
}
