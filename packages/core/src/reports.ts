/* M16: report screens over data the platform already records. Nothing is estimated: sales count only orders that were
   paid (paid, processing, shipped, delivered; refunded orders are excluded), money is integer paise, dates are business
   days in Asia/Kolkata. Purchasing spend needs costs.read as well as reports.read. Every report can be exported as CSV
   (formula-safe cells); exports are audited. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { DomainError } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export const SOLD_STATUSES = ['paid', 'processing', 'shipped', 'delivered'] as const;
export type ReportRange = { from: string; to: string };           // inclusive business dates (YYYY-MM-DD)
export const REPORTS = ['sales', 'products', 'inventory', 'customers', 'purchasing', 'production'] as const;
export type ReportKind = typeof REPORTS[number];

const day = sql`(o.created_at at time zone 'Asia/Kolkata')::date`;
export function checkRange(r: ReportRange) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.from > r.to) throw new DomainError('invalid', 'Choose a valid date range.');
  if ((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 > 3660) throw new DomainError('invalid', 'Choose a range of at most ten years.');
}

export async function salesReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); checkRange(r);
  const rows = (await sql<{ day: string; orders: number; units: number; revenue: number }>`
    select ${day}::text as day, count(*)::int as orders,
      coalesce(sum((select sum(i.qty) from public.order_items i where i.order_id = o.id)), 0)::int as units,
      coalesce(sum(o.total_paise), 0)::bigint::float8 as revenue
    from public.orders o where o.status in ('paid', 'processing', 'shipped', 'delivered') and ${day} between ${r.from}::date and ${r.to}::date
    group by 1 order by 1`.execute(db)).rows;
  const t = rows.reduce((a, x) => ({ orders: a.orders + x.orders, units: a.units + x.units, revenue: a.revenue + x.revenue }), { orders: 0, units: 0, revenue: 0 });
  return { rows, totals: { ...t, averageOrderPaise: t.orders ? Math.round(t.revenue / t.orders) : 0 } };
}

export async function productReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); checkRange(r);
  const rows = (await sql<{ sku: string; name: string; category: string; units: number; revenue: number }>`
    select i.sku, i.name, coalesce(c.label, '—') as category, sum(i.qty)::int as units, sum(i.line_total_paise)::bigint::float8 as revenue
    from public.order_items i join public.orders o on o.id = i.order_id
    left join public.products p on p.id = i.product_id left join public.categories c on c.id = p.category_id
    where o.status in ('paid', 'processing', 'shipped', 'delivered') and ${day} between ${r.from}::date and ${r.to}::date
    group by i.sku, i.name, c.label order by units desc, revenue desc, i.sku limit 500`.execute(db)).rows;
  const byCategory = Object.values(rows.reduce<Record<string, { category: string; units: number; revenue: number }>>((m, x) => {
    const k = x.category; m[k] ??= { category: k, units: 0, revenue: 0 }; m[k].units += x.units; m[k].revenue += x.revenue; return m;
  }, {})).sort((a, b) => b.revenue - a.revenue);
  return { rows, byCategory };
}

export async function inventoryReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); checkRange(r);
  const stock = (await sql<{ category: string; sizes: number; units: number; out_of_stock: number }>`
    select coalesce(c.label, '—') as category, count(v.id)::int as sizes, coalesce(sum(v.stock_qty), 0)::int as units,
      count(*) filter (where v.stock_qty = 0 and v.is_active)::int as out_of_stock
    from public.product_variants v join public.products p on p.id = v.product_id left join public.categories c on c.id = p.category_id
    where p.status <> 'archived' group by 1 order by 1`.execute(db)).rows;
  const movements = (await sql<{ reason: string; label: string; movements: number; units_in: number; units_out: number }>`
    select m.reason, coalesce(rs.label, m.reason) as label, count(*)::int as movements,
      coalesce(sum(m.delta) filter (where m.delta > 0), 0)::int as units_in, coalesce(-sum(m.delta) filter (where m.delta < 0), 0)::int as units_out
    from public.inventory_movements m left join public.inventory_reasons rs on rs.code = m.reason
    where (m.created_at at time zone 'Asia/Kolkata')::date between ${r.from}::date and ${r.to}::date
    group by m.reason, rs.label order by 3 desc`.execute(db)).rows;
  return { stock, movements };
}

export async function customerReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); requirePermission(actor, 'customers.read'); checkRange(r);
  const x = (await sql<{ new_customers: number; buyers: number; returning_buyers: number }>`
    with buyers as (
      select o.customer_id, count(*) as n_in_range,
        exists (select 1 from public.orders p where p.customer_id = o.customer_id and p.status in ('paid', 'processing', 'shipped', 'delivered')
          and (p.created_at at time zone 'Asia/Kolkata')::date < ${r.from}::date) as bought_before
      from public.orders o where o.customer_id is not null and o.status in ('paid', 'processing', 'shipped', 'delivered')
        and ${day} between ${r.from}::date and ${r.to}::date group by o.customer_id)
    select (select count(*)::int from public.customers c where (c.created_at at time zone 'Asia/Kolkata')::date between ${r.from}::date and ${r.to}::date) as new_customers,
      (select count(*)::int from buyers) as buyers,
      (select count(*)::int from buyers where bought_before or n_in_range > 1) as returning_buyers`.execute(db)).rows[0];
  return x;
}

export async function purchasingReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); requirePermission(actor, 'procurement.read'); checkRange(r);
  const costs = can(actor, 'costs.read');
  const rows = (await sql<{ vendor: string; orders: number; lines: number; spend: number | null }>`
    select v.name as vendor, count(distinct o.id)::int as orders, count(l.id)::int as lines,
      sum(l.unit_cost_paise * l.qty_ordered)::float8 as spend
    from public.purchase_orders o join public.vendors v on v.id = o.vendor_id left join public.purchase_order_lines l on l.purchase_order_id = o.id
    where o.status in ('ordered', 'partially_received', 'received') and (o.ordered_at at time zone 'Asia/Kolkata')::date between ${r.from}::date and ${r.to}::date
    group by v.name order by 4 desc nulls last, 1`.execute(db)).rows;
  return { rows: rows.map(x => ({ ...x, spend: costs ? (x.spend === null ? null : Math.round(x.spend)) : undefined })), costs };
}

export async function productionReport(db: Db, actor: StaffPrincipal, r: ReportRange) {
  requirePermission(actor, 'reports.read'); requirePermission(actor, 'production.read'); checkRange(r);
  const rows = (await sql<{ sku: string; name: string; size: string; orders: number; passed: number; rejected: number }>`
    select p.sku, p.name, v.size, count(*)::int as orders, sum(q.qty_passed)::int as passed, sum(q.qty_rejected)::int as rejected
    from public.qc_results q join public.production_orders o on o.id = q.production_order_id
    join public.product_variants v on v.id = o.variant_id join public.products p on p.id = v.product_id
    where (q.inspected_at at time zone 'Asia/Kolkata')::date between ${r.from}::date and ${r.to}::date
    group by p.sku, p.name, v.size, v.sort_order order by p.sku, v.sort_order`.execute(db)).rows;
  const t = rows.reduce((a, x) => ({ passed: a.passed + x.passed, rejected: a.rejected + x.rejected }), { passed: 0, rejected: 0 });
  return { rows, totals: { ...t, passRate: t.passed + t.rejected ? t.passed / (t.passed + t.rejected) : null } };
}

// ---------------------------------------------------------------- CSV
export const csvCell = (v: unknown) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;                       // never let a spreadsheet run a cell as a formula
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const rupees = (p: number | null | undefined) => (p === null || p === undefined ? '' : (p / 100).toFixed(2));

/** A report as CSV (money in rupees with two decimals). Audited as report.export. */
export async function exportReport(db: Db, actor: StaffPrincipal, kind: ReportKind, r: ReportRange, ctx: MutationContext) {
  let head: string[], lines: unknown[][];
  switch (kind) {
    case 'sales': { const s = await salesReport(db, actor, r); head = ['date', 'orders', 'units', 'revenue_inr']; lines = s.rows.map(x => [x.day, x.orders, x.units, rupees(x.revenue)]); break; }
    case 'products': { const s = await productReport(db, actor, r); head = ['sku', 'name', 'category', 'units', 'revenue_inr']; lines = s.rows.map(x => [x.sku, x.name, x.category, x.units, rupees(x.revenue)]); break; }
    case 'inventory': { const s = await inventoryReport(db, actor, r); head = ['reason', 'movements', 'units_in', 'units_out']; lines = s.movements.map(x => [x.label, x.movements, x.units_in, x.units_out]); break; }
    case 'customers': { const s = await customerReport(db, actor, r); head = ['new_customers', 'buyers', 'returning_buyers']; lines = [[s.new_customers, s.buyers, s.returning_buyers]]; break; }
    case 'purchasing': { const s = await purchasingReport(db, actor, r); head = ['vendor', 'orders', 'lines', ...(s.costs ? ['spend_inr'] : [])]; lines = s.rows.map(x => [x.vendor, x.orders, x.lines, ...(s.costs ? [rupees(x.spend)] : [])]); break; }
    case 'production': { const s = await productionReport(db, actor, r); head = ['sku', 'name', 'size', 'orders', 'passed', 'rejected']; lines = s.rows.map(x => [x.sku, x.name, x.size, x.orders, x.passed, x.rejected]); break; }
  }
  await db.transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'report.export', entityType: 'reports', entityId: kind,
    metadata: { from: r.from, to: r.to, rows: lines.length }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null }));
  return { csv: [head, ...lines].map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n', rows: lines.length };
}
