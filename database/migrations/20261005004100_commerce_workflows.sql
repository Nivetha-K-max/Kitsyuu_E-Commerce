-- Commerce workflows (2026-10-01): draft orders, staff-created (assisted and offline) orders, staff discounts with limits,
-- restock cost, automatic abandoned-cart reminders. Additive only: nothing existing is changed or deleted, every existing
-- order keeps its values (online, no location, no staff discount), and every new switch starts unset / off.
--
-- A. Orders created by staff
--    * channel 'retail' (from the third pass) is now used: an offline order at a branch (orders.location_id), its stock
--      taken from that branch; online and staff-assisted orders stay 'online' and take stock from the online location.
--    * created_by: the staff member who created the order (null = the customer at checkout).
--    * In-store payment methods for offline orders: cash, card, upi.
--    * The staff discount on the order: amount, percent, reason and who gave it. It is also one of orders.pricing's
--      discount lines (code STAFF) and part of orders.discount_paise, so totals, tax and invoices work unchanged.
-- B. Draft orders: an order being prepared by staff (customer, items, discount, notes). It holds no stock and is not an
--    order until staff confirm it; confirming creates the real order through the normal order creation.
-- C. products.min_price_paise: the lowest price a product may be sold for after a staff discount (optional).
-- D. inventory_movements.unit_cost_paise: what one unit cost, entered with a restock (optional).
-- E. cart_recovery.auto_reminded_at: the one automatic "your cart is waiting" email per cart.
-- F. Permissions orders.create and orders.discount.

-- ---------------------------------------------------------------- A. orders
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check (payment_method in ('online', 'cod', 'cash', 'card', 'upi'));
alter table public.orders add column if not exists location_id uuid references public.locations (id) on delete restrict;
alter table public.orders add column if not exists created_by uuid references public.staff_users (id) on delete set null;
alter table public.orders add column if not exists staff_discount_paise integer not null default 0 check (staff_discount_paise >= 0);
alter table public.orders add column if not exists staff_discount_bp integer check (staff_discount_bp is null or staff_discount_bp between 1 and 10000);
alter table public.orders add column if not exists staff_discount_reason text check (staff_discount_reason is null or length(btrim(staff_discount_reason)) between 3 and 200);
alter table public.orders add column if not exists staff_discount_by uuid references public.staff_users (id) on delete set null;
do $$ begin
  -- An offline order is at a branch; an online order is not.
  alter table public.orders add constraint orders_channel_location check ((channel = 'retail') = (location_id is not null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_staff_discount_reason check (staff_discount_paise = 0 or (staff_discount_reason is not null and staff_discount_by is not null));
exception when duplicate_object then null; end $$;
-- A walk-in customer at a branch may have no account: an offline order may have only its contact (name / phone / email).
alter table public.orders drop constraint if exists orders_has_owner;
alter table public.orders add constraint orders_has_owner check (customer_id is not null or user_id is not null or channel = 'retail');
create index if not exists orders_location on public.orders (location_id) where location_id is not null;
create index if not exists orders_created_by on public.orders (created_by) where created_by is not null;
comment on column public.orders.created_by is 'Staff member who created the order (staff-assisted or offline); null when the customer placed it.';
comment on column public.orders.staff_discount_paise is 'Discount given by staff (also in discount_paise and pricing.discounts as STAFF).';

-- ---------------------------------------------------------------- B. draft orders
create table if not exists public.draft_orders (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique,
  status             text not null default 'open' check (status in ('open', 'confirmed', 'cancelled')),
  channel            text not null default 'online' check (channel in ('online', 'retail')),
  location_id        uuid references public.locations (id) on delete restrict,
  customer_id        uuid references public.customers (id) on delete restrict,
  contact            jsonb not null default '{}'::jsonb,           -- name, email, phone (a walk-in customer may have no account)
  shipping_address   jsonb,
  billing_address    jsonb,                                         -- null = same as shipping
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_reason    text check (discount_reason is null or length(btrim(discount_reason)) between 3 and 200),
  note               text check (note is null or length(note) <= 1000),
  owner_id           uuid references public.staff_users (id) on delete set null,
  order_id           uuid unique references public.orders (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  cancelled_at       timestamptz,
  constraint draft_orders_channel_location check ((channel = 'retail') = (location_id is not null)),
  constraint draft_orders_online_customer check (channel = 'retail' or customer_id is not null),
  constraint draft_orders_discount_reason check (discount_bp is null or discount_reason is not null),
  constraint draft_orders_confirmed check ((status = 'confirmed') = (order_id is not null))
);
create index if not exists draft_orders_status on public.draft_orders (status, updated_at desc);
create index if not exists draft_orders_customer on public.draft_orders (customer_id) where customer_id is not null;
drop trigger if exists draft_orders_updated_at on public.draft_orders;
create trigger draft_orders_updated_at before update on public.draft_orders for each row execute function public.set_updated_at();

create table if not exists public.draft_order_items (
  id          uuid primary key default gen_random_uuid(),
  draft_id    uuid not null references public.draft_orders (id) on delete cascade,
  variant_id  uuid not null references public.product_variants (id) on delete restrict,
  qty         integer not null check (qty between 1 and 10),
  created_at  timestamptz not null default now(),
  unique (draft_id, variant_id)
);
alter table public.orders add column if not exists draft_order_id uuid references public.draft_orders (id) on delete set null;

-- ---------------------------------------------------------------- C, D, E
alter table public.products add column if not exists min_price_paise integer check (min_price_paise is null or min_price_paise > 0);
comment on column public.products.min_price_paise is 'Lowest price after a staff discount (optional). Staff discounts that go below it are refused.';
alter table public.inventory_movements add column if not exists unit_cost_paise integer check (unit_cost_paise is null or unit_cost_paise >= 0);
alter table public.cart_recovery add column if not exists auto_reminded_at timestamptz;

-- The unit cost of a restock is written onto its ledger row in the transaction that created the row (created_at = now(),
-- i.e. the same transaction), once, and only for a stock increase: the ledger stays append-only otherwise.
create or replace function public.set_movement_unit_cost(p_movement_id bigint, p_unit_cost_paise integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_unit_cost_paise is null or p_unit_cost_paise < 0 then raise exception 'set_movement_unit_cost: invalid cost' using errcode = '22023'; end if;
  update public.inventory_movements set unit_cost_paise = p_unit_cost_paise
  where id = p_movement_id and delta > 0 and unit_cost_paise is null and created_at = now();
  if not found then raise exception 'set_movement_unit_cost: movement % cannot take a cost', p_movement_id using errcode = '22023'; end if;
end $$;
revoke all on function public.set_movement_unit_cost(bigint, integer) from public, anon, authenticated;
grant execute on function public.set_movement_unit_cost(bigint, integer) to kitsyuu_admin;

-- ---------------------------------------------------------------- offline sale: stock from the branch, linked to the order
-- Takes every line of a retail order from its branch (location_stock, ledger reason retail_sale) in one go, with the order
-- on each ledger row. Refuses anything but a retail order at an active branch; never below zero (adjust_location_stock).
create or replace function public.sell_order_at_location(p_order_id uuid, p_staff_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_number text; v_loc uuid; v_channel text; v_online boolean; v_units integer := 0; r record; v_mid bigint;
begin
  select o.order_number, o.location_id, o.channel into v_number, v_loc, v_channel from public.orders o where o.id = p_order_id for update;
  if not found then raise exception 'sell_order_at_location: order % not found', p_order_id using errcode = 'P0002'; end if;
  if v_channel <> 'retail' or v_loc is null then raise exception 'sell_order_at_location: order % is not an offline order', v_number using errcode = '22023'; end if;
  select l.is_online into v_online from public.locations l where l.id = v_loc;
  if v_online then raise exception 'sell_order_at_location: the online location is not a branch' using errcode = '22023'; end if;
  if exists (select 1 from public.inventory_movements m where m.order_id = p_order_id) then return 0; end if;
  for r in select i.variant_id, sum(i.qty)::int as qty from public.order_items i where i.order_id = p_order_id group by i.variant_id order by i.variant_id loop
    select a.movement_id into v_mid from public.adjust_location_stock(r.variant_id, v_loc, -r.qty, 'retail_sale', p_staff_id, 'Order ' || v_number) a;
    update public.inventory_movements set order_id = p_order_id where id = v_mid;
    v_units := v_units + r.qty;
  end loop;
  return v_units;
end $$;
revoke all on function public.sell_order_at_location(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sell_order_at_location(uuid, uuid) to kitsyuu_admin;

-- ---------------------------------------------------------------- access
alter table public.draft_orders enable row level security;
alter table public.draft_order_items enable row level security;
revoke all on public.draft_orders, public.draft_order_items from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.draft_orders to kitsyuu_admin;
grant select, insert, update, delete on public.draft_order_items to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.draft_orders;
create policy "app admin: all rows" on public.draft_orders for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.draft_order_items;
create policy "app admin: all rows" on public.draft_order_items for all to kitsyuu_admin using (true) with check (true);
-- The admin creates orders (staff-assisted / offline) and their lines and history; it already updates orders.
grant insert on public.orders, public.order_items, public.order_status_history to kitsyuu_admin;
grant update (min_price_paise) on public.products to kitsyuu_admin;
grant update (auto_reminded_at) on public.cart_recovery to kitsyuu_admin;

-- The store shows a customer the delivery and tracking of their own orders, and where an offline order was bought (read
-- only; the website code only reads the signed-in customer's orders, as it does for orders and invoices).
grant select (id, order_id, carrier_code, tracking_number, packing_state, shipped_at, delivered_at, status, tracking_url, in_transit_at, failed_at, cancelled_at, updated_at)
  on public.shipments to kitsyuu_website;
grant select (id, shipment_id, status, note, created_at) on public.shipment_events to kitsyuu_website;
grant select (code, name, tracking_url_template) on public.couriers to kitsyuu_website;
grant select (id, name, code) on public.locations to kitsyuu_website;
do $$ declare t text; begin
  foreach t in array array['shipments', 'shipment_events', 'couriers', 'locations'] loop
    execute format('drop policy if exists "app website: rows" on public.%I', t);
    execute format('create policy "app website: rows" on public.%I for select to kitsyuu_website using (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('orders.create', 'orders', 'Create draft orders and orders for customers (staff-assisted and offline at a branch)'),
  ('orders.discount', 'orders', 'Give a discount on a draft order, within the maximum % and product minimum prices')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('orders.create'), ('orders.discount')) p(code)
where r.code in ('super_admin', 'admin', 'manager')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, 'orders.create' from public.roles r where r.code = 'sales'
on conflict do nothing;
