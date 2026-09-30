/* Client change request, second pass: cash on delivery (COD).

   COD is a payment method of its own (orders.payment_method = 'cod'), not a checkbox. What the business decides is
   configuration, and nothing is invented here:
   - payments.cod_enabled   on/off (off until the business switches it on)
   - where COD is possible  each delivery rate says whether COD is allowed (Shipping → Zones and rates), so COD follows
                            the delivery zones; with no zone rates set up COD is not offered anywhere
   - the COD fee            each delivery rate's COD fee (none when empty)
   - payments.cod_discount  an amount off for paying on delivery (none when empty)
   - payments.cod_min_order / payments.cod_max_order   the order value range for COD (goods after discounts; none when empty)
   Whether COD has a fee, a discount, both or neither is the business's choice; both start empty.

   Flow: the customer chooses COD at checkout → the order is placed and goes straight to fulfilment ('processing'),
   stock is taken as for any order, payment status 'unpaid', COD status 'to_collect' → staff ship and deliver it as usual →
   staff record the cash collected (the payment is recorded as a 'cod' payment, the order becomes paid), or that the
   customer refused the parcel (the order is cancelled; the pieces can be put back in stock). Staff can also cancel a COD
   order before it is dispatched. Every step is audited. */
import { recordAudit, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import type { ShippingQuote } from './pricing.ts';
import { applyOrderTransition, lockOrder, releaseOrderStock } from './order-state.ts';
import { earnForOrder, reverseOrderPoints } from './loyalty.ts';

export interface CodSettings { enabled: boolean; discountPaise: number | null; minOrderPaise: number | null; maxOrderPaise: number | null }
export const COD_KEYS = ['payments.cod_enabled', 'payments.cod_discount', 'payments.cod_min_order', 'payments.cod_max_order'] as const;

export async function readCodSettings(q: Queryable): Promise<CodSettings> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', [...COD_KEYS]).execute();
  const v = new Map(rows.map(r => [r.key, r.value]));
  const money = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : null);
  return { enabled: v.get('payments.cod_enabled') === 'on', discountPaise: money(v.get('payments.cod_discount')),
    minOrderPaise: money(v.get('payments.cod_min_order')), maxOrderPaise: money(v.get('payments.cod_max_order')) };
}

export interface CodQuote {
  /** COD is switched on (the checkout shows the choice). */
  offered: boolean;
  /** COD can be used for this order and address. */
  available: boolean;
  /** Why not (shown next to the choice), or null. */
  reason: string | null;
  feePaise: number; discountPaise: number;
}

/** Whether COD can be used for an order: the switch, the chosen delivery rate, and the order value range. Pure. */
export function codQuoteFrom(s: CodSettings, rate: { codAllowed: boolean; codFeePaise: number | null } | null, shipping: ShippingQuote, goodsPaise: number): CodQuote {
  const no = (reason: string | null): CodQuote => ({ offered: s.enabled, available: false, reason, feePaise: 0, discountPaise: 0 });
  if (!s.enabled) return no(null);
  if (shipping.unavailable) return no(null);
  if (!rate || !rate.codAllowed) return no('Cash on delivery is not available for this address or delivery option.');
  const r = (p: number) => `₹${(p / 100).toFixed(2)}`;
  if (s.minOrderPaise !== null && goodsPaise < s.minOrderPaise) return no(`Cash on delivery is available for orders of ${r(s.minOrderPaise)} or more.`);
  if (s.maxOrderPaise !== null && goodsPaise > s.maxOrderPaise) return no(`Cash on delivery is available for orders up to ${r(s.maxOrderPaise)}.`);
  return { offered: true, available: true, reason: null, feePaise: rate.codFeePaise ?? 0, discountPaise: Math.min(s.discountPaise ?? 0, Math.max(0, goodsPaise)) };
}

export async function codQuote(q: Queryable, shipping: ShippingQuote, goodsPaise: number): Promise<CodQuote> {
  const s = await readCodSettings(q);
  if (!s.enabled) return codQuoteFrom(s, null, shipping, goodsPaise);
  const rate = shipping.rateId ? await q.selectFrom('shipping_rates').select(['cod_allowed', 'cod_fee_paise']).where('id', '=', shipping.rateId).where('is_active', '=', true).executeTakeFirst() : undefined;
  return codQuoteFrom(s, rate ? { codAllowed: rate.cod_allowed, codFeePaise: rate.cod_fee_paise } : null, shipping, goodsPaise);
}

// ---------------------------------------------------------------- staff actions

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

async function lockCodOrder(tx: Parameters<typeof lockOrder>[0], orderId: string) {
  const o = await lockOrder(tx, { id: orderId });
  if (!o) throw new NotFoundError('Order not found.');
  const extra = await tx.selectFrom('orders').select(['payment_method', 'cod_status']).where('id', '=', orderId).executeTakeFirstOrThrow();
  if (extra.payment_method !== 'cod') throw new ConflictError('This order is not a cash-on-delivery order.');
  return { ...o, ...extra };
}

/** Staff record the cash collected on delivery. The amount must be the order total. The order becomes paid. */
export async function recordCodCollected(db: Db, actor: StaffPrincipal, input: { orderId: string; amountPaise: number; reference: string | null; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'orders.cod');
  return db.transaction().execute(async tx => {
    const o = await lockCodOrder(tx, input.orderId);
    if (o.cod_status !== 'to_collect') throw new ConflictError(`The cash for this order is already recorded as ${o.cod_status}.`);
    if (o.status !== 'shipped' && o.status !== 'delivered') throw new ConflictError('Record the cash once the order has been shipped or delivered.');
    if (input.amountPaise !== o.total_paise) throw new DomainError('invalid', `The amount must be the order total, ₹${(o.total_paise / 100).toFixed(2)}.`);
    const pay = await tx.insertInto('payments').values({ order_id: o.id, provider: 'cod', provider_payment_id: `cod-${o.order_number}`, amount_paise: o.total_paise,
      currency: o.currency, status: 'captured', method: 'cash', captured_at: new Date(),
      raw: JSON.stringify({ recorded_by: actor.staffId, reference: input.reference, note: input.note }) }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('orders').set({ cod_status: 'collected', payment_status: 'paid', paid_at: new Date() }).where('id', '=', o.id).execute();
    const earned = await earnForOrder(tx, o.id, 'paid');
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.cod_collected', entityType: 'orders', entityId: o.id,
      before: { cod_status: 'to_collect', payment_status: o.payment_status }, after: { cod_status: 'collected', payment_status: 'paid', amount_paise: o.total_paise },
      metadata: { order_number: o.order_number, payment_id: pay.id, reference: input.reference, note: input.note, points_earned: earned }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number };
  });
}

/** Cancels a COD order: before dispatch (staff cancel) or after (the customer refused the parcel). Stock comes back
    (for a refused parcel only when staff say the pieces are back and fit to sell); points used are given back. */
export async function cancelCodOrder(db: Db, actor: StaffPrincipal, input: { orderId: string; kind: 'cancel' | 'refused'; note: string; restock: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'orders.cod');
  if (!input.note.trim()) throw new DomainError('invalid', 'Give a reason; it is kept in the order history.');
  return db.transaction().execute(async tx => {
    const o = await lockCodOrder(tx, input.orderId);
    if (o.cod_status !== 'to_collect') throw new ConflictError(`The cash for this order is already recorded as ${o.cod_status}.`);
    if (input.kind === 'cancel' && o.status !== 'processing') throw new ConflictError('Only a COD order that has not been dispatched can be cancelled here.');
    if (input.kind === 'refused' && o.status !== 'shipped') throw new ConflictError('A refused parcel can be recorded once the order has been shipped.');
    const note = input.kind === 'refused' ? `Refused on delivery: ${input.note.trim()}` : input.note.trim();
    const t = await applyOrderTransition(tx, o, 'cancelled', { actor: 'staff', cod: true, note, set: { payment_status: 'unpaid' } });
    await tx.updateTable('orders').set({ cod_status: input.kind === 'refused' ? 'refused' : 'to_collect' }).where('id', '=', o.id).execute();
    const units = input.kind === 'cancel' || input.restock ? await releaseOrderStock(tx, o.id, `Order ${o.order_number}: ${note}`) : 0;
    const points = await reverseOrderPoints(tx, o.id, `Order ${o.order_number} cancelled`);
    if (input.kind === 'refused') await tx.updateTable('shipments').set({ status: 'failed_delivery', failed_at: new Date(), failure_reason: note.slice(0, 300) }).where('order_id', '=', o.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: input.kind === 'refused' ? 'order.cod_refused' : 'order.cod_cancelled', entityType: 'orders', entityId: o.id,
      before: { status: t.from }, after: { status: 'cancelled', cod_status: input.kind === 'refused' ? 'refused' : 'to_collect' },
      metadata: { order_number: o.order_number, note, units_returned: units, restock: input.kind === 'cancel' || input.restock, points }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number, unitsReturned: units };
  });
}

/** COD facts for an order page (admin and account). */
export async function orderCodState(q: Queryable, orderId: string) {
  const o = await q.selectFrom('orders').select(['payment_method', 'cod_status', 'cod_fee_paise', 'total_paise', 'status']).where('id', '=', orderId).executeTakeFirst();
  if (!o || o.payment_method !== 'cod') return null;
  const pay = await q.selectFrom('payments').select(['created_at', 'raw']).where('order_id', '=', orderId).where('provider', '=', 'cod').executeTakeFirst();
  return { status: o.cod_status!, feePaise: o.cod_fee_paise, toCollectPaise: o.cod_status === 'to_collect' && o.status !== 'cancelled' ? o.total_paise : 0,
    collectedAt: (pay?.created_at as Date | undefined) ?? null, reference: ((pay?.raw ?? {}) as { reference?: string | null }).reference ?? null };
}
