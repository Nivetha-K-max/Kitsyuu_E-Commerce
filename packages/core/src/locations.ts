/* Client change request, third pass: inventory locations, stock transfers, stock per location, and reports by location
   and sales channel.

   Model (migration 20261004004000):
   - locations are rows staff manage (Chennai Warehouse, Retail Branch 1, Retail Branch 2, …); nothing is hard-coded except
     that exactly one location is the ONLINE location: the online store sells its stock (product_variants.stock_qty), so
     the cart, checkout and orders work exactly as before.
   - location_stock holds every location's quantity per size. The online location's row always equals stock_qty; other
     locations change only through adjust_location_stock(). Every change is a ledger row with its location.
   - A transfer moves stock between two locations: draft → sent (stock leaves the source: transfer_out) → received (stock
     arrives at the destination: transfer_in). Cancelling a sent transfer brings the stock back to the source.
   - Sales channel: orders are online (the store). In-store sales are recorded as "Retail sale" stock movements at a retail
     location until a till / POS is decided by the client (no retail orders or takings are invented here).
   Permissions: inventory.read (see), inventory.adjust (adjust stock at a location), inventory.transfer (transfers),
   locations.manage (add / edit locations). Every change is audited. */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

export const LOCATION_KINDS = { warehouse: 'Warehouse', retail: 'Retail branch', other: 'Other' } as const;

// ---------------------------------------------------------------- locations
export async function listLocations(db: Queryable, actor: StaffPrincipal, opts: { activeOnly?: boolean } = {}) {
  requirePermission(actor, 'inventory.read');
  let q = db.selectFrom('locations as l').select(['l.id', 'l.code', 'l.name', 'l.kind', 'l.address', 'l.is_online', 'l.is_active', 'l.sort_order',
    sql<number>`(select coalesce(sum(s.qty), 0)::int from public.location_stock s where s.location_id = l.id)`.as('units'),
    sql<number>`(select count(*)::int from public.location_stock s where s.location_id = l.id and s.qty > 0)`.as('sizes')]);
  if (opts.activeOnly) q = q.where('l.is_active', '=', true);
  return q.orderBy('l.is_online', 'desc').orderBy('l.sort_order').orderBy('l.name').execute();
}

export async function onlineLocationId(q: Queryable): Promise<string> {
  const r = await q.selectFrom('locations').select('id').where('is_online', '=', true).executeTakeFirst();
  if (!r) throw new ConflictError('No online location is set up.');
  return r.id;
}

export async function saveLocation(db: Db, actor: StaffPrincipal,
  input: { locationId?: string; code: string; name: string; kind: 'warehouse' | 'retail' | 'other'; address: string | null; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'locations.manage');
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new DomainError('invalid', 'Use a short code of 2–20 capital letters, digits or hyphens, e.g. RB-1.');
  return db.transaction().execute(async tx => {
    const dup = await tx.selectFrom('locations').select('id').where(eb => eb.or([eb('code', '=', code), eb(sql<string>`lower(name)`, '=', input.name.trim().toLowerCase())]))
      .$if(!!input.locationId, qb => qb.where('id', '!=', input.locationId!)).executeTakeFirst();
    if (dup) throw new ConflictError('Another location already has this code or name.');
    if (!input.locationId) {
      const { max } = await tx.selectFrom('locations').select(sql<number>`coalesce(max(sort_order), 0)::int`.as('max')).executeTakeFirstOrThrow();
      const row = { code, name: input.name.trim(), kind: input.kind, address: input.address, is_active: input.active, sort_order: max + 1 };
      const l = await tx.insertInto('locations').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'location.create', entityType: 'locations', entityId: l.id, after: row });
      return { id: l.id };
    }
    const cur = await tx.selectFrom('locations').selectAll().where('id', '=', input.locationId).forUpdate().executeTakeFirst();
    if (!cur) throw new NotFoundError('Location not found.');
    if (!input.active && cur.is_active) {
      if (cur.is_online) throw new ConflictError('The online location sells the store\'s stock, so it cannot be deactivated.');
      const { units } = await tx.selectFrom('location_stock').select(sql<number>`coalesce(sum(qty), 0)::int`.as('units')).where('location_id', '=', cur.id).executeTakeFirstOrThrow();
      if (units > 0) throw new ConflictError(`This location still holds ${units} unit(s). Transfer or count them out first.`);
      const open = await tx.selectFrom('stock_transfers').select('id').where('status', 'in', ['draft', 'sent'])
        .where(eb => eb.or([eb('from_location_id', '=', cur.id), eb('to_location_id', '=', cur.id)])).executeTakeFirst();
      if (open) throw new ConflictError('This location has an open transfer. Receive or cancel it first.');
    }
    const next = { code, name: input.name.trim(), kind: input.kind, address: input.address, is_active: input.active };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => cur[k] !== next[k]);
    if (!changed.length) return { id: cur.id, changed: 0 };
    await tx.updateTable('locations').set(next).where('id', '=', cur.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'location.update', entityType: 'locations', entityId: cur.id,
      before: Object.fromEntries(changed.map(k => [k, cur[k]])), after: Object.fromEntries(changed.map(k => [k, next[k]])) });
    return { id: cur.id, changed: changed.length };
  });
}

// ---------------------------------------------------------------- stock at a location
const variantLabel = sql<string>`p.name || ' · ' || coalesce((select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = v.colour_slug) || ' / ', '') || v.size`;

export async function getLocationStock(db: Db, actor: StaffPrincipal, input: { locationId: string; q?: string; inStockOnly?: boolean }) {
  requirePermission(actor, 'inventory.read');
  const loc = await db.selectFrom('locations').selectAll().where('id', '=', input.locationId).executeTakeFirst();
  if (!loc) throw new NotFoundError('Location not found.');
  let q = db.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('location_stock as s', join => join.onRef('s.variant_id', '=', 'v.id').on('s.location_id', '=', loc.id))
    .select(['v.id as variant_id', 'v.sku', 'v.size', 'v.colour_slug', 'p.id as product_id', 'p.name', 'p.sku as product_sku', 'p.status', 'v.is_active',
      sql<number>`coalesce(s.qty, 0)::int`.as('qty'), variantLabel.as('label')])
    .where('p.status', '!=', 'archived');
  if (input.q) { const like = `%${input.q.replace(/[\\%_]/g, m => '\\' + m)}%`; q = q.where(eb => eb.or([eb('p.name', 'ilike', like), eb('v.sku', 'ilike', like)])); }
  if (input.inStockOnly) q = q.where(sql<boolean>`coalesce(s.qty, 0) > 0`);
  const rows = await q.orderBy('p.sku').orderBy('v.colour_slug').orderBy('v.sort_order').execute();
  const movements = await db.selectFrom('inventory_movements as m').innerJoin('product_variants as v', 'v.id', 'm.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('staff_users as st', 'st.id', 'm.staff_id').leftJoin('inventory_reasons as r', 'r.code', 'm.reason').leftJoin('stock_transfers as t', 't.id', 'm.transfer_id')
    .select(['m.id', 'm.created_at', 'm.delta', 'm.reason', 'r.label as reason_label', 'm.balance_after', 'm.note', 'v.sku', 'st.email as staff_email', 't.number as transfer_number', 't.id as transfer_id'])
    .where(eb => loc.is_online ? eb.or([eb('m.location_id', '=', loc.id), eb('m.location_id', 'is', null)]) : eb('m.location_id', '=', loc.id))
    .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(50).execute();
  return { location: loc, rows, movements, units: rows.reduce((n, r) => n + r.qty, 0) };
}

/** Staff change the stock of one size at one location (a delivery, damage, a correction, an in-store sale…). The online
    location goes through the store's own stock. expectedQty: refused if the quantity changed since the page was opened. */
export async function adjustLocationStock(db: Db, actor: StaffPrincipal,
  input: { locationId: string; variantId: string; delta: number; reason: string; note: string | null; expectedQty: number }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.adjust');
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new DomainError('invalid', 'Enter a whole number other than 0.');
  try {
    return await db.transaction().execute(async tx => {
      const reason = await tx.selectFrom('inventory_reasons').select(['code', 'is_system', 'is_active']).where('code', '=', input.reason).executeTakeFirst();
      if (!reason || reason.is_system || !reason.is_active) throw new DomainError('invalid', 'Choose one of the listed reasons.');
      const loc = await tx.selectFrom('locations').select(['id', 'name', 'is_online', 'kind']).where('id', '=', input.locationId).executeTakeFirst();
      if (!loc) throw new NotFoundError('Location not found.');
      if (input.reason === 'retail_sale' && loc.is_online) throw new DomainError('invalid', 'Retail sales are recorded at a retail location, not the online location.');
      const cur = await tx.selectFrom('location_stock').select('qty').where('location_id', '=', loc.id).where('variant_id', '=', input.variantId).executeTakeFirst();
      if ((cur?.qty ?? 0) !== input.expectedQty) throw new ConflictError('The stock of this size changed since you opened the page. Reload and try again.');
      const r = await sql<{ movement_id: number; balance_after: number }>`select * from public.adjust_location_stock(${input.variantId}::uuid, ${loc.id}::uuid, ${input.delta}::int,
        ${input.reason}, ${actor.staffId}::uuid, ${input.note}::text, null)`.execute(tx);
      const v = await tx.selectFrom('product_variants').select(['sku']).where('id', '=', input.variantId).executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'inventory.location_adjust', entityType: 'product_variants', entityId: input.variantId,
        before: { qty: input.expectedQty }, after: { qty: r.rows[0].balance_after },
        metadata: { location_id: loc.id, location: loc.name, sku: v.sku, delta: input.delta, reason: input.reason, note: input.note, movement_id: r.rows[0].movement_id } });
      return { balance: r.rows[0].balance_after };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23514') throw new ConflictError('Not enough stock of this size at this location.');
    throw e;
  }
}

/** Every location's quantity of the given sizes (product page, transfer form). */
export async function stockByLocation(q: Queryable, variantIds: string[]) {
  if (!variantIds.length) return [];
  return q.selectFrom('location_stock as s').innerJoin('locations as l', 'l.id', 's.location_id')
    .select(['s.variant_id', 's.location_id', 'l.name', 'l.is_online', 's.qty']).where('s.variant_id', 'in', variantIds).where('s.qty', '>', 0)
    .orderBy('l.is_online', 'desc').orderBy('l.sort_order').execute();
}

// ---------------------------------------------------------------- transfers
export async function listTransfers(db: Db, actor: StaffPrincipal, query: { status?: string } = {}) {
  requirePermission(actor, 'inventory.read');
  let q = db.selectFrom('stock_transfers as t').innerJoin('locations as f', 'f.id', 't.from_location_id').innerJoin('locations as d', 'd.id', 't.to_location_id')
    .select(['t.id', 't.number', 't.status', 't.created_at', 't.sent_at', 't.received_at', 'f.name as from_name', 'd.name as to_name',
      sql<number>`(select coalesce(sum(l.qty), 0)::int from public.stock_transfer_lines l where l.transfer_id = t.id)`.as('units'),
      sql<number>`(select count(*)::int from public.stock_transfer_lines l where l.transfer_id = t.id)`.as('lines')]);
  if (query.status && ['draft', 'sent', 'received', 'cancelled'].includes(query.status)) q = q.where('t.status', '=', query.status as 'draft');
  return q.orderBy('t.created_at', 'desc').limit(200).execute();
}

export async function getTransfer(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'inventory.read');
  const t = await db.selectFrom('stock_transfers as t').innerJoin('locations as f', 'f.id', 't.from_location_id').innerJoin('locations as d', 'd.id', 't.to_location_id')
    .leftJoin('staff_users as c', 'c.id', 't.created_by').leftJoin('staff_users as s', 's.id', 't.sent_by').leftJoin('staff_users as r', 'r.id', 't.received_by')
    .select(['t.id', 't.number', 't.status', 't.note', 't.created_at', 't.sent_at', 't.received_at', 't.from_location_id', 't.to_location_id',
      'f.name as from_name', 'd.name as to_name', 'c.email as created_by', 's.email as sent_by', 'r.email as received_by'])
    .where('t.id', '=', id).executeTakeFirst();
  if (!t) throw new NotFoundError('Transfer not found.');
  const lines = await db.selectFrom('stock_transfer_lines as l').innerJoin('product_variants as v', 'v.id', 'l.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('location_stock as s', join => join.onRef('s.variant_id', '=', 'l.variant_id').on('s.location_id', '=', t.from_location_id))
    .select(['l.id', 'l.variant_id', 'l.qty', 'v.sku', 'v.size', 'p.name', variantLabel.as('label'), sql<number>`coalesce(s.qty, 0)::int`.as('at_source')])
    .where('l.transfer_id', '=', id).orderBy('v.sku').execute();
  return { transfer: t, lines };
}

/** A draft transfer with its lines (sizes and quantities). Both locations must be active and different. */
export async function createTransfer(db: Db, actor: StaffPrincipal,
  input: { fromLocationId: string; toLocationId: string; note: string | null; lines: { variantId: string; qty: number }[] }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.transfer');
  if (input.fromLocationId === input.toLocationId) throw new DomainError('invalid', 'Choose two different locations.');
  const lines = input.lines.filter(l => l.qty > 0);
  if (!lines.length) throw new DomainError('invalid', 'Enter a quantity for at least one size.');
  if (lines.some(l => !Number.isInteger(l.qty) || l.qty > 100_000)) throw new DomainError('invalid', 'Quantities are whole numbers.');
  if (new Set(lines.map(l => l.variantId)).size !== lines.length) throw new DomainError('invalid', 'A size is listed twice.');
  return db.transaction().execute(async tx => {
    const locs = await tx.selectFrom('locations').select(['id', 'is_active', 'name']).where('id', 'in', [input.fromLocationId, input.toLocationId]).execute();
    if (locs.length !== 2) throw new NotFoundError('Location not found.');
    if (locs.some(l => !l.is_active)) throw new ConflictError('Both locations must be active.');
    const known = await tx.selectFrom('product_variants').select('id').where('id', 'in', lines.map(l => l.variantId)).execute();
    if (known.length !== lines.length) throw new NotFoundError('One of the sizes no longer exists. Reload and try again.');
    const { n } = (await sql<{ n: string }>`select public.next_document_number('stock_transfer', 'TR') as n`.execute(tx)).rows[0];
    const t = await tx.insertInto('stock_transfers').values({ number: n, from_location_id: input.fromLocationId, to_location_id: input.toLocationId, note: input.note,
      created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('stock_transfer_lines').values(lines.map(l => ({ transfer_id: t.id, variant_id: l.variantId, qty: l.qty }))).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'transfer.create', entityType: 'stock_transfers', entityId: t.id,
      after: { number: n, from: input.fromLocationId, to: input.toLocationId, lines } });
    return { id: t.id, number: n };
  });
}

async function lockTransfer(tx: Tx, id: string) {
  const t = await tx.selectFrom('stock_transfers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!t) throw new NotFoundError('Transfer not found.');
  return t;
}

async function moveLines(tx: Tx, t: { id: string; number: string }, locationId: string, sign: 1 | -1, reason: 'transfer_out' | 'transfer_in', staffId: string, note: string) {
  const lines = await tx.selectFrom('stock_transfer_lines as l').innerJoin('product_variants as v', 'v.id', 'l.variant_id').select(['l.variant_id', 'l.qty', 'v.sku'])
    .where('l.transfer_id', '=', t.id).orderBy('l.variant_id').execute();
  for (const l of lines) {
    try {
      await sql`select * from public.adjust_location_stock(${l.variant_id}::uuid, ${locationId}::uuid, ${sign * l.qty}::int, ${reason}, ${staffId}::uuid, ${note}::text, ${t.id}::uuid)`.execute(tx);
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw new ConflictError(`Not enough stock of ${l.sku} at the sending location for this transfer.`);
      throw e;
    }
  }
  return lines.reduce((n, l) => n + l.qty, 0);
}

/** Sends a draft transfer: the stock leaves the source now (it is "in transit" until received). */
export async function sendTransfer(db: Db, actor: StaffPrincipal, input: { transferId: string }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.transfer');
  return db.transaction().execute(async tx => {
    const t = await lockTransfer(tx, input.transferId);
    if (t.status !== 'draft') throw new ConflictError('Only a draft transfer can be sent.');
    const units = await moveLines(tx, t, t.from_location_id, -1, 'transfer_out', actor.staffId, `${t.number} sent`);
    await tx.updateTable('stock_transfers').set({ status: 'sent', sent_by: actor.staffId, sent_at: sql<Date>`now()` }).where('id', '=', t.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'transfer.send', entityType: 'stock_transfers', entityId: t.id, before: { status: 'draft' }, after: { status: 'sent', units } });
    return { units };
  });
}

/** Receives a sent transfer: the stock arrives at the destination. */
export async function receiveTransfer(db: Db, actor: StaffPrincipal, input: { transferId: string }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.transfer');
  return db.transaction().execute(async tx => {
    const t = await lockTransfer(tx, input.transferId);
    if (t.status !== 'sent') throw new ConflictError('Only a sent transfer can be received.');
    const dest = await tx.selectFrom('locations').select('is_active').where('id', '=', t.to_location_id).executeTakeFirstOrThrow();
    if (!dest.is_active) throw new ConflictError('The receiving location is inactive.');
    const units = await moveLines(tx, t, t.to_location_id, 1, 'transfer_in', actor.staffId, `${t.number} received`);
    await tx.updateTable('stock_transfers').set({ status: 'received', received_by: actor.staffId, received_at: sql<Date>`now()` }).where('id', '=', t.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'transfer.receive', entityType: 'stock_transfers', entityId: t.id, before: { status: 'sent' }, after: { status: 'received', units } });
    return { units };
  });
}

/** Cancels a draft (nothing moved) or a sent transfer (the stock goes back to the source). */
export async function cancelTransfer(db: Db, actor: StaffPrincipal, input: { transferId: string; note: string }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.transfer');
  if (!input.note.trim()) throw new DomainError('invalid', 'Give a reason.');
  return db.transaction().execute(async tx => {
    const t = await lockTransfer(tx, input.transferId);
    if (t.status !== 'draft' && t.status !== 'sent') throw new ConflictError('This transfer is already closed.');
    const back = t.status === 'sent' ? await moveLines(tx, t, t.from_location_id, 1, 'transfer_in', actor.staffId, `${t.number} cancelled: back to the sender`) : 0;
    await tx.updateTable('stock_transfers').set({ status: 'cancelled', note: [t.note, `Cancelled: ${input.note.trim()}`].filter(Boolean).join(' · ').slice(0, 500) }).where('id', '=', t.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'transfer.cancel', entityType: 'stock_transfers', entityId: t.id,
      before: { status: t.status }, after: { status: 'cancelled', units_returned: back }, metadata: { note: input.note.trim() } });
    return { unitsReturned: back };
  });
}

// ---------------------------------------------------------------- reports
/** Stock by location and what moved in a period (sales online, retail sales, transfers, adjustments), plus the online
    channel's orders. Retail takings are not known until a till / POS is decided: retail shows units only. */
export async function locationReport(db: Db, actor: StaffPrincipal, input: { from: Date; to: Date }) {
  requirePermission(actor, 'inventory.read');
  const locs = await listLocations(db, actor);
  const moves = await db.selectFrom('inventory_movements as m').select([sql<string | null>`coalesce(m.location_id, (select id from public.locations where is_online))`.as('location_id'),
    'm.reason', sql<number>`sum(m.delta)::int`.as('delta'), sql<number>`count(*)::int`.as('n')])
    .where('m.created_at', '>=', input.from).where('m.created_at', '<', input.to)
    .groupBy([sql`coalesce(m.location_id, (select id from public.locations where is_online))`, 'm.reason']).execute();
  const online = await db.selectFrom('orders').select([sql<number>`count(*)::int`.as('orders'), sql<number>`coalesce(sum(total_paise), 0)::int`.as('revenue'),
    sql<number>`coalesce(sum((select sum(i.qty) from public.order_items i where i.order_id = orders.id)), 0)::int`.as('units')])
    .where('channel', '=', 'online').where('status', 'in', ['paid', 'processing', 'shipped', 'delivered']).where('created_at', '>=', input.from).where('created_at', '<', input.to)
    .executeTakeFirstOrThrow();
  const byLoc = locs.map(l => {
    const m = moves.filter(x => x.location_id === l.id);
    const sum = (codes: string[]) => m.filter(x => codes.includes(x.reason)).reduce((n, x) => n + x.delta, 0);
    const neg = (n: number) => (n === 0 ? 0 : -n);   // units out are negative in the ledger; never report -0
    return { ...l, soldOnline: neg(sum(['sale']) + sum(['cancel'])), retailSales: neg(sum(['retail_sale'])),
      transfersIn: sum(['transfer_in']), transfersOut: neg(sum(['transfer_out'])), adjustments: m.filter(x => !['sale', 'cancel', 'retail_sale', 'transfer_in', 'transfer_out'].includes(x.reason)).reduce((n, x) => n + x.delta, 0) };
  });
  return { locations: byLoc, channels: { online: { orders: online.orders, revenuePaise: online.revenue, units: online.units },
    retail: { units: byLoc.reduce((n, l) => n + l.retailSales, 0) } }, canSeeCosts: can(actor, 'costs.read') };
}
