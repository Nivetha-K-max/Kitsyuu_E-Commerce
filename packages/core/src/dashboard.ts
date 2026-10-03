/* Dashboard figures. Every number is computed from live rows or the M2 reporting views at request time. */
import { sql, type Db } from '@kitsyuu/db';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
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
    generatedAt: new Date(),
  };
}

/* Dashboard trends (admin redesign, read-only): the last 30 business days (India time) against the 30 before, using the
   same "sold" rule as Reports (paid, processing, shipped, delivered). Nothing is estimated: a day with no sales is 0,
   and a change is shown only when the previous period had something to compare with. */
export const TREND_DAYS = 30;
const SOLD = sql`o.status in ('paid', 'processing', 'shipped', 'delivered')`;
const istDay = sql`(o.created_at at time zone 'Asia/Kolkata')::date`;
const today = sql`(now() at time zone 'Asia/Kolkata')::date`;

export interface TrendPoint { day: string; revenue: number; orders: number; units: number; newCustomers: number; prevRevenue: number }
export interface PeriodTotals { revenue: number; orders: number; units: number; newCustomers: number; averageOrder: number }

export async function dashboardTrends(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'dashboard.read');
  const span = TREND_DAYS * 2 - 1;
  const [sales, signups, top, cats, days] = await Promise.all([
    sql<{ day: string; revenue: number; orders: number; units: number }>`
      select ${istDay}::text as day, coalesce(sum(o.total_paise), 0)::float8 as revenue, count(*)::int as orders,
        coalesce(sum((select sum(i.qty) from public.order_items i where i.order_id = o.id)), 0)::int as units
      from public.orders o where ${SOLD} and ${istDay} between ${today} - ${span}::int and ${today}
      group by 1`.execute(db),
    sql<{ day: string; n: number }>`
      select (c.created_at at time zone 'Asia/Kolkata')::date::text as day, count(*)::int as n from public.customers c
      where (c.created_at at time zone 'Asia/Kolkata')::date between ${today} - ${span}::int and ${today} group by 1`.execute(db),
    sql<{ product_id: string | null; name: string; units: number; revenue: number; image: string | null; category: string | null }>`
      select i.product_id, max(i.name) as name, sum(i.qty)::int as units, sum(i.line_total_paise)::float8 as revenue,
        (select pi.storage_path from public.product_images pi where pi.product_id = i.product_id order by pi.is_primary desc, pi.sort_order limit 1) as image,
        (select c.label from public.products p join public.categories c on c.id = p.category_id where p.id = i.product_id) as category
      from public.order_items i join public.orders o on o.id = i.order_id
      where ${SOLD} and ${istDay} between ${today} - ${TREND_DAYS - 1}::int and ${today}
      group by i.product_id order by units desc, revenue desc limit 5`.execute(db),
    sql<{ category: string; revenue: number }>`
      select coalesce(c.label, 'Other') as category, sum(i.line_total_paise)::float8 as revenue
      from public.order_items i join public.orders o on o.id = i.order_id
      left join public.products p on p.id = i.product_id left join public.categories c on c.id = p.category_id
      where ${SOLD} and ${istDay} between ${today} - ${TREND_DAYS - 1}::int and ${today}
      group by 1 order by 2 desc`.execute(db),
    sql<{ day: string }>`select (${today} - g)::text as day from generate_series(0, ${span}::int) g order by 1`.execute(db),
  ]);
  const byDay = new Map(sales.rows.map(r => [r.day, r]));
  const joins = new Map(signups.rows.map(r => [r.day, r.n]));
  const all = days.rows.map(({ day }) => ({ day, revenue: byDay.get(day)?.revenue ?? 0, orders: byDay.get(day)?.orders ?? 0,
    units: byDay.get(day)?.units ?? 0, newCustomers: joins.get(day) ?? 0 }));
  const prev = all.slice(0, TREND_DAYS), cur = all.slice(TREND_DAYS);
  const total = (xs: typeof all): PeriodTotals => {
    const t = xs.reduce((a, x) => ({ revenue: a.revenue + x.revenue, orders: a.orders + x.orders, units: a.units + x.units, newCustomers: a.newCustomers + x.newCustomers }),
      { revenue: 0, orders: 0, units: 0, newCustomers: 0 });
    return { ...t, averageOrder: t.orders ? Math.round(t.revenue / t.orders) : 0 };
  };
  return {
    days: TREND_DAYS,
    series: cur.map((x, i): TrendPoint => ({ ...x, prevRevenue: prev[i]!.revenue })),
    current: total(cur), previous: total(prev),
    topProducts: top.rows.map(r => ({ productId: r.product_id, name: r.name, units: r.units, revenue: r.revenue, image: r.image, category: r.category })),
    byCategory: cats.rows,
  };
}
