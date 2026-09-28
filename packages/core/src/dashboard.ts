/* Dashboard figures. Every number is computed from live rows or the M2 reporting views at request time. */
import { sql, type Db } from '@kitsyuu/db';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { recentAudit } from './audit.ts';
import { listPaymentExceptions } from './payments-admin.ts';

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
    db.selectFrom('customers').select([n.as('total'), sql<number>`(count(*) filter (where status = 'active'))::int`.as('active'),
      sql<number>`(count(*) filter (where status = 'disabled'))::int`.as('disabled')]).executeTakeFirstOrThrow(),
    db.selectFrom('staff_users').select([sql<number>`(count(*) filter (where status = 'active'))::int`.as('active'),
      sql<number>`(count(*) filter (where status = 'invited'))::int`.as('invited')]).executeTakeFirstOrThrow(),
  ]);
  const lowStockCount = (await db.selectFrom('v_low_stock').select(n.as('n')).executeTakeFirstOrThrow()).n;
  // M8 fulfilment: paid and processing orders still to ship (with packing progress), shipped and delivered.
  const fulfilment = await db.selectFrom('orders as o').leftJoin('shipments as sh', 'sh.order_id', 'o.id').select([
    sql<number>`(count(*) filter (where o.status in ('paid', 'processing')))::int`.as('awaiting'),
    sql<number>`(count(*) filter (where o.status = 'paid'))::int`.as('paid'),
    sql<number>`(count(*) filter (where o.status = 'processing' and coalesce(sh.packing_state, 'not_started') = 'not_started'))::int`.as('not_started'),
    sql<number>`(count(*) filter (where o.status = 'processing' and sh.packing_state = 'packing'))::int`.as('packing'),
    sql<number>`(count(*) filter (where o.status = 'processing' and sh.packing_state = 'packed'))::int`.as('packed'),
    sql<number>`(count(*) filter (where o.status = 'shipped'))::int`.as('shipped'),
    sql<number>`(count(*) filter (where o.status = 'delivered'))::int`.as('delivered'),
    sql<number>`(count(*) filter (where o.status = 'shipped' and sh.tracking_number is null))::int`.as('shipped_without_tracking'),
  ]).executeTakeFirstOrThrow();
  // M8 payments (billing.read): orders waiting for payment, and payment exceptions not yet handled.
  const payments = can(actor, 'billing.read') ? {
    pending: (await db.selectFrom('orders').select(n.as('n')).where('status', '=', 'pending_payment').executeTakeFirstOrThrow()).n,
    exceptions: (await listPaymentExceptions(db)).filter(e => !e.manualRefund).length,
  } : null;
  return {
    products, variants, orders, customers, staff, fulfilment, payments,
    revenue: { totalPaise: Number(sales.revenue), todayPaise: Number(today.revenue), paidOrders: sales.paid_orders },
    lowStock: { count: lowStockCount, rows: lowStock },
    recentAudit: can(actor, 'audit.read') ? await recentAudit(db, actor) : null,
    generatedAt: new Date(),
  };
}
