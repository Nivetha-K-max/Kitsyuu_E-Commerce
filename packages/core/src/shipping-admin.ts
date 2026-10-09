/* ERP module 2: shipping for staff — delivery zones and rates (used at checkout when Configuration → Delivery charge is "By
   delivery zone"), couriers, and the delivery status of shipments.
   One status for the order: shipped and delivered still move only through the order workflow (orders.ts), which also
   writes the shipment. What this module adds after dispatch: in transit, failed delivery (with the reason) and a new
   attempt, each recorded in shipment_events. Marking a shipment delivered here moves the order to delivered through the
   same workflow, in the same transaction. No courier API is called: tracking numbers are typed in by staff; an API
   courier plugs in through the CarrierProvider interface with keys from the environment. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type Mailer, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { applyOrderTransition, lockOrder } from './order-state.ts';
import { recordShipmentForTransition } from './fulfilment.ts';
import { resolveCarrier } from './fulfilment/carrier.ts';
import { activeZoneRates, quoteFromZoneRates, readShippingSettings } from './shipping.ts';
import { raiseAlertSafely } from './alerts.ts';
import { hello, sendCustomerEmail, storeLink } from './customer-email.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
export const SHIPMENT_PAGE_SIZE = 40;

// ---------------------------------------------------------------- zones and rates
export async function listShippingZones(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'shipping.read');
  const [zones, rates, settings] = await Promise.all([
    db.selectFrom('shipping_zones').selectAll().orderBy('sort_order').orderBy('name').execute(),
    db.selectFrom('shipping_rates').selectAll().orderBy('sort_order').orderBy('amount_paise').execute(),
    readShippingSettings(db),
  ]);
  return { method: settings.method, zones: zones.map(z => ({ ...z, rates: rates.filter(r => r.zone_id === z.id) })) };
}

export async function saveShippingZone(db: Db, actor: StaffPrincipal, input: { zoneId?: string; name: string; states: string[]; pinPrefixes: string[]; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'shipping.manage');
  const row = { name: input.name, states: input.states, pin_prefixes: input.pinPrefixes, is_active: input.active };
  return db.transaction().execute(async tx => {
    const clash = await tx.selectFrom('shipping_zones').select('id').where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.zoneId) throw new ConflictError('A zone with this name already exists.');
    // A state or PIN prefix in two active zones would make the charge depend on the order of the zones: refuse it.
    if (input.active) {
      const others = await tx.selectFrom('shipping_zones').select(['id', 'name', 'states', 'pin_prefixes']).where('is_active', '=', true).execute();
      for (const o of others.filter(o => o.id !== input.zoneId)) {
        const s = o.states.find(x => input.states.includes(x)); const p = o.pin_prefixes.find(x => input.pinPrefixes.includes(x));
        if (s || p) throw new ConflictError(`${s ? `${s} is` : `PIN prefix ${p} is`} already in the zone "${o.name}".`);
      }
    }
    if (!input.zoneId) {
      const z = await tx.insertInto('shipping_zones').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.zone_create', entityType: 'shipping_zones', entityId: z.id, after: row });
      return { id: z.id };
    }
    const before = await tx.selectFrom('shipping_zones').select(['name', 'states', 'pin_prefixes', 'is_active']).where('id', '=', input.zoneId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Zone not found.');
    await tx.updateTable('shipping_zones').set(row).where('id', '=', input.zoneId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.zone_update', entityType: 'shipping_zones', entityId: input.zoneId, before, after: row });
    return { id: input.zoneId };
  });
}

export type ShippingRateInput = {
  rateId?: string; zoneId: string; name: string; amount: number | null; freeFrom: number | null; minOrder: number | null; maxOrder: number | null;
  codAllowed: boolean; codFee: number | null; estMin: number | null; estMax: number | null; active: boolean;
  /** Store pickup (2026-10-01): customers collect from this location instead of a delivery. */
  pickupLocationId?: string | null;
  /** Shown under the option at checkout (2026-10-01). */
  description?: string | null;
};
export async function saveShippingRate(db: Db, actor: StaffPrincipal, input: ShippingRateInput, ctx: MutationContext) {
  requirePermission(actor, 'shipping.manage');
  const row = { zone_id: input.zoneId, name: input.name, amount_paise: input.amount ?? 0, free_from_paise: input.freeFrom, min_order_paise: input.minOrder,
    max_order_paise: input.maxOrder, cod_allowed: input.codAllowed, cod_fee_paise: input.codAllowed ? input.codFee : null, est_days_min: input.estMin,
    est_days_max: input.estMax, is_active: input.active, is_pickup: !!input.pickupLocationId, pickup_location_id: input.pickupLocationId ?? null, description: input.description ?? null };
  return db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('shipping_zones').select('id').where('id', '=', input.zoneId).executeTakeFirst())) throw new NotFoundError('Zone not found.');
    if (input.pickupLocationId && !(await tx.selectFrom('locations').select('id').where('id', '=', input.pickupLocationId).where('is_active', '=', true).executeTakeFirst()))
      throw new NotFoundError('Choose an active location for store pickup.');
    const clash = await tx.selectFrom('shipping_rates').select('id').where('zone_id', '=', input.zoneId).where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.rateId) throw new ConflictError('This zone already has a rate with this name.');
    if (!input.rateId) {
      const r = await tx.insertInto('shipping_rates').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.rate_create', entityType: 'shipping_rates', entityId: r.id, after: row });
      return { id: r.id };
    }
    const before = await tx.selectFrom('shipping_rates').selectAll().where('id', '=', input.rateId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Rate not found.');
    await tx.updateTable('shipping_rates').set(row).where('id', '=', input.rateId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.rate_update', entityType: 'shipping_rates', entityId: input.rateId, before, after: row });
    return { id: input.rateId };
  });
}

export async function deleteShippingRate(db: Db, actor: StaffPrincipal, input: { rateId: string }, ctx: MutationContext) {
  requirePermission(actor, 'shipping.manage');
  await db.transaction().execute(async tx => {
    const before = await tx.selectFrom('shipping_rates').selectAll().where('id', '=', input.rateId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Rate not found.');
    await tx.deleteFrom('shipping_rates').where('id', '=', input.rateId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.rate_delete', entityType: 'shipping_rates', entityId: input.rateId, before });
  });
}

/** What a customer would be charged for an address and order value (the same function checkout uses). */
export async function checkShippingQuote(db: Db, actor: StaffPrincipal, input: { state: string; pin: string; subtotalPaise: number }) {
  requirePermission(actor, 'shipping.read');
  return quoteFromZoneRates(await activeZoneRates(db), input.subtotalPaise, { state: input.state, pin: input.pin, country: 'IN' });
}

// ---------------------------------------------------------------- couriers
export async function listCouriers(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'shipping.read');
  return db.selectFrom('couriers as c').select(['c.code', 'c.name', 'c.mode', 'c.tracking_url_template', 'c.is_active', 'c.notes',
    sql<number>`(select count(*)::int from public.shipments s where s.carrier_code = c.code)`.as('shipments')]).orderBy('c.name').execute();
}

export async function saveCourier(db: Db, actor: StaffPrincipal, input: { code: string; name: string; mode: 'manual' | 'api'; trackingUrlTemplate: string | null; active: boolean; notes: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'shipping.manage');
  const row = { name: input.name, mode: input.mode, tracking_url_template: input.trackingUrlTemplate, is_active: input.active, notes: input.notes };
  await db.transaction().execute(async tx => {
    const before = await tx.selectFrom('couriers').select(['name', 'mode', 'tracking_url_template', 'is_active', 'notes']).where('code', '=', input.code).forUpdate().executeTakeFirst();
    if (!before) {
      await tx.insertInto('couriers').values({ code: input.code, ...row }).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.courier_create', entityType: 'couriers', entityId: input.code, after: row });
      return;
    }
    await tx.updateTable('couriers').set(row).where('code', '=', input.code).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.courier_update', entityType: 'couriers', entityId: input.code, before, after: row });
  });
}

// ---------------------------------------------------------------- shipments
const OPEN_SHIPMENTS = ['pending', 'processing', 'packed', 'shipped', 'in_transit', 'failed_delivery'] as const;

export async function listShipments(db: Db, actor: StaffPrincipal, query: { q?: string; status: string; courier?: string; page: number }) {
  requirePermission(actor, 'shipping.read');
  let q = db.selectFrom('shipments as s').innerJoin('orders as o', 'o.id', 's.order_id').leftJoin('couriers as c', 'c.code', 's.carrier_code')
    .select(['s.id', 's.order_id', 'o.order_number', 'o.status as order_status', 's.status', 's.carrier_code', 'c.name as courier_name', 's.tracking_number',
      's.tracking_url', 's.shipped_at', 's.delivered_at', 's.failed_at', 's.failure_reason', 's.updated_at',
      sql<string | null>`o.shipping_address->>'city'`.as('city'), sql<string | null>`o.shipping_address->>'state'`.as('state')]);
  if (query.status === 'open') q = q.where('s.status', 'in', [...OPEN_SHIPMENTS]);
  else if (query.status !== 'all') q = q.where('s.status', '=', query.status as never);
  if (query.courier) q = q.where('s.carrier_code', '=', query.courier);
  if (query.q) { const t = `%${query.q.replace(/[%_\\]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('o.order_number', 'ilike', t), eb('s.tracking_number', 'ilike', t)])); }
  const rows = await q.orderBy('s.updated_at', 'desc').limit(SHIPMENT_PAGE_SIZE + 1).offset((query.page - 1) * SHIPMENT_PAGE_SIZE).execute();
  const counts = await db.selectFrom('shipments').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
  return { rows: rows.slice(0, SHIPMENT_PAGE_SIZE), hasNext: rows.length > SHIPMENT_PAGE_SIZE, counts: Object.fromEntries(counts.map(c => [c.status, c.n])) as Record<string, number> };
}

export async function getShipmentDetail(db: Db, actor: StaffPrincipal, shipmentId: string) {
  requirePermission(actor, 'shipping.read');
  const s = await db.selectFrom('shipments as s').innerJoin('orders as o', 'o.id', 's.order_id').leftJoin('couriers as c', 'c.code', 's.carrier_code')
    .select(['s.id', 's.order_id', 'o.order_number', 'o.status as order_status', 'o.shipping_address', 's.status', 's.carrier_code', 'c.name as courier_name',
      's.tracking_number', 's.tracking_url', 's.packing_state', 's.shipped_at', 's.in_transit_at', 's.delivered_at', 's.failed_at', 's.failure_reason', 's.cancelled_at', 's.updated_at'])
    .where('s.id', '=', shipmentId).executeTakeFirst();
  if (!s) throw new NotFoundError('Shipment not found.');
  const events = await db.selectFrom('shipment_events as e').leftJoin('staff_users as u', 'u.id', 'e.staff_user_id')
    .select(['e.id', 'e.status', 'e.note', 'e.source', 'e.created_at', 'u.email as staff_email']).where('e.shipment_id', '=', shipmentId).orderBy('e.created_at').orderBy('e.id').execute();
  return { shipment: s, events: events.map(e => ({ ...e, id: String(e.id) })) };
}

/** Delivery statuses this module moves a shipment to from each status (shipped / delivered also move the order). */
export const SHIPMENT_MOVES: Record<string, readonly string[]> = {
  shipped: ['in_transit', 'delivered', 'failed_delivery'],
  in_transit: ['delivered', 'failed_delivery'],
  failed_delivery: ['in_transit', 'delivered'],
  pending: [], processing: [], packed: [], delivered: [], cancelled: [],
};

/** Records a delivery update (in transit, failed delivery, a new attempt, delivered) and/or corrects courier and tracking. */
export async function updateShipmentStatus(db: Db, actor: StaffPrincipal,
  input: { shipmentId: string; status: string; courierCode: string | null; trackingNumber: string | null; note: string | null; failureReason: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'shipping.manage');
  const r = await db.transaction().execute(async tx => {
    const s = await tx.selectFrom('shipments').select(['id', 'order_id', 'status', 'carrier_code', 'tracking_number']).where('id', '=', input.shipmentId).forUpdate().executeTakeFirst();
    if (!s) throw new NotFoundError('Shipment not found.');
    const o = await lockOrder(tx, { id: s.order_id });
    if (!o) throw new NotFoundError('Order not found.');
    const statusChanges = input.status !== s.status;
    if (statusChanges && !(SHIPMENT_MOVES[s.status] ?? []).includes(input.status)) {
      if (['pending', 'processing', 'packed'].includes(s.status)) throw new ConflictError('Pack and ship the order from its order page first; delivery updates start once it has shipped.');
      throw new DomainError('invalid', `A shipment cannot go from ${s.status.replace(/_/g, ' ')} to ${input.status.replace(/_/g, ' ')}.`);
    }
    if (input.status === 'failed_delivery' && statusChanges && !input.failureReason) throw new DomainError('invalid', 'Say why the delivery failed.');
    // Courier / tracking corrections.
    const set: Record<string, unknown> = { updated_by: actor.staffId };
    if (input.courierCode && input.courierCode !== s.carrier_code) {
      const carrier = await resolveCarrier(tx, input.courierCode);
      if (!carrier) throw new DomainError('invalid', 'Choose one of the active couriers.');
      set.carrier_code = carrier.code;
    }
    const tracking = input.trackingNumber ?? s.tracking_number;
    if (input.trackingNumber && input.trackingNumber !== s.tracking_number) set.tracking_number = input.trackingNumber;
    if (set.carrier_code || set.tracking_number) {
      const carrier = await resolveCarrier(tx, (set.carrier_code as string | undefined) ?? s.carrier_code, { includeInactive: true });
      set.tracking_url = tracking && carrier ? carrier.trackingUrl(tracking) : null;
    }
    if (statusChanges && input.status === 'delivered') {
      // The order moves to delivered through its workflow; that also writes the shipment's delivered status and event.
      if (o.status !== 'shipped') throw new ConflictError(`The order is ${o.status.replace(/_/g, ' ')}; only a shipped order can be delivered.`);
      await applyOrderTransition(tx, o, 'delivered', { actor: 'staff', note: input.note ?? 'Delivered (shipping)' });
      await recordShipmentForTransition(tx, o.id, 'delivered', { carrierCode: s.carrier_code, trackingNumber: null }, actor.staffId);
    } else if (statusChanges) {
      set.status = input.status;
      if (input.status === 'in_transit') set.in_transit_at = sql<Date>`now()`;
      if (input.status === 'failed_delivery') { set.failed_at = sql<Date>`now()`; set.failure_reason = input.failureReason; }
      await tx.insertInto('shipment_events').values({ shipment_id: s.id, status: input.status,
        note: input.status === 'failed_delivery' ? input.failureReason : input.note, source: 'staff', staff_user_id: actor.staffId }).execute();
    } else if (input.note) {
      await tx.insertInto('shipment_events').values({ shipment_id: s.id, status: s.status, note: input.note, source: 'staff', staff_user_id: actor.staffId }).execute();
    }
    if (Object.keys(set).length > 1) await tx.updateTable('shipments').set(set).where('id', '=', s.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'shipping.shipment_update', entityType: 'shipments', entityId: s.id,
      before: { status: s.status, carrier: s.carrier_code, tracking_number: s.tracking_number }, after: { status: input.status, carrier: set.carrier_code ?? s.carrier_code, tracking_number: tracking },
      metadata: { order_number: o.order_number, note: input.note, failure_reason: input.failureReason } });
    return { orderId: o.id, orderNumber: o.order_number, from: s.status, to: input.status, delivered: statusChanges && input.status === 'delivered' };
  });
  if (r.from !== r.to && r.to === 'failed_delivery')
    await raiseAlertSafely(db, { kind: 'shipment.failed', title: `Delivery failed for order ${r.orderNumber}`, body: input.failureReason, entityType: 'shipments',
      entityId: input.shipmentId, link: `/shipping/shipments/${input.shipmentId}` });
  return r;
}

/** Shipping report for a period: shipments by status and courier, delivery times, failed deliveries, charges collected. */
export async function shippingReport(db: Db, actor: StaffPrincipal, range: { from: string; to: string }) {
  requirePermission(actor, 'shipping.read');
  const inRange = sql<boolean>`s.shipped_at >= ${range.from}::date and s.shipped_at < (${range.to}::date + 1)`;
  const [byCourier, byStatus, charges] = await Promise.all([
    db.selectFrom('shipments as s').leftJoin('couriers as c', 'c.code', 's.carrier_code')
      .select(['s.carrier_code', 'c.name as courier_name', sql<number>`count(*)::int`.as('shipped'),
        sql<number>`count(*) filter (where s.status = 'delivered')::int`.as('delivered'),
        sql<number>`count(*) filter (where s.failed_at is not null)::int`.as('failed'),
        sql<number | null>`round(avg(extract(epoch from (s.delivered_at - s.shipped_at)) / 86400) filter (where s.delivered_at is not null), 1)::float8`.as('avg_days')])
      .where(inRange).groupBy(['s.carrier_code', 'c.name']).orderBy(sql`count(*)`, 'desc').execute(),
    db.selectFrom('shipments as s').select(['s.status', sql<number>`count(*)::int`.as('n')]).where(inRange).groupBy('s.status').execute(),
    db.selectFrom('orders as o').select([sql<number>`count(*)::int`.as('orders'), sql<number>`coalesce(sum(o.shipping_paise), 0)::int`.as('shipping_paise'),
      sql<number>`count(*) filter (where o.shipping_paise = 0)::int`.as('free')])
      .where('o.status', 'in', ['paid', 'processing', 'shipped', 'delivered'])
      .where(sql<boolean>`(o.created_at at time zone 'Asia/Kolkata')::date between ${range.from}::date and ${range.to}::date`).executeTakeFirstOrThrow(),
  ]);
  return { byCourier, byStatus, charges };
}


/** Customer email when an order is delivered (only when Configuration → "Email when an order is delivered" is on). */
export async function orderDeliveredEmail(q: Queryable, orderId: string, opts: { storeUrl?: string | null } = {}) {
    const o = await q.selectFrom('orders').select(['id', 'order_number', 'status', 'contact']).where('id', '=', orderId).executeTakeFirst();
    if (!o || o.status !== 'delivered') return null;
    const c = (o.contact ?? {}) as Record<string, unknown>;
    return { to: typeof c.email === 'string' ? c.email : '', orderId: o.id, subject: `Your KITSYUU order ${o.order_number} was delivered`,
      text: [hello(c.name), '', `Your order ${o.order_number} has been marked as delivered.`, 'If anything is wrong with it, reply to this email.', '',
        ...storeLink(opts.storeUrl, '/account/orders', 'Your orders')].join('\n') };
}
export const notifyOrderDelivered = (db: Db, mailer: Mailer, orderId: string, opts: { storeUrl?: string | null } = {}) =>
  sendCustomerEmail(db, mailer, 'order.delivered', q => orderDeliveredEmail(q, orderId, opts));
