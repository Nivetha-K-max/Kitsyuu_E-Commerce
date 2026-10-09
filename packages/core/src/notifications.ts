/* Customer notifications (M7). Builds the messages; the app sends them with its Mailer after the change is committed.
   Messages state facts about the order only: no delivery dates, shipment notifications or refund promises. */
import type { Db, Queryable } from '@kitsyuu/db';
import { paiseToRupees } from '@kitsyuu/contracts';
import type { Mailer, MailMessage } from '@kitsyuu/auth';
import { pricingView } from './customer-account.ts';
import { sendTransactionalEmail } from './transactional-email.ts';

const money = (paise: number) => `₹${paiseToRupees(paise)}`;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "Order confirmed" email for a PAID order (online, or bought in a branch), or for a cash-on-delivery order when it is placed
    (second pass); null when the order is neither, is cancelled, or has no contact email (a walk-in customer may have none). */
export async function orderConfirmationEmail(q: Queryable, orderNumber: string, opts: { orderUrl: string; policy?: string }): Promise<MailMessage | null> {
  const o = await q.selectFrom('orders').select(['id', 'order_number', 'status', 'payment_status', 'subtotal_paise', 'discount_paise', 'shipping_paise',
    'tax_paise', 'total_paise', 'prices_include_tax', 'contact', 'shipping_address', 'payment_method', 'cod_status', 'cod_fee_paise', 'channel', 'location_id', 'pricing'])
    .where('order_number', '=', orderNumber).executeTakeFirst();
  if (!o || o.status === 'cancelled') return null;
  const cod = o.payment_method === 'cod' && o.cod_status === 'to_collect' && o.payment_status !== 'paid';
  if (o.payment_status !== 'paid' && !cod) return null;
  const contact = (o.contact ?? {}) as Record<string, unknown>, ship = (o.shipping_address ?? {}) as Record<string, unknown>;
  const to = text(contact.email);
  if (!to) return null;
  const items = await q.selectFrom('order_items').select(['name', 'size', 'colour', 'qty', 'line_total_paise']).where('order_id', '=', o.id).orderBy('name').execute();
  const retail = o.channel === 'retail';
  const branch = retail && o.location_id ? (await q.selectFrom('locations').select('name').where('id', '=', o.location_id).executeTakeFirst())?.name ?? null : null;
  const pv = pricingView(o.pricing);
  const METHOD: Record<string, string> = { online: 'Paid online', cod: 'Cash on Delivery', cash: 'Cash in store', card: 'Card in store', upi: 'UPI in store' };
  const STATUS: Record<string, string> = { paid: 'Paid', processing: 'Being prepared', shipped: 'Shipped', delivered: retail ? 'Handed over in the store' : 'Delivered' };
  const lines = [
    `Hello${text(contact.name) ? ' ' + text(contact.name) : ''},`, '',
    retail ? `Thank you for shopping at KITSYUU${branch ? ` ${branch}` : ''}. Your order ${o.order_number} is paid.`
      : cod ? `Thank you. Your order ${o.order_number} is confirmed. You pay ${money(o.total_paise)} in cash when it is delivered.` : `Thank you. Your order ${o.order_number} is confirmed and paid.`, '',
    'Items',
    ...items.map(i => `- ${i.name}, ${i.colour ? `${i.colour}, ` : ''}size ${i.size} × ${i.qty}: ${money(i.line_total_paise)}`), '',
    `Subtotal: ${money(o.subtotal_paise)}`,
    ...(pv.discounts.length ? pv.discounts.map(d => `${d.label}: −${money(d.amountPaise)}`) : o.discount_paise > 0 ? [`Discount: −${money(o.discount_paise)}`] : []),
    ...(o.shipping_paise > 0 || pv.delivery ? [`${pv.delivery ? `${pv.delivery.pickup ? 'Store pickup' : 'Delivery'} (${pv.delivery.label}${pv.delivery.estimate ? `, ${pv.delivery.estimate}` : ''})` : 'Shipping'}: ${o.shipping_paise > 0 ? money(o.shipping_paise) : 'free'}`] : []),
    ...(o.cod_fee_paise > 0 ? [`Cash on delivery fee: ${money(o.cod_fee_paise)}`] : []),
    o.prices_include_tax ? 'Taxes: included in the prices' : `Taxes: ${money(o.tax_paise)}`,
    ...(cod ? [`Order total: ${money(o.total_paise)}`] : [`Total paid: ${money(o.total_paise)}`]), '',
    `Payment method: ${METHOD[o.payment_method] ?? o.payment_method}`,
    // Cash on delivery is never described as paid: the email says what is due at the door.
    ...(cod ? [`Amount payable on delivery: ${money(o.total_paise)}`] : []),
    `Order status: ${STATUS[o.status] ?? (cod ? 'Being prepared' : o.status)}`, '',
    ...(retail ? [] : ['Deliver to',
      ...[text(ship.name ?? ship.full_name), text(ship.line1), text(ship.line2), [text(ship.city), text(ship.state), text(ship.pin)].filter(Boolean).join(', '),
        text(ship.country), text(ship.phone)].filter((l): l is string => !!l), '']),
    ...(opts.policy ? [opts.policy, ''] : []),
    `Your order: ${opts.orderUrl}`,
  ];
  return { to, subject: `Your KITSYUU order ${o.order_number} is confirmed`, text: lines.join('\n') };
}

export type OrderEmailResult = { sent: true } | { sent: false; reason: 'duplicate' | 'not_eligible' | 'failed' | 'error' };

/** Sends the "order confirmed" email once per order (2026-10-01): a per-order lock and the notification log ('order.placed',
    status sent) stop a second send, whoever calls it (checkout, payment callback, provider webhook, staff confirming a
    draft). Every attempt is logged (sent / failed) so staff can see it on the order. A failed send never undoes the order;
    it is sent again later (retryOrderEmails). */
export async function sendOrderPlacedEmail(db: Db, mailer: Mailer, orderNumber: string, opts: { orderUrl: string; policy?: string }): Promise<OrderEmailResult> {
  // 2026-10-08: sent by the transactional email service (lock, sent-once check, quick second try, log, later retry).
  const r = await sendTransactionalEmail(db, mailer, 'order.placed', q => orderPlacedMessage(q, orderNumber, opts));
  return r.sent ? r : { sent: false, reason: r.reason === 'no_recipient' || r.reason === 'off' ? 'not_eligible' : r.reason };
}

/** The confirmation of one order with the order it belongs to, or null when there is nothing to confirm (see orderConfirmationEmail). */
export async function orderPlacedMessage(q: Queryable, orderNumber: string, opts: { orderUrl: string; policy?: string }): Promise<(MailMessage & { orderId: string }) | null> {
  const o = await q.selectFrom('orders').select(['id', 'customer_id']).where('order_number', '=', orderNumber).executeTakeFirst();
  if (!o) return null;
  // A walk-in order has no account: no link to an account page.
  const m = await orderConfirmationEmail(q, orderNumber, { ...opts, orderUrl: o.customer_id ? opts.orderUrl : '' });
  if (!m) return null;
  if (!o.customer_id || !opts.orderUrl) m.text = m.text.replace(/\n+Your order: $/, '');
  return { ...m, orderId: o.id };
}

/** The customer emails of one order (for staff on the order page): what was sent, when, and whether it failed. */
export async function orderEmails(q: Queryable, orderId: string) {
  return q.selectFrom('notification_log').select(['event', 'recipient', 'subject', 'status', 'error', 'created_at']).where('order_id', '=', orderId).orderBy('created_at').execute();
}
