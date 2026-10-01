/* M13: vendors, materials and purchasing. 2026-10-01: vendors supply FINISHED products too (hoodies, jeans): a purchase order
   line is either a product size (received into product stock at the order's location, through the stock ledger) or a
   material (received into material stock, as before). Steps: draft → approved (staff with procurement.approve) → ordered
   (sent to the vendor) → partially received → received → closed; an approver may approve and send in one go. Each delivery
   is a numbered goods receipt (GRN) linked to the order. Deliveries may arrive in parts, units are typed per material,
   material stock changes only through adjust_material_stock() (ledger + trigger guard, like garment stock).
   Unit costs are entered and shown only to staff with costs.read. Purchase-order status moves are declared once
   (PO_TRANSITIONS) and every change is audited in the same transaction. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
/** Material quantities are numeric(14,3): strings in and out, so no precision is lost in JavaScript numbers. */
const qty = (v: unknown) => Number(v);

export type PoStatus = 'draft' | 'approved' | 'ordered' | 'partially_received' | 'received' | 'closed' | 'cancelled';
/** Staff-driven moves (receiving moves ordered → partially_received / received on its own). "ordered" = sent to the vendor. */
export const PO_TRANSITIONS: Record<PoStatus, readonly PoStatus[]> = {
  draft: ['approved', 'ordered', 'cancelled'],     // draft → ordered: an approver approving and sending at once
  approved: ['ordered', 'draft', 'cancelled'],
  ordered: ['cancelled'],                          // only while nothing has been received
  partially_received: ['closed'],                  // nothing more is coming (a reason is required)
  received: ['closed'],
  closed: [],
  cancelled: [],
};
/** Moves that need procurement.approve (the rest need procurement.manage). */
const NEEDS_APPROVAL = (from: PoStatus, to: PoStatus) => to === 'approved' || to === 'closed' || (from === 'draft' && to === 'ordered');

// ---------------------------------------------------------------- vendors
export async function listVendors(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'procurement.read');
  return db.selectFrom('vendors as v').select(['v.id', 'v.name', 'v.contact', 'v.email', 'v.phone', 'v.gstin', 'v.address', 'v.notes', 'v.is_active',
    sql<number>`(select count(*)::int from public.purchase_orders p where p.vendor_id = v.id and p.status in ('approved', 'ordered', 'partially_received'))`.as('open_orders'),
    sql<number>`(select count(*)::int from public.vendor_products vp where vp.vendor_id = v.id)`.as('products')])
    .orderBy('v.is_active', 'desc').orderBy(sql`lower(v.name)`).execute();
}

export type VendorInput = { vendorId?: string; name: string; contact: string | null; email: string | null; phone: string | null; gstin: string | null; address: string | null; notes: string | null };
export async function saveVendor(db: Db, actor: StaffPrincipal, input: VendorInput, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  return db.transaction().execute(async tx => {
    const row = { name: input.name, contact: input.contact, email: input.email, phone: input.phone, gstin: input.gstin, address: input.address, notes: input.notes };
    const clash = await tx.selectFrom('vendors').select('id').where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.vendorId) throw new ConflictError('A vendor with this name already exists.');
    if (!input.vendorId) {
      const v = await tx.insertInto('vendors').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor.create', entityType: 'vendors', entityId: v.id, after: row });
      return { id: v.id, changed: 1 };
    }
    const before = await tx.selectFrom('vendors').select(['name', 'contact', 'email', 'phone', 'gstin', 'address', 'notes']).where('id', '=', input.vendorId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Vendor not found.');
    const changed = (Object.keys(row) as (keyof typeof row)[]).filter(k => before[k] !== row[k]);
    if (!changed.length) return { id: input.vendorId, changed: 0 };
    await tx.updateTable('vendors').set(row).where('id', '=', input.vendorId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor.update', entityType: 'vendors', entityId: input.vendorId,
      before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, row[k]])) });
    return { id: input.vendorId, changed: changed.length };
  });
}

export async function setVendorActive(db: Db, actor: StaffPrincipal, input: { vendorId: string; active: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  await db.transaction().execute(async tx => {
    const v = await tx.selectFrom('vendors').select('is_active').where('id', '=', input.vendorId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Vendor not found.');
    if (v.is_active === input.active) return;
    await tx.updateTable('vendors').set({ is_active: input.active }).where('id', '=', input.vendorId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor.status_update', entityType: 'vendors', entityId: input.vendorId, before: { is_active: v.is_active }, after: { is_active: input.active } });
  });
}

// ---------------------------------------------------------------- materials
export async function listMaterials(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'procurement.read');
  const rows = await db.selectFrom('materials as m').select(['m.id', 'm.code', 'm.name', 'm.unit', 'm.stock_qty', 'm.reorder_level', 'm.notes', 'm.is_active',
    sql<string>`coalesce((select sum(l.qty_ordered - l.qty_received) from public.purchase_order_lines l join public.purchase_orders p on p.id = l.purchase_order_id
      where l.material_id = m.id and p.status in ('ordered', 'partially_received')), 0)::text`.as('incoming')])
    .orderBy('m.is_active', 'desc').orderBy('m.code').execute();
  return rows.map(r => ({ ...r, stock: qty(r.stock_qty), incoming: qty(r.incoming), reorderLevel: r.reorder_level === null ? null : qty(r.reorder_level),
    low: r.reorder_level !== null && qty(r.stock_qty) <= qty(r.reorder_level) }));
}

export type MaterialInput = { materialId?: string; code?: string; name: string; unit: string; reorderLevel: number | null; notes: string | null };
export async function saveMaterial(db: Db, actor: StaffPrincipal, input: MaterialInput, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  return db.transaction().execute(async tx => {
    const row = { name: input.name, unit: input.unit, reorder_level: input.reorderLevel === null ? null : String(input.reorderLevel), notes: input.notes };
    if (!input.materialId) {
      if (!input.code) throw new DomainError('invalid', 'Enter a material code.');
      if (await tx.selectFrom('materials').select('id').where('code', '=', input.code).executeTakeFirst()) throw new ConflictError(`A material with the code ${input.code} already exists.`);
      const m = await tx.insertInto('materials').values({ ...row, code: input.code }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'material.create', entityType: 'materials', entityId: m.id, after: { code: input.code, ...row } });
      return { id: m.id, changed: 1 };
    }
    const before = await tx.selectFrom('materials').select(['name', 'unit', 'reorder_level', 'notes']).where('id', '=', input.materialId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Material not found.');
    const b = { ...before, reorder_level: before.reorder_level === null ? null : String(qty(before.reorder_level)) };
    const changed = (Object.keys(row) as (keyof typeof row)[]).filter(k => b[k] !== row[k]);
    if (!changed.length) return { id: input.materialId, changed: 0 };
    await tx.updateTable('materials').set(row).where('id', '=', input.materialId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'material.update', entityType: 'materials', entityId: input.materialId,
      before: Object.fromEntries(changed.map(k => [k, b[k]])), after: Object.fromEntries(changed.map(k => [k, row[k]])) });
    return { id: input.materialId, changed: changed.length };
  });
}

/** Stock correction or write-off of a material (receipts come from goods receipts, consumption from production). */
export async function adjustMaterialStock(db: Db, actor: StaffPrincipal, input: { materialId: string; delta: number; reason: 'correction' | 'damage'; note: string }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  if (!input.note.trim()) throw new DomainError('invalid', 'Give a short reason.');
  if (input.reason === 'damage' && input.delta >= 0) throw new DomainError('invalid', 'A write-off removes stock: enter a negative quantity.');
  return db.transaction().execute(async tx => {
    const balance = await materialLedger(tx, input.materialId, input.delta, input.reason, actor.staffId, input.note, null);
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'material.stock_adjust', entityType: 'materials', entityId: input.materialId,
      after: { delta: input.delta, balance }, metadata: { reason: input.reason, note: input.note } });
    return { balance };
  });
}

/** One ledger movement through the database function (the only path that may change materials.stock_qty). */
export async function materialLedger(tx: Tx, materialId: string, delta: number, reason: string, staffId: string | null, note: string | null, receiptId: string | null): Promise<number> {
  try {
    const r = await sql<{ v: string }>`select public.adjust_material_stock(${materialId}::uuid, ${String(delta)}::numeric, ${reason}, ${staffId}::uuid, ${note}, ${receiptId}::uuid)::text as v`.execute(tx);
    return qty(r.rows[0].v);
  } catch (e) {
    const m = (e as Error).message ?? '';
    if (/not enough stock/.test(m)) throw new ConflictError('There is not enough of this material in stock.');
    if (/not found/.test(m)) throw new NotFoundError('Material not found.');
    throw e;
  }
}

// ---------------------------------------------------------------- purchase orders
export async function listPurchaseOrders(db: Db, actor: StaffPrincipal, query: { status?: PoStatus }) {
  requirePermission(actor, 'procurement.read');
  let q = db.selectFrom('purchase_orders as p').innerJoin('vendors as v', 'v.id', 'p.vendor_id')
    .select(['p.id', 'p.po_number', 'p.status', 'p.expected_on', 'p.created_at', 'p.ordered_at', 'v.name as vendor',
      sql<number>`(select count(*)::int from public.purchase_order_lines l where l.purchase_order_id = p.id)`.as('lines')]);
  if (query.status) q = q.where('p.status', '=', query.status);
  return q.orderBy('p.created_at', 'desc').limit(200).execute();
}

/** A purchase order line, product size or material, as shown to staff (costs only with costs.read). */
const lineLabelSql = sql<string>`coalesce(p.name || ' · ' || coalesce((select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = pv.colour_slug) || ' / ', '') || pv.size, m.name)`;

export async function getPurchaseOrder(db: Db, actor: StaffPrincipal, id: string) {
  requirePermission(actor, 'procurement.read');
  const p = await db.selectFrom('purchase_orders as p').innerJoin('vendors as v', 'v.id', 'p.vendor_id').leftJoin('staff_users as s', 's.id', 'p.created_by')
    .leftJoin('staff_users as a', 'a.id', 'p.approved_by').leftJoin('staff_users as c', 'c.id', 'p.closed_by').leftJoin('locations as l', 'l.id', 'p.location_id')
    .select(['p.id', 'p.po_number', 'p.status', 'p.expected_on', 'p.notes', 'p.ordered_at', 'p.created_at', 'p.vendor_id', 'v.name as vendor', 's.email as created_by',
      'v.contact as vendor_contact', 'v.email as vendor_email', 'v.phone as vendor_phone', 'v.gstin as vendor_gstin', 'v.address as vendor_address',
      'p.location_id', 'l.name as location_name', 'p.approved_at', 'a.email as approved_by', 'p.closed_at', 'c.email as closed_by', 'p.close_note'])
    .where('p.id', '=', id).executeTakeFirst();
  if (!p) throw new NotFoundError('Purchase order not found.');
  const location = p.location_name ?? (await db.selectFrom('locations').select('name').where('is_online', '=', true).executeTakeFirst())?.name ?? 'Online stock';
  const costs = can(actor, 'costs.read');
  const lines = (await db.selectFrom('purchase_order_lines as ln').leftJoin('materials as m', 'm.id', 'ln.material_id')
    .leftJoin('product_variants as pv', 'pv.id', 'ln.variant_id').leftJoin('products as p', 'p.id', 'pv.product_id')
    .select(['ln.id', 'ln.material_id', 'ln.variant_id', 'm.code as material_code', 'm.unit', 'pv.sku', 'ln.qty_ordered', 'ln.qty_received', 'ln.unit_cost_paise', 'ln.position', lineLabelSql.as('name')])
    .where('ln.purchase_order_id', '=', id).orderBy('ln.position').execute())
    .map(l => ({ id: l.id, kind: (l.variant_id ? 'product' : 'material') as 'product' | 'material', materialId: l.material_id, variantId: l.variant_id,
      code: (l.variant_id ? l.sku : l.material_code) ?? '', name: l.name, unit: l.variant_id ? 'pcs' : l.unit ?? '',
      ordered: qty(l.qty_ordered), received: qty(l.qty_received), outstanding: qty(l.qty_ordered) - qty(l.qty_received), unitCostPaise: costs ? l.unit_cost_paise : undefined }));
  const receipts = await db.selectFrom('goods_receipts as g').leftJoin('staff_users as s', 's.id', 'g.received_by').leftJoin('locations as l', 'l.id', 'g.location_id')
    .select(['g.id', 'g.receipt_number', 'g.received_at', 'g.note', 'g.vendor_ref', 's.email as received_by', 'l.name as location_name',
      sql<string>`(select string_agg(coalesce(pv.sku, m.code) || ' × ' || trim_scale(gl.qty)::text, ', ' order by ln.position) from public.goods_receipt_lines gl
        join public.purchase_order_lines ln on ln.id = gl.purchase_order_line_id left join public.product_variants pv on pv.id = ln.variant_id
        left join public.materials m on m.id = ln.material_id where gl.goods_receipt_id = g.id)`.as('items')])
    .where('g.purchase_order_id', '=', id).orderBy('g.received_at').execute();
  const totalPaise = costs ? lines.reduce((n, l) => n + (l.unitCostPaise ?? 0) * l.ordered, 0) : undefined;
  return { order: { ...p, location }, lines, receipts, totalPaise, canSeeCosts: costs, next: [...PO_TRANSITIONS[p.status as PoStatus]] };
}

/** One goods receipt (GRN) with its lines, for its page and print-out. */
export async function getGoodsReceipt(db: Db, actor: StaffPrincipal, receiptId: string) {
  requirePermission(actor, 'procurement.read');
  const g = await db.selectFrom('goods_receipts as g').innerJoin('purchase_orders as po', 'po.id', 'g.purchase_order_id').innerJoin('vendors as v', 'v.id', 'po.vendor_id')
    .leftJoin('staff_users as s', 's.id', 'g.received_by').leftJoin('locations as l', 'l.id', 'g.location_id')
    .select(['g.id', 'g.receipt_number', 'g.received_at', 'g.note', 'g.vendor_ref', 's.email as received_by', 'l.name as location_name', 'po.id as po_id', 'po.po_number',
      'v.name as vendor', 'v.address as vendor_address', 'v.gstin as vendor_gstin', 'v.phone as vendor_phone'])
    .where('g.id', '=', receiptId).executeTakeFirst();
  if (!g) throw new NotFoundError('Goods receipt not found.');
  const costs = can(actor, 'costs.read');
  const lines = (await db.selectFrom('goods_receipt_lines as gl').innerJoin('purchase_order_lines as ln', 'ln.id', 'gl.purchase_order_line_id')
    .leftJoin('materials as m', 'm.id', 'ln.material_id').leftJoin('product_variants as pv', 'pv.id', 'ln.variant_id').leftJoin('products as p', 'p.id', 'pv.product_id')
    .select(['gl.id', 'gl.qty', 'ln.qty_ordered', 'ln.qty_received', 'ln.unit_cost_paise', 'pv.sku', 'm.code as material_code', 'm.unit', 'ln.variant_id', lineLabelSql.as('name')])
    .where('gl.goods_receipt_id', '=', receiptId).orderBy('ln.position').execute())
    .map(l => ({ id: l.id, name: l.name, code: (l.variant_id ? l.sku : l.material_code) ?? '', unit: l.variant_id ? 'pcs' : l.unit ?? '', qty: qty(l.qty),
      ordered: qty(l.qty_ordered), receivedSoFar: qty(l.qty_received), unitCostPaise: costs ? l.unit_cost_paise : undefined }));
  return { receipt: g, lines, canSeeCosts: costs, totalPaise: costs ? lines.reduce((n, l) => n + (l.unitCostPaise ?? 0) * l.qty, 0) : undefined };
}

export async function createPurchaseOrder(db: Db, actor: StaffPrincipal, input: { vendorId: string; expectedOn: string | null; notes: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('vendors').select(['id', 'is_active']).where('id', '=', input.vendorId).forShare().executeTakeFirst();
    if (!v) throw new NotFoundError('Vendor not found.');
    if (!v.is_active) throw new ConflictError('This vendor is inactive. Activate it first, or choose another.');
    const { n } = (await sql<{ n: string }>`select public.next_document_number('purchase_order', 'PO') as n`.execute(tx)).rows[0];
    const po = await tx.insertInto('purchase_orders').values({ po_number: n, vendor_id: v.id, expected_on: input.expectedOn, notes: input.notes, created_by: actor.staffId })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'purchase_order.create', entityType: 'purchase_orders', entityId: po.id, after: { po_number: n, vendor_id: v.id } });
    return { id: po.id, poNumber: n };
  });
}

/** Creates ONE draft purchase order for ONE vendor with SEVERAL lines, in one transaction (client change request). A line is a
    product size (finished goods, 2026-10-01) or a material. Every item must be active; product sizes are whole pieces. Costs are
    only taken from staff with costs.read. locationId: where product lines will be received (null = the online stock). */
export async function createPurchaseOrderWithLines(db: Db, actor: StaffPrincipal,
  input: { vendorId: string; expectedOn: string | null; notes: string | null; locationId?: string | null;
    lines: { materialId?: string | null; variantId?: string | null; qty: number; unitCostPaise: number | null }[] }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  if (!input.lines.length) throw new DomainError('invalid', 'Enter a quantity for at least one product or material.');
  const costs = can(actor, 'costs.read');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('vendors').select(['id', 'is_active']).where('id', '=', input.vendorId).forShare().executeTakeFirst();
    if (!v) throw new NotFoundError('Vendor not found.');
    if (!v.is_active) throw new ConflictError('This vendor is inactive. Activate it first, or choose another.');
    await checkLines(tx, input.lines);
    if (input.locationId) await checkReceivingLocation(tx, input.locationId);
    const { n } = (await sql<{ n: string }>`select public.next_document_number('purchase_order', 'PO') as n`.execute(tx)).rows[0];
    const po = await tx.insertInto('purchase_orders').values({ po_number: n, vendor_id: v.id, expected_on: input.expectedOn, notes: input.notes, created_by: actor.staffId,
      location_id: input.locationId ?? null }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('purchase_order_lines').values(input.lines.map((l, i) => ({ purchase_order_id: po.id, material_id: l.materialId ?? null, variant_id: l.variantId ?? null,
      qty_ordered: String(l.qty), unit_cost_paise: costs ? l.unitCostPaise : null, position: i }))).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'purchase_order.create', entityType: 'purchase_orders', entityId: po.id,
      after: { po_number: n, vendor_id: v.id, location_id: input.locationId ?? null, lines: input.lines.map(l => ({ material_id: l.materialId ?? null, variant_id: l.variantId ?? null, qty: l.qty })) },
      metadata: { costs_set: costs && input.lines.some(l => l.unitCostPaise !== null) } });
    return { id: po.id, poNumber: n, lines: input.lines.length };
  });
}

/** Every line is exactly one active product size (whole pieces) or one active material; no item twice. */
async function checkLines(tx: Tx, lines: { materialId?: string | null; variantId?: string | null; qty: number }[]) {
  for (const l of lines) {
    if (!!l.materialId === !!l.variantId) throw new DomainError('invalid', 'Each line is either a product size or a material.');
    if (!(l.qty > 0)) throw new DomainError('invalid', 'Enter a quantity above zero.');
    if (l.variantId && !Number.isInteger(l.qty)) throw new DomainError('invalid', 'Products are ordered in whole pieces.');
  }
  const mIds = lines.flatMap(l => l.materialId ? [l.materialId] : []), vIds = lines.flatMap(l => l.variantId ? [l.variantId] : []);
  if (new Set(mIds).size !== mIds.length || new Set(vIds).size !== vIds.length) throw new DomainError('invalid', 'An item appears twice: put its whole quantity on one line.');
  if (mIds.length) {
    const mats = await tx.selectFrom('materials').select(['id', 'is_active', 'name']).where('id', 'in', mIds).execute();
    if (mats.length !== mIds.length) throw new NotFoundError('One of the materials no longer exists. Reload and try again.');
    const inactive = mats.filter(m => !m.is_active);
    if (inactive.length) throw new ConflictError(`Inactive material: ${inactive.map(m => m.name).join(', ')}.`);
  }
  if (vIds.length) {
    const vs = await tx.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id').select(['v.id', 'v.sku', 'p.status']).where('v.id', 'in', vIds).execute();
    if (vs.length !== vIds.length) throw new NotFoundError('One of the product sizes no longer exists. Reload and try again.');
    const archived = vs.filter(x => x.status === 'archived');
    if (archived.length) throw new ConflictError(`Archived product: ${archived.map(x => x.sku).join(', ')}.`);
  }
}

async function checkReceivingLocation(tx: Tx, locationId: string) {
  const l = await tx.selectFrom('locations').select(['is_active', 'name']).where('id', '=', locationId).executeTakeFirst();
  if (!l) throw new NotFoundError('Location not found.');
  if (!l.is_active) throw new ConflictError(`${l.name} is inactive.`);
}

async function lockPo(tx: Tx, id: string) {
  const p = await tx.selectFrom('purchase_orders').select(['id', 'status', 'po_number']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!p) throw new NotFoundError('Purchase order not found.');
  return p as { id: string; status: PoStatus; po_number: string };
}

/** Adds (or replaces the quantity/cost of) a product-size or material line. Draft orders only. The cost is only taken from
    staff with costs.read. */
export async function setPoLine(db: Db, actor: StaffPrincipal, input: { purchaseOrderId: string; materialId?: string | null; variantId?: string | null; qty: number; unitCostPaise: number | null }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  const cost = can(actor, 'costs.read') ? input.unitCostPaise : undefined;
  return db.transaction().execute(async tx => {
    const p = await lockPo(tx, input.purchaseOrderId);
    if (p.status !== 'draft') throw new ConflictError('Lines can only be changed while the order is a draft.');
    await checkLines(tx, [input]);
    const cur = await tx.selectFrom('purchase_order_lines').select(['id', 'qty_ordered', 'unit_cost_paise']).where('purchase_order_id', '=', p.id)
      .$if(!!input.variantId, q => q.where('variant_id', '=', input.variantId!)).$if(!input.variantId, q => q.where('material_id', '=', input.materialId!)).executeTakeFirst();
    if (cur) {
      await tx.updateTable('purchase_order_lines').set({ qty_ordered: String(input.qty), ...(cost !== undefined && { unit_cost_paise: cost }) }).where('id', '=', cur.id).execute();
    } else {
      const { max } = await tx.selectFrom('purchase_order_lines').select(sql<number>`coalesce(max(position), -1)::int`.as('max')).where('purchase_order_id', '=', p.id).executeTakeFirstOrThrow();
      await tx.insertInto('purchase_order_lines').values({ purchase_order_id: p.id, material_id: input.materialId ?? null, variant_id: input.variantId ?? null,
        qty_ordered: String(input.qty), unit_cost_paise: cost ?? null, position: max + 1 }).execute();
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: cur ? 'purchase_order.line_update' : 'purchase_order.line_add', entityType: 'purchase_orders', entityId: p.id,
      before: cur ? { qty: qty(cur.qty_ordered) } : null, after: { material_id: input.materialId ?? null, variant_id: input.variantId ?? null, qty: input.qty }, metadata: { cost_set: cost !== undefined } });
  });
}

export async function removePoLine(db: Db, actor: StaffPrincipal, input: { purchaseOrderId: string; lineId: string }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  await db.transaction().execute(async tx => {
    const p = await lockPo(tx, input.purchaseOrderId);
    if (p.status !== 'draft') throw new ConflictError('Lines can only be changed while the order is a draft.');
    const r = await tx.deleteFrom('purchase_order_lines').where('id', '=', input.lineId).where('purchase_order_id', '=', p.id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw new NotFoundError('Line not found.');
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'purchase_order.line_remove', entityType: 'purchase_orders', entityId: p.id, metadata: { line_id: input.lineId } });
  });
}

/** Staff status moves (place the order, cancel it). Receiving changes the status by itself. */
export async function setPurchaseOrderStatus(db: Db, actor: StaffPrincipal, input: { purchaseOrderId: string; status: 'approved' | 'ordered' | 'cancelled' | 'closed' | 'draft'; expectedStatus: PoStatus; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  return db.transaction().execute(async tx => {
    const p = await lockPo(tx, input.purchaseOrderId);
    if (p.status !== input.expectedStatus) throw new ConflictError('This purchase order was changed by someone else since you opened the page. Reload and try again.');
    if (!PO_TRANSITIONS[p.status].includes(input.status)) throw new ConflictError(`A ${p.status.replace('_', ' ')} order cannot be moved to ${input.status}.`);
    if (NEEDS_APPROVAL(p.status, input.status)) requirePermission(actor, 'procurement.approve');
    if (input.status === 'closed') {
      const { open } = await tx.selectFrom('purchase_order_lines').select(sql<number>`count(*) filter (where qty_received < qty_ordered)::int`.as('open')).where('purchase_order_id', '=', p.id).executeTakeFirstOrThrow();
      if (open > 0 && !input.note) throw new DomainError('invalid', 'Part of this order has not arrived: give a short reason for closing it (nothing more will be received).');
    }
    if (input.status === 'ordered' || input.status === 'approved') {
      const { n } = await tx.selectFrom('purchase_order_lines').select(sql<number>`count(*)::int`.as('n')).where('purchase_order_id', '=', p.id).executeTakeFirstOrThrow();
      if (n === 0) throw new ConflictError('Add at least one product or material before approving or placing the order.');
    }
    if (input.status === 'cancelled') {
      if (!input.note) throw new DomainError('invalid', 'Give a short reason for cancelling.');
      const got = await tx.selectFrom('purchase_order_lines').select(sql<number>`count(*)::int`.as('n')).where('purchase_order_id', '=', p.id).where('qty_received', '>', '0').executeTakeFirstOrThrow();
      if (got.n > 0) throw new ConflictError('Part of this order has already been received, so it cannot be cancelled.');
    }
    const approvedNow = input.status === 'approved' || (p.status === 'draft' && input.status === 'ordered');
    await tx.updateTable('purchase_orders').set({ status: input.status, ...(input.status === 'ordered' && { ordered_at: sql<Date>`now()` }),
      ...(approvedNow && { approved_at: sql<Date>`now()`, approved_by: actor.staffId }), ...(input.status === 'draft' && { approved_at: null, approved_by: null }),
      ...(input.status === 'closed' && { closed_at: sql<Date>`now()`, closed_by: actor.staffId, close_note: input.note }) }).where('id', '=', p.id).execute();
    const verb = ({ approved: 'approve', ordered: 'place', cancelled: 'cancel', closed: 'close', draft: 'reopen' } as const)[input.status];
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: `purchase_order.${verb}`, entityType: 'purchase_orders', entityId: p.id,
      before: { status: p.status }, after: { status: input.status }, metadata: { note: input.note } });
  });
}

/** Records a delivery as a numbered goods receipt (GRN) linked to the order: each line's quantity (≤ what is still
    outstanding) goes into stock through the ledger — product sizes into product stock at the order's location (reason
    purchase_in, with the line's unit cost), materials into material stock. Only what actually arrived is added. */
export async function receiveGoods(db: Db, actor: StaffPrincipal, input: { purchaseOrderId: string; lines: { lineId: string; qty: number }[]; note: string | null; vendorRef?: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.receive');
  const lines = input.lines.filter(l => l.qty > 0);
  if (!lines.length) throw new DomainError('invalid', 'Enter the quantity received for at least one line.');
  try {
    return await db.transaction().execute(async tx => {
      const p = await lockPo(tx, input.purchaseOrderId);
      if (p.status !== 'ordered' && p.status !== 'partially_received') throw new ConflictError('Only orders sent to the vendor can be received.');
      const po = await tx.selectFrom('purchase_orders').select(['location_id']).where('id', '=', p.id).executeTakeFirstOrThrow();
      const location = po.location_id ?? (await tx.selectFrom('locations').select('id').where('is_online', '=', true).executeTakeFirstOrThrow()).id;
      const current = await tx.selectFrom('purchase_order_lines').select(['id', 'material_id', 'variant_id', 'qty_ordered', 'qty_received', 'unit_cost_paise']).where('purchase_order_id', '=', p.id).forUpdate().execute();
      const byId = new Map(current.map(c => [c.id, c]));
      for (const l of lines) {
        const c = byId.get(l.lineId);
        if (!c) throw new NotFoundError('One of the lines does not belong to this order.');
        if (c.variant_id && !Number.isInteger(l.qty)) throw new DomainError('invalid', 'Products are received in whole pieces.');
        if (l.qty > qty(c.qty_ordered) - qty(c.qty_received) + 1e-9) throw new ConflictError('More was entered than is still outstanding on a line.');
      }
      const { n } = (await sql<{ n: string }>`select public.next_document_number('goods_receipt', 'GRN') as n`.execute(tx)).rows[0];
      const g = await tx.insertInto('goods_receipts').values({ purchase_order_id: p.id, received_by: actor.staffId, note: input.note, receipt_number: n,
        vendor_ref: input.vendorRef?.trim() || null, location_id: location }).returning('id').executeTakeFirstOrThrow();
      for (const l of lines) {
        const c = byId.get(l.lineId)!;
        await tx.insertInto('goods_receipt_lines').values({ goods_receipt_id: g.id, purchase_order_line_id: c.id, qty: String(l.qty) }).execute();
        await tx.updateTable('purchase_order_lines').set({ qty_received: sql`qty_received + ${String(l.qty)}::numeric` }).where('id', '=', c.id).execute();
        if (c.variant_id) {
          const r = await sql<{ movement_id: number }>`select movement_id from public.adjust_location_stock(${c.variant_id}::uuid, ${location}::uuid, ${l.qty}::int, 'purchase_in',
            ${actor.staffId}::uuid, ${p.po_number + ' · ' + n}::text, null)`.execute(tx);
          await sql`select public.link_movement_receipt(${r.rows[0].movement_id}::bigint, ${g.id}::uuid, ${c.unit_cost_paise}::int)`.execute(tx);
        } else {
          await materialLedger(tx, c.material_id!, l.qty, 'receipt', actor.staffId, `${p.po_number}`, g.id);
        }
      }
      const { open } = await tx.selectFrom('purchase_order_lines').select(sql<number>`count(*) filter (where qty_received < qty_ordered)::int`.as('open')).where('purchase_order_id', '=', p.id).executeTakeFirstOrThrow();
      const status: PoStatus = open === 0 ? 'received' : 'partially_received';
      if (status !== p.status) await tx.updateTable('purchase_orders').set({ status }).where('id', '=', p.id).execute();
      await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'purchase_order.receive', entityType: 'purchase_orders', entityId: p.id,
        before: { status: p.status }, after: { status }, metadata: { goods_receipt_id: g.id, receipt_number: n, location_id: location, lines: lines.map(l => ({ line_id: l.lineId, qty: l.qty })) } });
      return { receiptId: g.id, receiptNumber: n, status };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '55000') throw new ConflictError('The receiving location is inactive.');
    throw e;
  }
}

// ---------------------------------------------------------------- vendors ↔ finished products (2026-10-01)
/** The products a vendor supplies (finished goods), and every product that is not archived, to choose from. */
export async function vendorProducts(db: Db, actor: StaffPrincipal, vendorId: string) {
  requirePermission(actor, 'procurement.read');
  const [linked, all] = await Promise.all([
    db.selectFrom('vendor_products as vp').innerJoin('products as p', 'p.id', 'vp.product_id').select(['p.id', 'p.sku', 'p.name', 'p.status', 'vp.vendor_sku', 'vp.created_at'])
      .where('vp.vendor_id', '=', vendorId).orderBy('p.name').execute(),
    db.selectFrom('products').select(['id', 'sku', 'name', 'status']).where('status', '!=', 'archived').orderBy('name').execute(),
  ]);
  return { linked, all };
}

/** Every vendor ↔ product link plus the products to choose from, in two queries (for the vendors list). */
export async function vendorProductLinks(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'procurement.read');
  const [links, products] = await Promise.all([
    db.selectFrom('vendor_products').select(['vendor_id', 'product_id']).execute(),
    db.selectFrom('products').select(['id', 'sku', 'name', 'status']).where('status', '!=', 'archived').orderBy('name').execute(),
  ]);
  const byVendor = new Map<string, string[]>();
  for (const l of links) byVendor.set(l.vendor_id, [...(byVendor.get(l.vendor_id) ?? []), l.product_id]);
  return { byVendor, products };
}

/** Sets the products a vendor supplies in one go (several selected at once). Audited with what was added and removed. */
export async function setVendorProducts(db: Db, actor: StaffPrincipal, input: { vendorId: string; productIds: string[] }, ctx: MutationContext) {
  requirePermission(actor, 'procurement.manage');
  const want = [...new Set(input.productIds)].slice(0, 500);
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('vendors').select('id').where('id', '=', input.vendorId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Vendor not found.');
    if (want.length) {
      const found = await tx.selectFrom('products').select('id').where('id', 'in', want).execute();
      if (found.length !== want.length) throw new NotFoundError('One of the products no longer exists. Reload and try again.');
    }
    const have = (await tx.selectFrom('vendor_products').select('product_id').where('vendor_id', '=', v.id).execute()).map(r => r.product_id);
    const add = want.filter(id => !have.includes(id)), remove = have.filter(id => !want.includes(id));
    if (remove.length) await tx.deleteFrom('vendor_products').where('vendor_id', '=', v.id).where('product_id', 'in', remove).execute();
    if (add.length) await tx.insertInto('vendor_products').values(add.map(product_id => ({ vendor_id: v.id, product_id, created_by: actor.staffId }))).execute();
    if (add.length || remove.length) await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'vendor.products', entityType: 'vendors', entityId: v.id, before: { products: have }, after: { products: want }, metadata: { added: add, removed: remove } });
    return { added: add.length, removed: remove.length, total: want.length };
  });
}

export async function materialMovements(db: Db, actor: StaffPrincipal, materialId: string) {
  requirePermission(actor, 'procurement.read');
  return (await db.selectFrom('material_movements as mv').leftJoin('staff_users as s', 's.id', 'mv.staff_id')
    .select(['mv.id', 'mv.created_at', 'mv.delta', 'mv.balance_after', 'mv.reason', 'mv.note', 's.email as staff_email'])
    .where('mv.material_id', '=', materialId).orderBy('mv.id', 'desc').limit(50).execute())
    .map(r => ({ ...r, delta: qty(r.delta), balance_after: qty(r.balance_after) }));
}

/** Product sizes that can be put on a purchase order (products not archived), with their stock and whether the given vendor
    supplies the product (vendor_products), for the new-order form. */
export async function purchasableSizes(db: Db, actor: StaffPrincipal, vendorId?: string | null) {
  requirePermission(actor, 'procurement.read');
  const supplied = vendorId ? new Set((await db.selectFrom('vendor_products').select('product_id').where('vendor_id', '=', vendorId).execute()).map(r => r.product_id)) : new Set<string>();
  const rows = await db.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['v.id', 'v.sku', 'v.size', 'v.stock_qty', 'p.id as product_id', 'p.name', sql<string | null>`(select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = v.colour_slug)`.as('colour')])
    .where('p.status', '!=', 'archived').orderBy('p.name').orderBy('v.colour_slug').orderBy('v.sort_order').execute();
  return rows.map(r => ({ id: r.id, sku: r.sku, label: `${r.name} · ${r.colour ? `${r.colour} / ` : ''}${r.size}`, stock: r.stock_qty, supplied: supplied.has(r.product_id) }));
}
