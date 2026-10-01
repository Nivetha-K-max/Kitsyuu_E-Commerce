-- Client change request, THIRD PASS: inventory locations, stock transfers, online vs retail channel, colour variants.
-- Additive. Existing stock is recorded at the one online location (so the online store sells exactly what it sells today);
-- existing products and sizes keep no colour (nothing in the catalogue is converted). Nothing is deleted.
-- Safe to re-run.

-- ---------------------------------------------------------------- A. locations (database-driven; staff add more)
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  name       text not null check (length(btrim(name)) between 1 and 80),
  kind       text not null default 'warehouse' check (kind in ('warehouse', 'retail', 'other')),
  address    text check (address is null or length(address) <= 400),
  -- The one location the online store sells from: product_variants.stock_qty is its stock.
  is_online  boolean not null default false,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_online_active check (not is_online or is_active)
);
create unique index if not exists locations_one_online on public.locations (is_online) where is_online;
drop trigger if exists locations_updated_at on public.locations;
create trigger locations_updated_at before update on public.locations for each row execute function public.set_updated_at();
-- The online location, holding today's stock. The client named the Chennai Warehouse; staff can rename it and add the
-- retail branches. Created only when there is no location yet.
insert into public.locations (code, name, kind, is_online, sort_order)
select 'CHN-WH', 'Chennai Warehouse', 'warehouse', true, 0 where not exists (select 1 from public.locations);

-- Stock per location and size. For the online location it always equals product_variants.stock_qty (both change only in
-- adjust_stock); other locations change only in adjust_location_stock. Both write the ledger (inventory_movements).
create table if not exists public.location_stock (
  location_id uuid not null references public.locations (id) on delete restrict,
  variant_id  uuid not null references public.product_variants (id) on delete cascade,
  qty         integer not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now(),
  primary key (location_id, variant_id)
);
create index if not exists location_stock_variant on public.location_stock (variant_id);
insert into public.location_stock (location_id, variant_id, qty)
select l.id, v.id, v.stock_qty from public.product_variants v cross join public.locations l where l.is_online
on conflict (location_id, variant_id) do nothing;
-- A size created later (the admin, the catalogue seed) gets its online-location row at once, with its starting stock.
create or replace function public.location_stock_for_new_variant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.location_stock (location_id, variant_id, qty)
  select l.id, new.id, new.stock_qty from public.locations l where l.is_online
  on conflict (location_id, variant_id) do nothing;
  return new;
end $$;
drop trigger if exists product_variants_location_stock on public.product_variants;
create trigger product_variants_location_stock after insert on public.product_variants for each row execute function public.location_stock_for_new_variant();

-- ---------------------------------------------------------------- B. stock transfers
create table if not exists public.stock_transfers (
  id               uuid primary key default gen_random_uuid(),
  number           text not null unique,
  from_location_id uuid not null references public.locations (id) on delete restrict,
  to_location_id   uuid not null references public.locations (id) on delete restrict,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid references public.staff_users (id) on delete set null,
  created_at       timestamptz not null default now(),
  sent_by          uuid references public.staff_users (id) on delete set null,
  sent_at          timestamptz,
  received_by      uuid references public.staff_users (id) on delete set null,
  received_at      timestamptz,
  updated_at       timestamptz not null default now(),
  constraint stock_transfers_two_places check (from_location_id <> to_location_id)
);
create index if not exists stock_transfers_status on public.stock_transfers (status, created_at desc);
drop trigger if exists stock_transfers_updated_at on public.stock_transfers;
create trigger stock_transfers_updated_at before update on public.stock_transfers for each row execute function public.set_updated_at();
create table if not exists public.stock_transfer_lines (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers (id) on delete cascade,
  variant_id  uuid not null references public.product_variants (id) on delete restrict,
  qty         integer not null check (qty > 0),
  unique (transfer_id, variant_id)
);

-- Ledger rows now say where the stock moved (null = before locations existed: the online location).
alter table public.inventory_movements add column if not exists location_id uuid references public.locations (id) on delete restrict;
alter table public.inventory_movements add column if not exists transfer_id uuid references public.stock_transfers (id) on delete restrict;
create index if not exists inventory_movements_location on public.inventory_movements (location_id, created_at desc) where location_id is not null;

insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values
  ('transfer_out', 'Transfer out', 'out', true, 20),
  ('transfer_in', 'Transfer in', 'in', true, 21),
  -- In-store sales are recorded as stock leaving a retail location until a till (POS) is decided by the client.
  ('retail_sale', 'Retail sale (in store)', 'out', false, 22)
on conflict (code) do nothing;

-- ---------------------------------------------------------------- C. the stock functions
-- adjust_stock (unchanged signature and checks): the online location. It also keeps that location's row in step.
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

  select v.stock_qty into v_stock from public.product_variants v where v.id = p_variant_id for update;
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

-- adjust_location_stock: any location. The online location goes through adjust_stock (so the store's stock follows);
-- any other location changes only its own row. Same reason, direction and staff checks; never below zero.
create or replace function public.adjust_location_stock(
  p_variant_id uuid, p_location_id uuid, p_delta integer, p_reason text, p_staff_id uuid default null, p_note text default null, p_transfer_id uuid default null
) returns table (movement_id bigint, balance_after integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_online boolean; v_active boolean; v_direction text; v_ractive boolean; v_qty integer; v_id bigint; v_bal integer;
begin
  select l.is_online, l.is_active into v_online, v_active from public.locations l where l.id = p_location_id;
  if not found then raise exception 'adjust_location_stock: location % not found', p_location_id using errcode = 'P0002'; end if;
  if v_online then
    select a.movement_id, a.balance_after into v_id, v_bal from public.adjust_stock(p_variant_id, p_delta, p_reason, p_staff_id, p_note, null) a;
    if p_transfer_id is not null then update public.inventory_movements set transfer_id = p_transfer_id where id = v_id; end if;
    return query select v_id, v_bal;
    return;
  end if;
  if not v_active then raise exception 'adjust_location_stock: location is inactive' using errcode = '55000'; end if;
  if p_delta is null or p_delta = 0 then raise exception 'adjust_location_stock: delta must be a non-zero integer' using errcode = '22023'; end if;
  select r.direction, r.is_active into v_direction, v_ractive from public.inventory_reasons r where r.code = p_reason;
  if not found then raise exception 'adjust_location_stock: unknown reason %', p_reason using errcode = '22023'; end if;
  if not v_ractive then raise exception 'adjust_location_stock: reason % is not active', p_reason using errcode = '22023'; end if;
  if (v_direction = 'in' and p_delta < 0) or (v_direction = 'out' and p_delta > 0) then
    raise exception 'adjust_location_stock: reason % does not allow a change of %', p_reason, p_delta using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff_users s where s.id = p_staff_id and s.status = 'active') then
    raise exception 'adjust_location_stock: staff user % is not active', p_staff_id using errcode = '42501';
  end if;
  if not exists (select 1 from public.product_variants v where v.id = p_variant_id) then
    raise exception 'adjust_location_stock: variant % not found', p_variant_id using errcode = 'P0002';
  end if;
  insert into public.location_stock (location_id, variant_id, qty) values (p_location_id, p_variant_id, 0) on conflict do nothing;
  select s.qty into v_qty from public.location_stock s where s.location_id = p_location_id and s.variant_id = p_variant_id for update;
  if v_qty + p_delta < 0 then
    raise exception 'adjust_location_stock: insufficient stock (have %, change %)', v_qty, p_delta using errcode = '23514';
  end if;
  update public.location_stock set qty = v_qty + p_delta, updated_at = now() where location_id = p_location_id and variant_id = p_variant_id;
  insert into public.inventory_movements (variant_id, delta, reason, staff_id, note, balance_after, location_id, transfer_id)
  values (p_variant_id, p_delta, p_reason, p_staff_id, p_note, v_qty + p_delta, p_location_id, p_transfer_id)
  returning id into v_id;
  return query select v_id, v_qty + p_delta;
end $$;
revoke all on function public.adjust_location_stock(uuid, uuid, integer, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.adjust_location_stock(uuid, uuid, integer, text, uuid, text, uuid) to kitsyuu_admin;

-- Stock counts are per location (one open count per location). Existing counts were of the online stock.
alter table public.stock_counts add column if not exists location_id uuid references public.locations (id) on delete restrict;
update public.stock_counts set location_id = (select id from public.locations where is_online) where location_id is null;
alter table public.stock_counts alter column location_id set not null;
drop index if exists public.stock_counts_one_open;
create unique index if not exists stock_counts_one_open_per_location on public.stock_counts (location_id) where status = 'open';

-- ---------------------------------------------------------------- D. sales channel
-- How an order was sold: online (the store) or retail (in a branch, once a till / POS is decided). Every order today is online.
alter table public.orders add column if not exists channel text not null default 'online';
do $$ begin
  alter table public.orders add constraint orders_channel_check check (channel in ('online', 'retail'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- E. colour variants
-- A size may belong to a colour of the product. The colour is a value of the Colour attribute (attribute id "colour"), so
-- there is one list of colours for filters, variants and images. Existing sizes keep no colour.
alter table public.product_variants add column if not exists colour_slug text;
alter table public.product_variants add column if not exists colour_attribute text generated always as (case when colour_slug is null then null else 'colour' end) stored;
do $$ begin
  alter table public.product_variants add constraint product_variants_colour_fkey foreign key (colour_attribute, colour_slug)
    references public.attribute_values (attribute_id, slug) on delete restrict;
exception when duplicate_object then null; end $$;
-- One size per product AND colour (was: per product). Existing rows all have no colour, so they stay unique.
alter table public.product_variants drop constraint if exists product_variants_product_id_size_key;
create unique index if not exists product_variants_product_colour_size on public.product_variants (product_id, coalesce(colour_slug, ''), size);
create index if not exists product_variants_colour on public.product_variants (product_id, colour_slug) where colour_slug is not null;
-- An image may show one colour (null = the product in general).
alter table public.product_images add column if not exists colour_slug text;
alter table public.product_images add column if not exists colour_attribute text generated always as (case when colour_slug is null then null else 'colour' end) stored;
do $$ begin
  alter table public.product_images add constraint product_images_colour_fkey foreign key (colour_attribute, colour_slug)
    references public.attribute_values (attribute_id, slug) on delete restrict;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- F. access
alter table public.locations enable row level security;
alter table public.location_stock enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;
revoke all on public.locations, public.location_stock, public.stock_transfers, public.stock_transfer_lines from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.locations to kitsyuu_admin;
grant select on public.location_stock to kitsyuu_admin;                 -- written only by the stock functions
grant select, insert, update on public.stock_transfers to kitsyuu_admin;
grant select, insert, update, delete on public.stock_transfer_lines to kitsyuu_admin;
grant select, update (location_id) on public.stock_counts to kitsyuu_admin;
grant insert (location_id) on public.stock_counts to kitsyuu_admin;
grant update (colour_slug) on public.product_variants to kitsyuu_admin;
grant update (colour_slug) on public.product_images to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['locations', 'location_stock', 'stock_transfers', 'stock_transfer_lines'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('locations.manage', 'inventory', 'Add and edit stock locations (warehouses, retail branches)'),
  ('inventory.transfer', 'inventory', 'Create, send and receive stock transfers between locations')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'locations.manage'), ('admin', 'locations.manage'),
  ('super_admin', 'inventory.transfer'), ('admin', 'inventory.transfer'), ('manager', 'inventory.transfer'), ('inventory_manager', 'inventory.transfer')
) x(role, code) on r.code = x.role
on conflict do nothing;

-- ---------------------------------------------------------------- G. the colour an order line was bought in (snapshot, like size)
alter table public.order_items add column if not exists colour text check (colour is null or length(colour) <= 60);
-- An order edit (before shipment) may change a line's colour as well as its size.
grant update (colour) on public.order_items to kitsyuu_admin;
