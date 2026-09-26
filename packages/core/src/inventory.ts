/* Stock administration. Stock is changed ONLY through public.adjust_stock(): it locks the variant, refuses negative
   stock, updates stock_qty and writes the inventory ledger row (reason, staff member, balance after) together.
   The audit record is written in the same transaction, so ledger, stock and audit always agree. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, type AdjustStockInput, type StockListQuery } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

/** Reasons a person may choose (system reasons such as seed/sale/cancel are used by the platform itself). */
export async function listAdjustmentReasons(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'inventory.read');
  return db.selectFrom('inventory_reasons').select(['code', 'label', 'direction'])
    .where('is_system', '=', false).where('is_active', '=', true).orderBy('sort_order').execute();
}

export async function listStock(db: Db, actor: StaffPrincipal, query: StockListQuery) {
  requirePermission(actor, 'inventory.read');
  let q = db.selectFrom('v_inventory_status as s')
    .select(['s.variant_id', 's.variant_sku', 's.size', 's.product_id', 's.product_sku', 's.product_name', 's.product_status', 's.is_active',
      's.stock_qty', 's.reorder_level', 's.stock_status', 's.last_movement_at']);
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    q = q.where(eb => eb.or([eb('s.product_name', 'ilike', like), eb('s.variant_sku', 'ilike', like), eb('s.product_id', 'ilike', like)]));
  }
  if (query.status === 'attention') q = q.where('s.is_active', '=', true).where('s.stock_status', '!=', 'in_stock');
  else if (query.status !== 'all') q = q.where('s.stock_status', '=', query.status);
  const rows = await q.orderBy('s.product_sku').orderBy('s.variant_sku').execute();
  const totals = await db.selectFrom('product_variants').select([
    sql<number>`count(*)::int`.as('variants'), sql<number>`coalesce(sum(stock_qty), 0)::int`.as('units'),
  ]).executeTakeFirstOrThrow();
  return { rows, totals };
}

/** Maps adjust_stock()'s SQLSTATEs to messages a staff member can act on. */
function stockError(e: unknown): never {
  const code = (e as { code?: string })?.code;
  const msg = String((e as Error)?.message ?? '');
  if (code === '23514') throw new ConflictError('That would take stock below zero. Nothing was changed.');
  if (code === '22023') throw new DomainError('invalid', /does not allow/.test(msg) ? 'That reason cannot be used for this direction of change.' : 'That adjustment is not valid.');
  if (code === '42501') throw new DomainError('forbidden', 'Your account is not active.');
  if (code === 'P0002') throw new NotFoundError('Size not found.');
  throw e;
}

export async function adjustStock(db: Db, actor: StaffPrincipal, input: AdjustStockInput, ctx: MutationContext) {
  requirePermission(actor, 'inventory.adjust');
  const delta = input.direction === 'increase' ? input.quantity : -input.quantity;
  return db.transaction().execute(async tx => {
    const reason = await tx.selectFrom('inventory_reasons').select(['code', 'direction', 'is_system', 'is_active']).where('code', '=', input.reason).executeTakeFirst();
    if (!reason || reason.is_system || !reason.is_active) throw new DomainError('invalid', 'Choose one of the listed reasons.');
    if ((reason.direction === 'in' && delta < 0) || (reason.direction === 'out' && delta > 0))
      throw new DomainError('invalid', `“${reason.code}” can only be used to ${reason.direction === 'in' ? 'increase' : 'decrease'} stock.`);
    const v = await tx.selectFrom('product_variants').select(['id', 'sku', 'product_id', 'size', 'stock_qty']).where('id', '=', input.variantId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    if (v.stock_qty !== input.expectedQty) throw new ConflictError(`Stock for ${v.sku} changed since you opened this page (now ${v.stock_qty}). Reload and try again.`);
    if (v.stock_qty + delta < 0) throw new ConflictError(`That would take ${v.sku} below zero (${v.stock_qty} in stock). Nothing was changed.`);
    const moved = await sql<{ movement_id: number; balance_after: number }>`
      select movement_id, balance_after from public.adjust_stock(${input.variantId}::uuid, ${delta}::int, ${input.reason}::text, ${actor.staffId}::uuid, ${input.note}::text, null::uuid)`
      .execute(tx).catch(stockError);
    const row = moved.rows[0];
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'inventory.adjust', entityType: 'product_variants', entityId: input.variantId,
      before: { stock_qty: v.stock_qty }, after: { stock_qty: row.balance_after },
      metadata: { sku: v.sku, product_id: v.product_id, size: v.size, delta, reason: input.reason, note: input.note, movement_id: row.movement_id }, ...auditCtx(ctx) });
    return { sku: v.sku, before: v.stock_qty, after: row.balance_after, delta, movementId: row.movement_id };
  });
}
