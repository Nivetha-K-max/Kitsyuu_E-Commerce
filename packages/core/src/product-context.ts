/* What belongs to one product beyond its own record (2026-10-07), for the product page's Sales, Reviews, Production and
   Activity tabs. Read only: every figure comes from rows the platform already keeps (order lines, reviews, production
   orders, the audit log); nothing is stored or estimated. Each function checks the permission of the module the data
   belongs to, so a tab shows exactly what its own module would show. */
import { sql, type Db } from '@kitsyuu/db';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { SOLD_STATUSES } from './reports.ts';

/** Sales of one product: only paid orders count (the same rule as Reports). */
export async function productSales(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'orders.read');
  const sold = sql`o.status in (${sql.join(SOLD_STATUSES.map(s => sql.lit(s)))})`;
  const [totals, bySize, recent] = await Promise.all([
    sql<{ orders: number; units: number; revenue: number; units30: number; revenue30: number; first_at: Date | null; last_at: Date | null }>`
      select count(distinct o.id)::int as orders, coalesce(sum(i.qty), 0)::int as units, coalesce(sum(i.line_total_paise), 0)::bigint::float8 as revenue,
        coalesce(sum(i.qty) filter (where o.created_at > now() - interval '30 days'), 0)::int as units30,
        coalesce(sum(i.line_total_paise) filter (where o.created_at > now() - interval '30 days'), 0)::bigint::float8 as revenue30,
        min(o.created_at) as first_at, max(o.created_at) as last_at
      from public.order_items i join public.orders o on o.id = i.order_id where i.product_id = ${productId} and ${sold}`.execute(db).then(r => r.rows[0]),
    sql<{ sku: string; size: string; colour: string | null; units: number; revenue: number }>`
      select i.sku, i.size, i.colour, sum(i.qty)::int as units, sum(i.line_total_paise)::bigint::float8 as revenue
      from public.order_items i join public.orders o on o.id = i.order_id where i.product_id = ${productId} and ${sold}
      group by i.sku, i.size, i.colour order by units desc, i.sku`.execute(db).then(r => r.rows),
    // The latest orders that contain it, whatever their state (an unpaid or cancelled order is shown as such, not counted above).
    sql<{ order_id: string; order_number: string; created_at: Date; status: string; payment_status: string | null; payment_method: string | null; cod_status: string | null;
      size: string; qty: number; line_total_paise: number; customer: string | null }>`
      select o.id as order_id, o.order_number, o.created_at, o.status, o.payment_status, o.payment_method, o.cod_status, i.size, i.qty, i.line_total_paise,
        coalesce(o.contact->>'name', o.contact->>'email') as customer
      from public.order_items i join public.orders o on o.id = i.order_id where i.product_id = ${productId}
      order by o.created_at desc, i.sku limit 20`.execute(db).then(r => r.rows),
  ]);
  return { totals, bySize, recent };
}

/** Every review of one product (any state), newest first, with the count per state and the approved average. */
export async function productReviews(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'reviews.read');
  const rows = await db.selectFrom('reviews as r').innerJoin('customers as c', 'c.id', 'r.customer_id')
    .select(['r.id', 'r.rating', 'r.title', 'r.body', 'r.display_name', 'r.status', 'r.moderation_note', 'r.created_at', 'r.variant_label', 'c.email as customer_email'])
    .where('r.product_id', '=', productId).orderBy('r.created_at', 'desc').limit(100).execute();
  const approved = rows.filter(r => r.status === 'approved');
  return { rows, counts: { pending: rows.filter(r => r.status === 'pending').length, approved: approved.length, rejected: rows.filter(r => r.status === 'rejected').length },
    average: approved.length ? Math.round(approved.reduce((n, r) => n + r.rating, 0) / approved.length * 10) / 10 : null };
}

/** Production orders for any size of one product, newest first. */
export async function productProduction(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'production.read');
  return db.selectFrom('production_orders as o').innerJoin('product_variants as v', 'v.id', 'o.variant_id').leftJoin('qc_results as r', 'r.production_order_id', 'o.id')
    .select(['o.id', 'o.number', 'o.status', 'o.qty_planned', 'o.due_on', 'o.created_at', 'o.completed_at', 'o.batch_ref', 'v.size', 'v.sku as variant_sku', 'r.qty_passed', 'r.qty_rejected',
      sql<string | null>`(select string_agg(po.po_number, ', ' order by po.po_number) from public.production_purchase_orders x join public.purchase_orders po on po.id = x.purchase_order_id where x.production_order_id = o.id)`.as('purchase_orders')])
    .where('v.product_id', '=', productId).orderBy('o.created_at', 'desc').limit(100).execute();
}

/** The audit log entries about one product, its sizes and its images, newest first. */
export async function productActivity(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'audit.read');
  return (await sql<{ id: number; occurred_at: Date; actor_type: string; action: string; entity_type: string; staff_email: string | null; before_data: unknown; after_data: unknown; metadata: unknown }>`
    select a.id, a.occurred_at, a.actor_type, a.action, a.entity_type, s.email as staff_email, a.before_data, a.after_data, a.metadata
    from public.audit_logs a left join public.staff_users s on s.id = a.staff_id
    where (a.entity_type = 'products' and a.entity_id::text = ${productId})
       or (a.entity_type = 'product_variants' and a.entity_id::text in (select v.id::text from public.product_variants v where v.product_id = ${productId}))
       or (a.entity_type = 'product_images' and (a.entity_id::text in (select i.id::text from public.product_images i where i.product_id = ${productId}) or a.metadata->>'product_id' = ${productId}))
    order by a.occurred_at desc, a.id desc limit 100`.execute(db)).rows;
}
