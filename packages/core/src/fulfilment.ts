/* Fulfilment (M8). The order status is the one status: processing → shipped → delivered move only through the order
   workflow (updateOrderStatus → applyOrderTransition). A shipment row carries the delivery details of that order:
   packing state (operational metadata while processing), carrier, optional tracking number, and when it was shipped and
   delivered. Shipment times are written in the same transaction as the status change, so they can never disagree. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, type PackingStateInput, type ShipmentTrackingInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { lockOrder } from './order-state.ts';
import { resolveCarrier } from './fulfilment/carrier.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export interface ShipmentView {
  carrierCode: string; carrierLabel: string; trackingNumber: string | null; trackingUrl: string | null;
  packingState: 'not_started' | 'packing' | 'packed'; status: string; shippedAt: Date | null; deliveredAt: Date | null; updatedAt: Date;
}

export async function getShipment(q: Queryable, orderId: string): Promise<ShipmentView | null> {
  const s = await q.selectFrom('shipments').select(['carrier_code', 'tracking_number', 'tracking_url', 'status', 'packing_state', 'shipped_at', 'delivered_at', 'updated_at'])
    .where('order_id', '=', orderId).executeTakeFirst();
  if (!s) return null;
  const carrier = await resolveCarrier(q, s.carrier_code, { includeInactive: true });
  return { carrierCode: s.carrier_code, carrierLabel: carrier?.label ?? s.carrier_code, trackingNumber: s.tracking_number,
    trackingUrl: s.tracking_url ?? (s.tracking_number && carrier ? carrier.trackingUrl(s.tracking_number) : null), packingState: s.packing_state, status: s.status,
    shippedAt: s.shipped_at as Date | null, deliveredAt: s.delivered_at as Date | null, updatedAt: s.updated_at as Date };
}

async function requireCarrier(q: Queryable, code: string) {
  const carrier = await resolveCarrier(q, code);
  if (!carrier) throw new DomainError('invalid', 'Choose one of the listed couriers.');
  return carrier;
}

/** When the order became shipped, for orders shipped before shipments were recorded (from the status history). */
const shippedAtFromHistory = (orderId: string) =>
  sql<Date>`coalesce((select max(h.created_at) from public.order_status_history h where h.order_id = ${orderId} and h.to_status = 'shipped'), now())`;

/** Called by updateOrderStatus in the SAME transaction, right after the order entered `to`. */
export async function recordShipmentForTransition(tx: Tx, orderId: string, to: string,
  input: { carrierCode: string; trackingNumber: string | null }, staffId: string): Promise<Record<string, unknown> | null> {
  if (to === 'shipped') {
    const carrier = await requireCarrier(tx, input.carrierCode);
    const trackingUrl = input.trackingNumber ? carrier.trackingUrl(input.trackingNumber) : null;
    const s = await tx.insertInto('shipments').values({ order_id: orderId, carrier_code: carrier.code, tracking_number: input.trackingNumber, tracking_url: trackingUrl,
      status: 'shipped', packing_state: 'packed', shipped_at: sql<Date>`now()`, created_by: staffId, updated_by: staffId })
      .onConflict(oc => oc.column('order_id').doUpdateSet({
        carrier_code: carrier.code, tracking_number: sql<string | null>`coalesce(excluded.tracking_number, shipments.tracking_number)`,
        tracking_url: sql<string | null>`coalesce(excluded.tracking_url, shipments.tracking_url)`, status: 'shipped',
        packing_state: 'packed', shipped_at: sql<Date>`now()`, updated_by: staffId,
      })).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('shipment_events').values({ shipment_id: s.id, status: 'shipped', note: input.trackingNumber ? `Tracking ${input.trackingNumber}` : null, source: 'staff', staff_user_id: staffId }).execute();
    return { carrier: carrier.code, tracking_number: input.trackingNumber };
  }
  if (to === 'delivered') {
    const s = await tx.insertInto('shipments').values({ order_id: orderId, packing_state: 'packed', status: 'delivered', shipped_at: shippedAtFromHistory(orderId),
      delivered_at: sql<Date>`now()`, created_by: staffId, updated_by: staffId })
      .onConflict(oc => oc.column('order_id').doUpdateSet({
        shipped_at: sql<Date>`coalesce(shipments.shipped_at, excluded.shipped_at)`, delivered_at: sql<Date>`now()`, status: 'delivered', updated_by: staffId,
      })).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('shipment_events').values({ shipment_id: s.id, status: 'delivered', source: 'staff', staff_user_id: staffId }).execute();
    return { delivered: true };
  }
  return null;
}

/** Packing progress of an order that is being processed (operational metadata; the order status does not change). */
export async function setPackingState(db: Db, actor: StaffPrincipal, input: PackingStateInput, ctx: MutationContext) {
  requirePermission(actor, 'orders.update_status');
  return db.transaction().execute(async tx => {
    const o = await lockOrder(tx, { id: input.orderId });
    if (!o) throw new NotFoundError('Order not found.');
    if (o.status !== 'processing') throw new ConflictError('Packing can be recorded while an order is being processed.');
    const before = await tx.selectFrom('shipments').select('packing_state').where('order_id', '=', o.id).executeTakeFirst();
    const status = input.packingState === 'packed' ? 'packed' as const : input.packingState === 'packing' ? 'processing' as const : 'pending' as const;
    const s = await tx.insertInto('shipments').values({ order_id: o.id, packing_state: input.packingState, status, created_by: actor.staffId, updated_by: actor.staffId })
      .onConflict(oc => oc.column('order_id').doUpdateSet({ packing_state: input.packingState, status, updated_by: actor.staffId })).returning('id').executeTakeFirstOrThrow();
    if ((before?.packing_state ?? 'not_started') !== input.packingState)
      await tx.insertInto('shipment_events').values({ shipment_id: s.id, status, source: 'staff', staff_user_id: actor.staffId }).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'fulfilment.packing_update', entityType: 'orders', entityId: o.id,
      before: { packing_state: before?.packing_state ?? 'not_started' }, after: { packing_state: input.packingState },
      metadata: { order_number: o.order_number }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number, packingState: input.packingState };
  });
}

/** Adds or corrects the courier / tracking number of an order that has been shipped (tracking is optional). */
export async function updateShipmentTracking(db: Db, actor: StaffPrincipal, input: ShipmentTrackingInput, ctx: MutationContext) {
  requirePermission(actor, 'orders.update_status');
  const carrier = await requireCarrier(db, input.carrierCode);
  const trackingUrl = input.trackingNumber ? carrier.trackingUrl(input.trackingNumber) : null;
  return db.transaction().execute(async tx => {
    const o = await lockOrder(tx, { id: input.orderId });
    if (!o) throw new NotFoundError('Order not found.');
    if (o.status !== 'shipped' && o.status !== 'delivered') throw new ConflictError('Tracking can be recorded once the order has been shipped.');
    const before = await tx.selectFrom('shipments').select(['carrier_code', 'tracking_number']).where('order_id', '=', o.id).executeTakeFirst();
    await tx.insertInto('shipments').values({ order_id: o.id, carrier_code: carrier.code, tracking_number: input.trackingNumber, tracking_url: trackingUrl, packing_state: 'packed',
      status: o.status === 'delivered' ? 'delivered' : 'shipped', shipped_at: shippedAtFromHistory(o.id), created_by: actor.staffId, updated_by: actor.staffId })
      .onConflict(oc => oc.column('order_id').doUpdateSet({ carrier_code: carrier.code, tracking_number: input.trackingNumber, tracking_url: trackingUrl, updated_by: actor.staffId })).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'fulfilment.tracking_update', entityType: 'orders', entityId: o.id,
      before: before ? { carrier: before.carrier_code, tracking_number: before.tracking_number } : null,
      after: { carrier: carrier.code, tracking_number: input.trackingNumber }, metadata: { order_number: o.order_number }, ...auditCtx(ctx) });
    return { orderNumber: o.order_number };
  });
}
