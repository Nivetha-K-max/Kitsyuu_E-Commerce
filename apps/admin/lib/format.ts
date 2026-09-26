/* Display formatting (India locale, business time zone). */
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');

export const formatDateTime = (d: Date | string | null | undefined) => (d ? dt.format(new Date(d)) : '—');
export const formatPaise = (paise: number) => inr.format(paise / 100);
export const formatNumber = (n: number) => num.format(n);
export const STATUS_LABEL: Record<string, string> = {
  active: 'Active', invited: 'Invited', disabled: 'Disabled',
  pending_payment: 'Awaiting payment', paid: 'Paid', processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered',
  cancelled: 'Cancelled', payment_failed: 'Payment failed', refunded: 'Refunded',
  unpaid: 'Unpaid', pending: 'Pending', authorized: 'Authorised', failed: 'Failed', partially_refunded: 'Partly refunded',
  captured: 'Captured', created: 'Created', requested: 'Requested', processed: 'Processed', issued: 'Issued', void: 'Void', draft: 'Draft',
};
