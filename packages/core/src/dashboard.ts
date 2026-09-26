/* Dashboard figures. Every number is computed from live rows or the M2 reporting views at request time. */
import { sql, type Db } from '@kitsyuu/db';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { recentAudit } from './audit.ts';

const n = sql<number>`count(*)::int`;

export async function getDashboard(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'dashboard.read');
  const [products, variants, lowStock, orders, sales, today, customers, staff] = await Promise.all([
    db.selectFrom('products').select([n.as('total'), sql<number>`(count(*) filter (where status = 'active'))::int`.as('active')]).executeTakeFirstOrThrow(),
    db.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
      .select([sql<number>`(count(*) filter (where v.is_active and p.status = 'active'))::int`.as('sellable'),
        sql<number>`coalesce(sum(v.stock_qty) filter (where v.is_active and p.status = 'active'), 0)::int`.as('units')]).executeTakeFirstOrThrow(),
    db.selectFrom('v_low_stock').select(['variant_id', 'variant_sku', 'product_name', 'size', 'stock_qty', 'reorder_level', 'stock_status'])
      .orderBy('stock_qty').orderBy('variant_sku').limit(8).execute(),
    db.selectFrom('orders').select([n.as('total'),
      sql<number>`(count(*) filter (where status in ('pending_payment', 'paid', 'processing')))::int`.as('open')]).executeTakeFirstOrThrow(),
    db.selectFrom('v_sales_daily').select([sql<number>`coalesce(sum(revenue_paise), 0)::bigint`.as('revenue'),
      sql<number>`coalesce(sum(orders_count), 0)::int`.as('paid_orders')]).executeTakeFirstOrThrow(),
    db.selectFrom('v_sales_daily').select(sql<number>`coalesce(sum(revenue_paise), 0)::bigint`.as('revenue'))
      .where('sales_date', '=', sql<Date>`(now() at time zone 'Asia/Kolkata')::date`).executeTakeFirstOrThrow(),
    db.selectFrom('customers').select([n.as('total'), sql<number>`(count(*) filter (where status = 'active'))::int`.as('active')]).executeTakeFirstOrThrow(),
    db.selectFrom('staff_users').select([sql<number>`(count(*) filter (where status = 'active'))::int`.as('active'),
      sql<number>`(count(*) filter (where status = 'invited'))::int`.as('invited')]).executeTakeFirstOrThrow(),
  ]);
  const lowStockCount = (await db.selectFrom('v_low_stock').select(n.as('n')).executeTakeFirstOrThrow()).n;
  return {
    products, variants, orders, customers, staff,
    revenue: { totalPaise: Number(sales.revenue), todayPaise: Number(today.revenue), paidOrders: sales.paid_orders },
    lowStock: { count: lowStockCount, rows: lowStock },
    recentAudit: can(actor, 'audit.read') ? await recentAudit(db, actor) : null,
    generatedAt: new Date(),
  };
}
