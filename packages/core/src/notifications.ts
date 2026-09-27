/* Customer notifications (M7). Builds the messages; the app sends them with its Mailer after the change is committed.
   Messages state facts about the order only: no delivery dates, shipment notifications or refund promises. */
import type { Queryable } from '@kitsyuu/db';
import { paiseToRupees } from '@kitsyuu/contracts';
import type { MailMessage } from '@kitsyuu/auth';

const money = (paise: number) => `₹${paiseToRupees(paise)}`;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "Order confirmed" email for a PAID order, or null when the order is not paid or has no contact email. */
export async function orderConfirmationEmail(q: Queryable, orderNumber: string, opts: { orderUrl: string; policy?: string }): Promise<MailMessage | null> {
  const o = await q.selectFrom('orders').select(['id', 'order_number', 'status', 'payment_status', 'subtotal_paise', 'discount_paise', 'shipping_paise',
    'tax_paise', 'total_paise', 'prices_include_tax', 'contact', 'shipping_address'])
    .where('order_number', '=', orderNumber).executeTakeFirst();
  if (!o || o.payment_status !== 'paid' || o.status === 'cancelled') return null;
  const contact = (o.contact ?? {}) as Record<string, unknown>, ship = (o.shipping_address ?? {}) as Record<string, unknown>;
  const to = text(contact.email);
  if (!to) return null;
  const items = await q.selectFrom('order_items').select(['name', 'size', 'qty', 'line_total_paise']).where('order_id', '=', o.id).orderBy('name').execute();
  const lines = [
    `Hello${text(contact.name) ? ' ' + text(contact.name) : ''},`, '',
    `Thank you. Your order ${o.order_number} is confirmed and paid.`, '',
    'Items',
    ...items.map(i => `- ${i.name}, size ${i.size} × ${i.qty}: ${money(i.line_total_paise)}`), '',
    `Subtotal: ${money(o.subtotal_paise)}`,
    ...(o.discount_paise > 0 ? [`Discount: −${money(o.discount_paise)}`] : []),
    ...(o.shipping_paise > 0 ? [`Shipping: ${money(o.shipping_paise)}`] : []),
    o.prices_include_tax ? 'Taxes: included in the prices' : `Taxes: ${money(o.tax_paise)}`,
    `Total paid: ${money(o.total_paise)}`, '',
    'Deliver to',
    ...[text(ship.name ?? ship.full_name), text(ship.line1), text(ship.line2), [text(ship.city), text(ship.state), text(ship.pin)].filter(Boolean).join(', '),
      text(ship.country), text(ship.phone)].filter((l): l is string => !!l), '',
    ...(opts.policy ? [opts.policy, ''] : []),
    `Your order: ${opts.orderUrl}`,
  ];
  return { to, subject: `Your KITSYUU order ${o.order_number} is confirmed`, text: lines.join('\n') };
}
