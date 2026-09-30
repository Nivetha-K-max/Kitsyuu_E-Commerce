/* Client change request: link production and purchasing.
   For a production order, the material SHORTFALL is what is still needed (planned − already used) minus what is in stock
   minus what is already on order for it (open linked purchase orders, not yet received). Staff can raise a DRAFT purchase
   order to a chosen vendor for the shortfall (they may change the quantities); it is linked to the production order, then
   follows the normal vendor workflow: ordered → received in parts or in full → material stock through its ledger.
   Nothing is ordered automatically, and no cost is filled in (the unit cost is entered on the PO by staff with costs.read). */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const n = (v: unknown) => Number(v ?? 0);

export async function productionMaterialNeeds(db: Db, actor: StaffPrincipal, productionOrderId: string) {
  requirePermission(actor, 'production.read');
  const o = await db.selectFrom('production_orders').select(['id', 'number', 'status']).where('id', '=', productionOrderId).executeTakeFirst();
  if (!o) throw new NotFoundError('Production order not found.');
  const inputs = await db.selectFrom('production_inputs as i').innerJoin('materials as m', 'm.id', 'i.material_id')
    .select(['i.material_id', 'm.code', 'm.name', 'm.unit', 'm.stock_qty', 'm.is_active', 'i.qty_planned', 'i.qty_consumed',
      sql<string>`coalesce((select sum(l.qty_ordered - l.qty_received) from public.purchase_order_lines l join public.purchase_orders p on p.id = l.purchase_order_id
        join public.production_purchase_orders x on x.purchase_order_id = p.id
        where x.production_order_id = i.production_order_id and l.material_id = i.material_id and p.status in ('draft', 'ordered', 'partially_received')), 0)::text`.as('on_order')])
    .where('i.production_order_id', '=', productionOrderId).orderBy('m.code').execute();
  const needs = inputs.map(i => {
    const remaining = i.qty_planned === null ? null : Math.max(0, n(i.qty_planned) - n(i.qty_consumed));
    const shortfall = remaining === null ? null : Math.max(0, +(remaining - n(i.stock_qty) - n(i.on_order)).toFixed(3));
    return { materialId: i.material_id, code: i.code, name: i.name, unit: i.unit, active: i.is_active, planned: i.qty_planned === null ? null : n(i.qty_planned),
      used: n(i.qty_consumed), stock: n(i.stock_qty), onOrder: n(i.on_order), remaining, shortfall };
  });
  const linked = (await db.selectFrom('production_purchase_orders as x').innerJoin('purchase_orders as p', 'p.id', 'x.purchase_order_id').innerJoin('vendors as v', 'v.id', 'p.vendor_id')
    .select(['p.id', 'p.po_number', 'p.status', 'v.name as vendor', 'x.created_at',
      sql<string>`(select coalesce(sum(l.qty_ordered), 0)::text from public.purchase_order_lines l where l.purchase_order_id = p.id)`.as('ordered'),
      sql<string>`(select coalesce(sum(l.qty_received), 0)::text from public.purchase_order_lines l where l.purchase_order_id = p.id)`.as('received')])
    .where('x.production_order_id', '=', productionOrderId).orderBy('x.created_at').execute())
    .map(l => ({ ...l, ordered: n(l.ordered), received: n(l.received), remaining: Math.max(0, +(n(l.ordered) - n(l.received)).toFixed(3)) }));
  return { order: o, needs, linked, procurement: procurementStatus(needs, linked) };
}

export type ProcurementStatus = 'no_plan' | 'in_stock' | 'not_ordered' | 'partially_ordered' | 'ordered' | 'received';
/** Where a production order stands with materials: nothing planned; covered by stock; nothing / part / all of the shortfall
    on order (open linked purchase orders); or every linked purchase order received (and nothing short). Pure. */
export function procurementStatus(needs: { remaining: number | null; stock: number; onOrder: number; shortfall: number | null }[],
  linked: { status: string }[]): ProcurementStatus {
  const planned = needs.filter(x => x.remaining !== null);
  if (!planned.length) return 'no_plan';
  const gap = planned.reduce((s, x) => s + Math.max(0, x.remaining! - x.stock), 0);          // what stock alone does not cover
  const short = planned.reduce((s, x) => s + (x.shortfall ?? 0), 0);                          // what is not covered by stock or open POs
  const open = linked.filter(l => ['draft', 'ordered', 'partially_received'].includes(l.status));
  if (gap <= 0) return linked.length && linked.every(l => l.status === 'received' || l.status === 'cancelled') && linked.some(l => l.status === 'received') ? 'received' : 'in_stock';
  if (short <= 0) return 'ordered';
  return open.length ? 'partially_ordered' : 'not_ordered';
}

/** Production orders a purchase order was raised for (shown on the PO page). */
export async function purchaseOrderProduction(db: Db, actor: StaffPrincipal, purchaseOrderId: string) {
  requirePermission(actor, 'procurement.read');
  return db.selectFrom('production_purchase_orders as x').innerJoin('production_orders as o', 'o.id', 'x.production_order_id')
    .select(['o.id', 'o.number', 'o.status']).where('x.purchase_order_id', '=', purchaseOrderId).execute();
}

/** Raises a draft purchase order to one vendor for materials of a production order, and links the two. One transaction. */
export async function raisePurchaseOrderForProduction(db: Db, actor: StaffPrincipal,
  input: { productionOrderId: string; vendorId: string; lines: { materialId: string; qty: number }[]; notes: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  requirePermission(actor, 'production.read');
  const lines = input.lines.filter(l => l.qty > 0);
  if (!lines.length) throw new DomainError('invalid', 'Enter a quantity for at least one material.');
  if (new Set(lines.map(l => l.materialId)).size !== lines.length) throw new DomainError('invalid', 'Each material may appear only once.');
  return db.transaction().execute(async tx => {
    const o = await tx.selectFrom('production_orders').select(['id', 'number', 'status']).where('id', '=', input.productionOrderId).forShare().executeTakeFirst();
    if (!o) throw new NotFoundError('Production order not found.');
    if (o.status === 'completed' || o.status === 'cancelled') throw new ConflictError(`Production order ${o.number} is ${o.status}; no materials are needed for it.`);
    const v = await tx.selectFrom('vendors').select(['id', 'is_active']).where('id', '=', input.vendorId).forShare().executeTakeFirst();
    if (!v) throw new NotFoundError('Vendor not found.');
    if (!v.is_active) throw new ConflictError('This vendor is inactive. Activate it first, or choose another.');
    const planned = await tx.selectFrom('production_inputs as i').innerJoin('materials as m', 'm.id', 'i.material_id').select(['i.material_id', 'm.is_active'])
      .where('i.production_order_id', '=', o.id).execute();
    for (const l of lines) {
      const p = planned.find(x => x.material_id === l.materialId);
      if (!p) throw new DomainError('invalid', 'A material is not part of this production order. Add it to the production order first.');
      if (!p.is_active) throw new ConflictError('One of the materials is inactive.');
    }
    const { n: poNumber } = (await sql<{ n: string }>`select public.next_document_number('purchase_order', 'PO') as n`.execute(tx)).rows[0];
    const po = await tx.insertInto('purchase_orders').values({ po_number: poNumber, vendor_id: v.id, expected_on: null,
      notes: input.notes ?? `For production order ${o.number}`, created_by: actor.staffId }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('purchase_order_lines').values(lines.map((l, i) => ({ purchase_order_id: po.id, material_id: l.materialId, qty_ordered: String(l.qty), unit_cost_paise: null, position: i }))).execute();
    await tx.insertInto('production_purchase_orders').values({ production_order_id: o.id, purchase_order_id: po.id, created_by: actor.staffId }).execute();
    const audit = { actorType: 'staff' as const, staffId: actor.staffId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null };
    await recordAudit(tx, { ...audit, action: 'purchase_order.create', entityType: 'purchase_orders', entityId: po.id,
      after: { po_number: poNumber, vendor_id: v.id, lines }, metadata: { production_order: o.number } });
    await recordAudit(tx, { ...audit, action: 'production.purchase_order_link', entityType: 'production_orders', entityId: o.id, metadata: { po_number: poNumber } });
    return { id: po.id, poNumber };
  });
}
