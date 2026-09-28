/* M14: production and quality control. KITSYUU makes its own clothes; this is the minimum that connects purchasing
   (materials) to finished-goods stock without inventing the manufacturing stages, which are not decided:
     planned → in_progress → completed (by recording the quality check) / cancelled.
   Materials used are drawn from material stock through the material ledger; passed pieces enter garment stock through
   adjust_stock('production_in'); rejected pieces are recorded with a reason and never enter stock.
   Status moves are declared once (PRODUCTION_TRANSITIONS); every change is audited in the same transaction. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { materialLedger } from './procurement.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
const qty = (v: unknown) => Number(v);

export type ProductionStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';
/** Staff moves; 'completed' is reached only by recording the quality check (recordQualityCheck). */
export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, readonly ProductionStatus[]> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['cancelled'],
  completed: [],
  cancelled: [],
};

export async function listProductionOrders(db: Db, actor: StaffPrincipal, query: { status?: ProductionStatus }) {
  requirePermission(actor, 'production.read');
  let q = db.selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('qc_results as r', 'r.production_order_id', 'o.id')
    .select(['o.id', 'o.number', 'o.status', 'o.qty_planned', 'o.due_on', 'o.created_at', 'o.completed_at', 'p.name as product', 'p.sku', 'v.size', 'v.sku as variant_sku',
      'r.qty_passed', 'r.qty_rejected']);
  if (query.status) q = q.where('o.status', '=', query.status);
  return q.orderBy('o.created_at', 'desc').limit(200).execute();
}

export async function getProductionOrder(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'production.read');
  const o = await db.selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').innerJoin('products as p', 'p.id', 'v.product_id')
    .leftJoin('staff_users as s', 's.id', 'o.created_by')
    .select(['o.id', 'o.number', 'o.status', 'o.qty_planned', 'o.due_on', 'o.notes', 'o.started_at', 'o.completed_at', 'o.cancel_note', 'o.created_at',
      'o.variant_id', 'p.id as product_id', 'p.name as product', 'p.sku', 'v.size', 'v.sku as variant_sku', 'v.stock_qty', 's.email as created_by'])
    .where('o.id', '=', id).executeTakeFirst();
  if (!o) throw new NotFoundError('Production order not found.');
  const inputs = (await db.selectFrom('production_inputs as i').innerJoin('materials as m', 'm.id', 'i.material_id')
    .select(['i.id', 'i.material_id', 'm.code', 'm.name', 'm.unit', 'm.stock_qty', 'i.qty_planned', 'i.qty_consumed'])
    .where('i.production_order_id', '=', id).orderBy('m.code').execute())
    .map(i => ({ ...i, stock: qty(i.stock_qty), planned: i.qty_planned === null ? null : qty(i.qty_planned), consumed: qty(i.qty_consumed) }));
  const qc = await db.selectFrom('qc_results as r').leftJoin('staff_users as s', 's.id', 'r.inspected_by')
    .select(['r.qty_passed', 'r.qty_rejected', 'r.reject_reason', 'r.note', 'r.inspected_at', 's.email as inspected_by'])
    .where('r.production_order_id', '=', id).executeTakeFirst();
  return { order: o, inputs, qc: qc ?? null, next: [...PRODUCTION_TRANSITIONS[o.status as ProductionStatus]],
    canQc: can(actor, 'qc.record') && o.status === 'in_progress' };
}

export async function createProductionOrder(db: Db, actor: StaffPrincipal, input: { variantId: string; qty: number; dueOn: string | null; notes: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('product_variants').select(['id', 'sku']).where('id', '=', input.variantId).executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    const { n } = (await sql<{ n: string }>`select public.next_document_number('production_order', 'PR') as n`.execute(tx)).rows[0];
    const o = await tx.insertInto('production_orders').values({ number: n, variant_id: v.id, qty_planned: input.qty, due_on: input.dueOn, notes: input.notes, created_by: actor.staffId })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'production.create', entityType: 'production_orders', entityId: o.id, after: { number: n, variant_sku: v.sku, qty: input.qty } });
    return { id: o.id, number: n };
  });
}

async function lockOrder(tx: Tx, id: string) {
  const o = await tx.selectFrom('production_orders').select(['id', 'status', 'number', 'variant_id', 'qty_planned']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!o) throw new NotFoundError('Production order not found.');
  return o as { id: string; status: ProductionStatus; number: string; variant_id: string; qty_planned: number };
}

/** Plans a material for the order (quantity optional). Planned orders only. */
export async function setProductionInput(db: Db, actor: StaffPrincipal, input: { productionOrderId: string; materialId: string; qtyPlanned: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  await db.transaction().execute(async tx => {
    const o = await lockOrder(tx, input.productionOrderId);
    if (o.status !== 'planned' && o.status !== 'in_progress') throw new ConflictError('Materials can only be planned for open production orders.');
    const m = await tx.selectFrom('materials').select('id').where('id', '=', input.materialId).executeTakeFirst();
    if (!m) throw new NotFoundError('Material not found.');
    const plannedValue = input.qtyPlanned === null ? null : String(input.qtyPlanned);
    await tx.insertInto('production_inputs').values({ production_order_id: o.id, material_id: m.id, qty_planned: plannedValue })
      .onConflict(oc => oc.columns(['production_order_id', 'material_id']).doUpdateSet({ qty_planned: plannedValue })).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'production.input_plan', entityType: 'production_orders', entityId: o.id, after: { material_id: m.id, qty_planned: input.qtyPlanned } });
  });
}

/** Records material actually used: drawn from material stock (refused if there is not enough). Started orders only. */
export async function consumeMaterial(db: Db, actor: StaffPrincipal, input: { productionOrderId: string; materialId: string; qty: number }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  if (!(input.qty > 0)) throw new DomainError('invalid', 'Enter a quantity above zero.');
  return db.transaction().execute(async tx => {
    const o = await lockOrder(tx, input.productionOrderId);
    if (o.status !== 'in_progress') throw new ConflictError('Record materials used once production has started.');
    const exists = await tx.selectFrom('production_inputs').select('id').where('production_order_id', '=', o.id).where('material_id', '=', input.materialId).executeTakeFirst();
    if (!exists) await tx.insertInto('production_inputs').values({ production_order_id: o.id, material_id: input.materialId }).execute();
    const balance = await materialLedger(tx, input.materialId, -input.qty, 'consume', actor.staffId, o.number, null);
    await tx.updateTable('production_inputs').set({ qty_consumed: sql`qty_consumed + ${String(input.qty)}::numeric` })
      .where('production_order_id', '=', o.id).where('material_id', '=', input.materialId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'production.consume', entityType: 'production_orders', entityId: o.id,
      after: { material_id: input.materialId, qty: input.qty, material_balance: balance } });
    return { materialBalance: balance };
  });
}

export async function setProductionStatus(db: Db, actor: StaffPrincipal, input: { productionOrderId: string; status: 'in_progress' | 'cancelled'; expectedStatus: ProductionStatus; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'production.manage');
  await db.transaction().execute(async tx => {
    const o = await lockOrder(tx, input.productionOrderId);
    if (o.status !== input.expectedStatus) throw new ConflictError('This production order was changed by someone else since you opened the page. Reload and try again.');
    if (!PRODUCTION_TRANSITIONS[o.status].includes(input.status)) throw new ConflictError(`A ${o.status.replace('_', ' ')} order cannot be moved to ${input.status.replace('_', ' ')}.`);
    if (input.status === 'cancelled' && !input.note) throw new DomainError('invalid', 'Give a short reason for cancelling.');
    await tx.updateTable('production_orders').set({ status: input.status,
      ...(input.status === 'in_progress' && { started_at: sql<Date>`now()` }), ...(input.status === 'cancelled' && { cancel_note: input.note }) }).where('id', '=', o.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.status === 'in_progress' ? 'production.start' : 'production.cancel', entityType: 'production_orders', entityId: o.id,
      before: { status: o.status }, after: { status: input.status }, metadata: { note: input.note } });
  });
}

/** Completes the order with its quality check: passed pieces go into stock (production_in), rejected ones are recorded. */
export async function recordQualityCheck(db: Db, actor: StaffPrincipal, input: { productionOrderId: string; passed: number; rejected: number; rejectReason: string | null; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'qc.record');
  if (input.passed < 0 || input.rejected < 0 || input.passed + input.rejected === 0) throw new DomainError('invalid', 'Enter how many pieces passed and how many were rejected.');
  if (input.rejected > 0 && !input.rejectReason) throw new DomainError('invalid', 'Give the reason for the rejected pieces.');
  return db.transaction().execute(async tx => {
    const o = await lockOrder(tx, input.productionOrderId);
    if (o.status !== 'in_progress') throw new ConflictError('Only production in progress can be completed.');
    await tx.insertInto('qc_results').values({ production_order_id: o.id, qty_passed: input.passed, qty_rejected: input.rejected,
      reject_reason: input.rejected > 0 ? input.rejectReason : null, note: input.note, inspected_by: actor.staffId }).execute();
    let balance: number | null = null;
    if (input.passed > 0) {
      const r = await sql<{ balance_after: number }>`select balance_after from public.adjust_stock(${o.variant_id}::uuid, ${input.passed}::int, 'production_in', ${actor.staffId}::uuid, ${o.number}, null)`.execute(tx);
      balance = r.rows[0].balance_after;
    }
    await tx.updateTable('production_orders').set({ status: 'completed', completed_at: sql<Date>`now()` }).where('id', '=', o.id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'production.complete', entityType: 'production_orders', entityId: o.id,
      before: { status: o.status }, after: { status: 'completed', passed: input.passed, rejected: input.rejected, stock_after: balance },
      metadata: { planned: o.qty_planned, reject_reason: input.rejectReason } });
    return { stockAfter: balance };
  });
}

/** Sizes that can be produced, labelled for a picker ("KTS-TOP-001 · Name · M"). Archived products are left out. */
export async function listProducibleVariants(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'production.read');
  const rows = await db.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['v.id', 'v.size', 'v.stock_qty', 'p.sku', 'p.name']).where('p.status', '!=', 'archived').orderBy('p.sku').orderBy('v.sort_order').execute();
  return rows.map(r => ({ id: r.id, label: `${r.sku} · ${r.name} · ${r.size} (in stock ${r.stock_qty})` }));
}
