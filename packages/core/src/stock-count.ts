/* M15: stock counts (stock-take) and stock value.
   Count: opening snapshots the expected stock of every size of non-archived products; staff enter what they counted;
   posting applies (counted − expected) to the current stock through adjust_stock('count_adjust'), so anything sold or
   produced while counting is kept. One count can be open at a time.
   Value: no costing method is decided, so nothing is computed from purchases for garments. A unit cost per size may be
   entered (costs.manage); value = stock × that cost where set. Materials are valued at their last purchase price. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

export async function listStockCounts(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'inventory.read');
  return db.selectFrom('stock_counts as c').leftJoin('staff_users as s', 's.id', 'c.created_by')
    .select(['c.id', 'c.number', 'c.status', 'c.note', 'c.created_at', 'c.posted_at', 's.email as created_by',
      sql<number>`(select count(*)::int from public.stock_count_lines l where l.stock_count_id = c.id)`.as('lines'),
      sql<number>`(select count(*)::int from public.stock_count_lines l where l.stock_count_id = c.id and l.counted_qty is not null)`.as('counted')])
    .orderBy('c.created_at', 'desc').limit(100).execute();
}

export async function openStockCount(db: Db, actor: StaffPrincipal, input: { note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.count');
  return db.transaction().execute(async tx => {
    if (await tx.selectFrom('stock_counts').select('id').where('status', '=', 'open').executeTakeFirst()) throw new ConflictError('A stock count is already open. Post or cancel it first.');
    const { n } = (await sql<{ n: string }>`select public.next_document_number('stock_count', 'SC') as n`.execute(tx)).rows[0];
    const c = await tx.insertInto('stock_counts').values({ number: n, note: input.note, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    const r = await sql<{ n: number }>`with ins as (
        insert into public.stock_count_lines (stock_count_id, variant_id, expected_qty)
        select ${c.id}::uuid, v.id, v.stock_qty from public.product_variants v join public.products p on p.id = v.product_id where p.status <> 'archived'
        returning 1) select count(*)::int as n from ins`.execute(tx);
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'stock_count.open', entityType: 'stock_counts', entityId: c.id, after: { number: n, lines: r.rows[0].n } });
    return { id: c.id, number: n, lines: r.rows[0].n };
  });
}

export async function getStockCount(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'inventory.read');
  const c = await db.selectFrom('stock_counts').select(['id', 'number', 'status', 'note', 'created_at', 'posted_at']).where('id', '=', id).executeTakeFirst();
  if (!c) throw new NotFoundError('Stock count not found.');
  const lines = await db.selectFrom('stock_count_lines as l').innerJoin('product_variants as v', 'v.id', 'l.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['l.id', 'l.expected_qty', 'l.counted_qty', 'v.stock_qty as current_qty', 'v.size', 'v.sku as variant_sku', 'p.name'])
    .where('l.stock_count_id', '=', id).orderBy('p.sku').orderBy('v.sort_order').execute();
  return { count: c, lines: lines.map(l => ({ ...l, difference: l.counted_qty === null ? null : l.counted_qty - l.expected_qty })) };
}

/** Saves counted quantities (only lines that were filled in). Open counts only. */
export async function recordCounts(db: Db, actor: StaffPrincipal, input: { stockCountId: string; lines: { lineId: string; counted: number }[] }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.count');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('stock_counts').select(['id', 'status']).where('id', '=', input.stockCountId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Stock count not found.');
    if (c.status !== 'open') throw new ConflictError('This stock count is closed.');
    let saved = 0;
    for (const l of input.lines) {
      if (!Number.isInteger(l.counted) || l.counted < 0) throw new DomainError('invalid', 'Counts must be whole numbers, 0 or more.');
      const r = await tx.updateTable('stock_count_lines').set({ counted_qty: l.counted }).where('id', '=', l.lineId).where('stock_count_id', '=', c.id).executeTakeFirst();
      saved += Number(r.numUpdatedRows);
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'stock_count.record', entityType: 'stock_counts', entityId: c.id, metadata: { lines: saved } });
    return { saved };
  });
}

/** Posts the differences to stock (one ledger row per size that differs) and closes the count. */
export async function postStockCount(db: Db, actor: StaffPrincipal, input: { stockCountId: string }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.count');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('stock_counts').select(['id', 'status', 'number']).where('id', '=', input.stockCountId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Stock count not found.');
    if (c.status !== 'open') throw new ConflictError('This stock count is already closed.');
    const lines = await tx.selectFrom('stock_count_lines').select(['variant_id', 'expected_qty', 'counted_qty']).where('stock_count_id', '=', c.id).where('counted_qty', 'is not', null).execute();
    if (!lines.length) throw new ConflictError('Enter at least one counted quantity before posting.');
    const changes: { variant_id: string; delta: number }[] = [];
    for (const l of lines) {
      const delta = l.counted_qty! - l.expected_qty;
      if (delta === 0) continue;
      try {
        await sql`select * from public.adjust_stock(${l.variant_id}::uuid, ${delta}::int, 'count_adjust', ${actor.staffId}::uuid, ${c.number}, null)`.execute(tx);
      } catch (e) {
        if (/insufficient stock/i.test((e as Error).message)) throw new ConflictError('A difference would take a size below zero (it was sold since the count started). Re-count it.');
        throw e;
      }
      changes.push({ variant_id: l.variant_id, delta });
    }
    await tx.updateTable('stock_counts').set({ status: 'posted', posted_by: actor.staffId, posted_at: sql<Date>`now()` }).where('id', '=', c.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'stock_count.post', entityType: 'stock_counts', entityId: c.id,
      after: { status: 'posted', counted: lines.length, adjusted: changes.length }, metadata: { changes } });
    return { counted: lines.length, adjusted: changes.length };
  });
}

export async function cancelStockCount(db: Db, actor: StaffPrincipal, input: { stockCountId: string }, ctx: MutationContext) {
  requirePermission(actor, 'inventory.count');
  await db.transaction().execute(async tx => {
    const c = await tx.selectFrom('stock_counts').select(['id', 'status']).where('id', '=', input.stockCountId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Stock count not found.');
    if (c.status !== 'open') throw new ConflictError('This stock count is already closed.');
    await tx.updateTable('stock_counts').set({ status: 'cancelled' }).where('id', '=', c.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'stock_count.cancel', entityType: 'stock_counts', entityId: c.id, before: { status: 'open' }, after: { status: 'cancelled' } });
  });
}

// ---------------------------------------------------------------- stock value
/** Sets (or clears, with null) the unit cost of one size. */
export async function setVariantCost(db: Db, actor: StaffPrincipal, input: { variantId: string; unitCostPaise: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'costs.manage');
  await db.transaction().execute(async tx => {
    if (!(await tx.selectFrom('product_variants').select('id').where('id', '=', input.variantId).executeTakeFirst())) throw new NotFoundError('Size not found.');
    const before = await tx.selectFrom('variant_costs').select('unit_cost_paise').where('variant_id', '=', input.variantId).forUpdate().executeTakeFirst();
    if ((before?.unit_cost_paise ?? null) === input.unitCostPaise) return;
    if (input.unitCostPaise === null) await tx.deleteFrom('variant_costs').where('variant_id', '=', input.variantId).execute();
    else await tx.insertInto('variant_costs').values({ variant_id: input.variantId, unit_cost_paise: input.unitCostPaise, updated_by: actor.staffId })
      .onConflict(oc => oc.column('variant_id').doUpdateSet({ unit_cost_paise: input.unitCostPaise!, updated_by: actor.staffId, updated_at: sql<Date>`now()` })).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'cost.update', entityType: 'product_variants', entityId: input.variantId,
      before: { unit_cost_paise: before?.unit_cost_paise ?? null }, after: { unit_cost_paise: input.unitCostPaise } });
  });
}

export async function stockValue(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'costs.read');
  const garments = await db.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').leftJoin('variant_costs as c', 'c.variant_id', 'v.id')
    .select(['v.id', 'v.sku', 'v.size', 'v.stock_qty', 'p.name', 'c.unit_cost_paise']).where('p.status', '!=', 'archived').orderBy('p.sku').orderBy('v.sort_order').execute();
  const materials = await db.selectFrom('materials as m')
    .select(['m.id', 'm.code', 'm.name', 'm.unit', 'm.stock_qty',
      sql<number | null>`(select l.unit_cost_paise from public.purchase_order_lines l join public.purchase_orders o on o.id = l.purchase_order_id
        where l.material_id = m.id and l.unit_cost_paise is not null and o.status in ('ordered', 'partially_received', 'received')
        order by o.ordered_at desc nulls last, o.created_at desc limit 1)`.as('last_cost_paise')])
    .orderBy('m.code').execute();
  const g = garments.map(r => ({ ...r, valuePaise: r.unit_cost_paise === null ? null : r.unit_cost_paise * r.stock_qty }));
  const m = materials.map(r => ({ ...r, stock: Number(r.stock_qty), valuePaise: r.last_cost_paise === null ? null : Math.round(Number(r.stock_qty) * r.last_cost_paise) }));
  const sum = (xs: { valuePaise: number | null }[]) => xs.reduce((n, x) => n + (x.valuePaise ?? 0), 0);
  return {
    garments: g, materials: m,
    totals: { garmentsPaise: sum(g), materialsPaise: sum(m), garmentsWithoutCost: g.filter(x => x.valuePaise === null && x.stock_qty > 0).length,
      materialsWithoutCost: m.filter(x => x.valuePaise === null && x.stock > 0).length },
  };
}
