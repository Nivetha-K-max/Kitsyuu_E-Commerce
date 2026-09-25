-- KITSYUU platform M2: reporting views (additive only). Every figure is computed from live rows; nothing is stored.
-- security_invoker = true: a view runs with the caller's privileges and RLS, so it can never expose more than the
-- underlying tables allow (Postgres views otherwise run as their owner).
-- Paid = orders whose status is paid, processing, shipped or delivered. Dates use the Asia/Kolkata business day.
-- Safe to re-run (create or replace).

create or replace view public.v_sales_daily with (security_invoker = true) as
select
  (coalesce(o.paid_at, o.created_at) at time zone 'Asia/Kolkata')::date as sales_date,
  count(*)::int                                                         as orders_count,
  coalesce(sum(items.units), 0)::int                                    as units_sold,
  coalesce(sum(o.subtotal_paise), 0)::bigint                            as subtotal_paise,
  coalesce(sum(o.total_paise), 0)::bigint                               as revenue_paise
from public.orders o
left join lateral (select sum(i.qty) as units from public.order_items i where i.order_id = o.id) items on true
where o.status in ('paid', 'processing', 'shipped', 'delivered')
group by 1;

create or replace view public.v_inventory_status with (security_invoker = true) as
with threshold as (
  select coalesce((select (s.value #>> '{}')::int from public.settings s where s.key = 'inventory.low_stock_threshold'), 0) as qty
)
select
  v.id                                  as variant_id,
  v.sku                                 as variant_sku,
  v.size,
  v.product_id,
  p.sku                                 as product_sku,
  p.name                                as product_name,
  p.status                              as product_status,
  p.category_id,
  v.is_active,
  v.stock_qty,
  coalesce(v.reorder_level, t.qty)      as reorder_level,
  case when v.stock_qty = 0 then 'out_of_stock'
       when v.stock_qty <= coalesce(v.reorder_level, t.qty) then 'low_stock'
       else 'in_stock' end              as stock_status,
  (select max(m.created_at) from public.inventory_movements m where m.variant_id = v.id) as last_movement_at
from public.product_variants v
join public.products p on p.id = v.product_id
cross join threshold t;

-- Sellable variants (active variant of an active product) that are out of stock or at/below their reorder level.
create or replace view public.v_low_stock with (security_invoker = true) as
select * from public.v_inventory_status
where is_active and product_status = 'active' and stock_status <> 'in_stock';

-- Orders count towards a customer through customer_id, or (until M6 links them) through the legacy Supabase Auth
-- user id, which is the same UUID.
create or replace view public.v_customer_summary with (security_invoker = true) as
select
  c.id                                                                                     as customer_id,
  c.email,
  c.full_name,
  c.status,
  c.created_at,
  c.last_login_at,
  count(o.id)::int                                                                         as orders_count,
  (count(o.id) filter (where o.status in ('paid', 'processing', 'shipped', 'delivered')))::int as paid_orders_count,
  coalesce(sum(o.total_paise) filter (where o.status in ('paid', 'processing', 'shipped', 'delivered')), 0)::bigint as lifetime_value_paise,
  max(o.created_at)                                                                        as last_order_at
from public.customers c
left join public.orders o on o.customer_id = c.id or (o.customer_id is null and o.user_id = c.legacy_auth_user_id)
group by c.id;

revoke all on public.v_sales_daily, public.v_inventory_status, public.v_low_stock, public.v_customer_summary from anon, authenticated;
