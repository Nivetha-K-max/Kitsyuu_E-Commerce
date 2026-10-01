-- Purchasing finished products, product approval, bulk-edit drafts and related workflows (2026-10-01). Additive only:
-- nothing existing is changed or deleted; every existing purchase order, receipt, product, review and delivery rate keeps
-- its values (material lines stay material lines; active products stay active; rates stay delivery rates).
--
-- A. Vendors supply FINISHED products: vendor_products links a vendor to the products it supplies (many at once).
-- B. Purchase orders can buy product sizes (variant lines) as well as materials. Receiving a product line adds the stock at
--    the order's receiving location through the stock ledger (reason purchase_in), linked to the goods receipt.
--    New steps: approved (between draft and ordered = sent) and closed (after received, or to stop a partly received order).
--    Each goods receipt gets its own number (GRN/…), the vendor's delivery note / invoice reference and its location.
-- C. Products: a draft can be submitted for approval ('review'); only staff with products.publish make it active (published).
-- D. Bulk edits are saved as a draft change set first, reviewed, then applied (bulk_edit_drafts).
-- E. Production orders created together share a batch reference.
-- F. Delivery options: a rate can be store pickup at a location.
-- G. Reviews keep the size / colour that was bought.

-- ---------------------------------------------------------------- A. vendor ↔ finished products
create table if not exists public.vendor_products (
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  product_id  text not null references public.products (id) on delete cascade,
  vendor_sku  text check (vendor_sku is null or length(btrim(vendor_sku)) between 1 and 60),
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (vendor_id, product_id)
);
create index if not exists vendor_products_product on public.vendor_products (product_id);

-- ---------------------------------------------------------------- B. purchase orders for product sizes
alter type public.po_status add value if not exists 'approved' after 'draft';
alter type public.po_status add value if not exists 'closed';
alter table public.purchase_orders add column if not exists location_id uuid references public.locations (id) on delete restrict;
alter table public.purchase_orders add column if not exists approved_at timestamptz;
alter table public.purchase_orders add column if not exists approved_by uuid references public.staff_users (id) on delete set null;
alter table public.purchase_orders add column if not exists closed_at timestamptz;
alter table public.purchase_orders add column if not exists closed_by uuid references public.staff_users (id) on delete set null;
alter table public.purchase_orders add column if not exists close_note text check (close_note is null or length(close_note) <= 300);
comment on column public.purchase_orders.location_id is 'Where product lines are received into stock (null = the online location).';

alter table public.purchase_order_lines alter column material_id drop not null;
alter table public.purchase_order_lines add column if not exists variant_id uuid references public.product_variants (id) on delete restrict;
do $$ begin
  alter table public.purchase_order_lines add constraint purchase_order_lines_one_item check ((material_id is null) <> (variant_id is null));
exception when duplicate_object then null; end $$;
create unique index if not exists purchase_order_lines_variant on public.purchase_order_lines (purchase_order_id, variant_id) where variant_id is not null;

alter table public.goods_receipts add column if not exists receipt_number text;
alter table public.goods_receipts add column if not exists vendor_ref text check (vendor_ref is null or length(btrim(vendor_ref)) between 1 and 60);
alter table public.goods_receipts add column if not exists location_id uuid references public.locations (id) on delete restrict;
create unique index if not exists goods_receipts_number on public.goods_receipts (receipt_number) where receipt_number is not null;
alter table public.inventory_movements add column if not exists goods_receipt_id uuid references public.goods_receipts (id) on delete restrict;

insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values
  ('purchase_in', 'Received from a purchase order', 'in', true, 23)
on conflict (code) do nothing;

-- The goods receipt is written onto its ledger rows in the transaction that created them (as set_movement_unit_cost).
create or replace function public.link_movement_receipt(p_movement_id bigint, p_receipt_id uuid, p_unit_cost_paise integer default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.inventory_movements set goods_receipt_id = p_receipt_id, unit_cost_paise = coalesce(p_unit_cost_paise, unit_cost_paise)
  where id = p_movement_id and reason = 'purchase_in' and goods_receipt_id is null and created_at = now();
  if not found then raise exception 'link_movement_receipt: movement % cannot be linked', p_movement_id using errcode = '22023'; end if;
end $$;
revoke all on function public.link_movement_receipt(bigint, uuid, integer) from public, anon, authenticated;
grant execute on function public.link_movement_receipt(bigint, uuid, integer) to kitsyuu_admin;

-- ---------------------------------------------------------------- C. product approval
alter type public.product_status add value if not exists 'review' after 'draft';
alter table public.products add column if not exists submitted_at timestamptz;
alter table public.products add column if not exists submitted_by uuid references public.staff_users (id) on delete set null;
alter table public.products add column if not exists approved_at timestamptz;
alter table public.products add column if not exists approved_by uuid references public.staff_users (id) on delete set null;
grant update (submitted_at, submitted_by, approved_at, approved_by) on public.products to kitsyuu_admin;

-- ---------------------------------------------------------------- D. bulk-edit drafts
create table if not exists public.bulk_edit_drafts (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  status      text not null default 'draft' check (status in ('draft', 'applied', 'cancelled')),
  product_ids text[] not null check (cardinality(product_ids) between 1 and 200),
  changes     jsonb not null,                 -- what to change: [{ action, value }]
  preview     jsonb,                          -- old → new per product, worked out when the draft was saved
  result      jsonb,                          -- per product: applied / failed (with the reason)
  note        text check (note is null or length(note) <= 500),
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  applied_by  uuid references public.staff_users (id) on delete set null,
  applied_at  timestamptz,
  cancelled_at timestamptz,
  constraint bulk_edit_drafts_applied check ((status = 'applied') = (applied_at is not null))
);
create index if not exists bulk_edit_drafts_status on public.bulk_edit_drafts (status, created_at desc);

-- ---------------------------------------------------------------- E, F, G
alter table public.production_orders add column if not exists batch_ref text check (batch_ref is null or length(batch_ref) <= 40);
create index if not exists production_orders_batch on public.production_orders (batch_ref) where batch_ref is not null;
alter table public.shipping_rates add column if not exists is_pickup boolean not null default false;
alter table public.shipping_rates add column if not exists pickup_location_id uuid references public.locations (id) on delete restrict;
do $$ begin
  alter table public.shipping_rates add constraint shipping_rates_pickup_location check (not is_pickup or pickup_location_id is not null);
exception when duplicate_object then null; end $$;
alter table public.shipping_rates add column if not exists description text check (description is null or length(description) <= 200);
comment on column public.shipping_rates.description is 'Shown under the delivery option at checkout (optional).';
alter table public.reviews add column if not exists variant_label text check (variant_label is null or length(variant_label) <= 80);

-- ---------------------------------------------------------------- H. stock lock without deadlocks
-- Two checkouts of the same size: each inserts its order_items first (the foreign key takes FOR KEY SHARE on the size row),
-- then reserves stock. FOR UPDATE conflicts with KEY SHARE, so each waited for the other (deadlock, one checkout failed
-- with a server error instead of "sold out"). FOR NO KEY UPDATE still lets only one transaction change the stock at a
-- time but does not conflict with foreign-key locks. Same function otherwise (third pass).
create or replace function public.adjust_stock(
  p_variant_id uuid, p_delta integer, p_reason text, p_staff_id uuid default null, p_note text default null, p_order_id uuid default null
) returns table (movement_id bigint, balance_after integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_direction text; v_active boolean; v_stock integer; v_id bigint; v_loc uuid;
begin
  if p_delta is null or p_delta = 0 then raise exception 'adjust_stock: delta must be a non-zero integer' using errcode = '22023'; end if;
  select r.direction, r.is_active into v_direction, v_active from public.inventory_reasons r where r.code = p_reason;
  if not found then raise exception 'adjust_stock: unknown reason %', p_reason using errcode = '22023'; end if;
  if not v_active then raise exception 'adjust_stock: reason % is not active', p_reason using errcode = '22023'; end if;
  if (v_direction = 'in' and p_delta < 0) or (v_direction = 'out' and p_delta > 0) then
    raise exception 'adjust_stock: reason % does not allow a change of %', p_reason, p_delta using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff_users s where s.id = p_staff_id and s.status = 'active') then
    raise exception 'adjust_stock: staff user % is not active', p_staff_id using errcode = '42501';
  end if;
  select l.id into v_loc from public.locations l where l.is_online;
  if v_loc is null then raise exception 'adjust_stock: no online location is set up' using errcode = '55000'; end if;

  select v.stock_qty into v_stock from public.product_variants v where v.id = p_variant_id for no key update;
  if not found then raise exception 'adjust_stock: variant % not found', p_variant_id using errcode = 'P0002'; end if;
  if v_stock + p_delta < 0 then
    raise exception 'adjust_stock: insufficient stock (have %, change %)', v_stock, p_delta using errcode = '23514';
  end if;

  perform set_config('kitsyuu.stock_adjust', 'on', true);
  update public.product_variants set stock_qty = v_stock + p_delta where id = p_variant_id;
  perform set_config('kitsyuu.stock_adjust', 'off', true);
  insert into public.location_stock (location_id, variant_id, qty) values (v_loc, p_variant_id, v_stock + p_delta)
  on conflict (location_id, variant_id) do update set qty = excluded.qty, updated_at = now();

  insert into public.inventory_movements (variant_id, delta, reason, order_id, staff_id, note, balance_after, location_id)
  values (p_variant_id, p_delta, p_reason, p_order_id, p_staff_id, p_note, v_stock + p_delta, v_loc)
  returning id into v_id;
  return query select v_id, v_stock + p_delta;
end $$;

-- ---------------------------------------------------------------- access
alter table public.vendor_products enable row level security;
alter table public.bulk_edit_drafts enable row level security;
revoke all on public.vendor_products, public.bulk_edit_drafts from anon, authenticated, kitsyuu_website;
grant select, insert, delete on public.vendor_products to kitsyuu_admin;
grant select, insert, update on public.bulk_edit_drafts to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['vendor_products', 'bulk_edit_drafts'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;
grant update (location_id, approved_at, approved_by, closed_at, closed_by, close_note) on public.purchase_orders to kitsyuu_admin;
grant update (receipt_number, vendor_ref, location_id) on public.goods_receipts to kitsyuu_admin;
grant update (is_pickup, pickup_location_id) on public.shipping_rates to kitsyuu_admin;
grant select (is_pickup, pickup_location_id) on public.shipping_rates to kitsyuu_website;
grant update (batch_ref) on public.production_orders to kitsyuu_admin;
grant insert (variant_label) on public.reviews to kitsyuu_website;
grant select (variant_label) on public.reviews to kitsyuu_website;

-- The store logs the "order confirmed" email it sends (one per order; sent / failed visible to staff on the order).
grant select, insert on public.notification_log to kitsyuu_website;
grant usage on sequence public.notification_log_id_seq to kitsyuu_website;
drop policy if exists "app website: rows" on public.notification_log;
create policy "app website: rows" on public.notification_log for all to kitsyuu_website using (true) with check (true);

insert into public.permissions (code, module, description) values
  ('products.publish', 'products', 'Approve products and publish them in the store (and take them off it)'),
  ('procurement.approve', 'procurement', 'Approve purchase orders before they are sent to the vendor, and close them')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('products.publish'), ('procurement.approve')) p(code)
where r.code in ('super_admin', 'admin')
on conflict do nothing;
