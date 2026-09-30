-- KITSYUU ERP module 2: shipping. Additive only; safe to re-run.
-- * shipping_zones + shipping_rates: zone-based delivery charges (by Indian state and/or PIN prefix), with free-above,
--   order-value limits, COD flag and fee, and delivery estimates. Nothing is created: the store keeps using the existing
--   shipping.method setting ('none' = no charge) until the business chooses 'zones' and adds rates.
-- * couriers: the courier list (the existing 'manual' courier is recorded here). API credentials are never stored in the
--   database; an API courier reads its keys from the deployment environment.
-- * shipments get a delivery status (pending → processing → packed → shipped → in transit → delivered, or failed
--   delivery / cancelled), a tracking URL, label data and the courier's last response; shipment_events keeps the history.
--   Existing shipments get the status their current fields already imply.

create table if not exists public.shipping_zones (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique check (length(btrim(name)) between 1 and 80),
  states       text[] not null default '{}',
  pin_prefixes text[] not null default '{}',
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint shipping_zones_has_area check (cardinality(states) > 0 or cardinality(pin_prefixes) > 0)
);
drop trigger if exists shipping_zones_updated_at on public.shipping_zones;
create trigger shipping_zones_updated_at before update on public.shipping_zones for each row execute function public.set_updated_at();

create table if not exists public.shipping_rates (
  id              uuid primary key default gen_random_uuid(),
  zone_id         uuid not null references public.shipping_zones (id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 60),
  amount_paise    integer not null check (amount_paise >= 0),
  free_from_paise integer check (free_from_paise is null or free_from_paise > 0),
  min_order_paise integer check (min_order_paise is null or min_order_paise >= 0),
  max_order_paise integer check (max_order_paise is null or max_order_paise > 0),
  cod_allowed     boolean not null default false,
  cod_fee_paise   integer check (cod_fee_paise is null or cod_fee_paise >= 0),
  est_days_min    integer check (est_days_min is null or est_days_min between 0 and 60),
  est_days_max    integer check (est_days_max is null or est_days_max between 0 and 60),
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (zone_id, name),
  constraint shipping_rates_order_range check (max_order_paise is null or min_order_paise is null or max_order_paise > min_order_paise),
  constraint shipping_rates_days check (est_days_max is null or est_days_min is null or est_days_max >= est_days_min)
);
drop trigger if exists shipping_rates_updated_at on public.shipping_rates;
create trigger shipping_rates_updated_at before update on public.shipping_rates for each row execute function public.set_updated_at();

create table if not exists public.couriers (
  code                  text primary key check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  name                  text not null check (length(btrim(name)) between 1 and 80),
  mode                  text not null default 'manual' check (mode in ('manual', 'api')),
  tracking_url_template text check (tracking_url_template is null or (tracking_url_template ~ '^https://' and position('{tracking}' in tracking_url_template) > 0)),
  is_active             boolean not null default true,
  notes                 text check (notes is null or length(notes) <= 500),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
insert into public.couriers (code, name, mode) values ('manual', 'Manual courier', 'manual') on conflict (code) do nothing;
drop trigger if exists couriers_updated_at on public.couriers;
create trigger couriers_updated_at before update on public.couriers for each row execute function public.set_updated_at();

alter table public.shipments add column if not exists status text;
update public.shipments set status = case
    when delivered_at is not null then 'delivered'
    when shipped_at is not null then 'shipped'
    when packing_state = 'packed' then 'packed'
    when packing_state = 'packing' then 'processing'
    else 'pending' end
  where status is null;
alter table public.shipments alter column status set default 'pending';
alter table public.shipments alter column status set not null;
do $$ begin
  alter table public.shipments add constraint shipments_status_check
    check (status in ('pending', 'processing', 'packed', 'shipped', 'in_transit', 'delivered', 'failed_delivery', 'cancelled'));
exception when duplicate_object then null; end $$;
alter table public.shipments add column if not exists tracking_url     text check (tracking_url is null or tracking_url ~ '^https://');
alter table public.shipments add column if not exists label            jsonb not null default '{}'::jsonb;
alter table public.shipments add column if not exists courier_response jsonb;
alter table public.shipments add column if not exists in_transit_at    timestamptz;
alter table public.shipments add column if not exists failed_at        timestamptz;
alter table public.shipments add column if not exists failure_reason   text check (failure_reason is null or length(failure_reason) <= 300);
alter table public.shipments add column if not exists cancelled_at     timestamptz;
create index if not exists shipments_status_idx on public.shipments (status);

create table if not exists public.shipment_events (
  id            bigint generated always as identity primary key,
  shipment_id   uuid not null references public.shipments (id) on delete cascade,
  status        text not null,
  note          text check (note is null or length(note) <= 300),
  source        text not null default 'staff' check (source in ('staff', 'courier', 'system')),
  staff_user_id uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists shipment_events_shipment_idx on public.shipment_events (shipment_id, created_at);

alter table public.shipping_zones  enable row level security;
alter table public.shipping_rates  enable row level security;
alter table public.couriers        enable row level security;
alter table public.shipment_events enable row level security;
revoke all on public.shipping_zones, public.shipping_rates, public.couriers, public.shipment_events from anon, authenticated, kitsyuu_website;
grant select, insert, update, delete on public.shipping_zones, public.shipping_rates to kitsyuu_admin;
grant select, insert, update on public.couriers to kitsyuu_admin;
grant select, insert on public.shipment_events to kitsyuu_admin;
grant usage on sequence public.shipment_events_id_seq to kitsyuu_admin;
-- The store quotes delivery charges from the active zones and rates.
grant select on public.shipping_zones, public.shipping_rates to kitsyuu_website;
do $$ declare t text; begin
  foreach t in array array['shipping_zones', 'shipping_rates', 'couriers', 'shipment_events'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists "app website: active zones" on public.shipping_zones;
create policy "app website: active zones" on public.shipping_zones for select to kitsyuu_website using (is_active);
drop policy if exists "app website: active rates" on public.shipping_rates;
create policy "app website: active rates" on public.shipping_rates for select to kitsyuu_website using (is_active);

insert into public.permissions (code, module, description) values
  ('shipping.read', 'shipping', 'View shipments, delivery zones, rates and couriers'),
  ('shipping.manage', 'shipping', 'Update shipments and manage delivery zones, rates and couriers')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'shipping.read'), ('super_admin', 'shipping.manage'), ('admin', 'shipping.read'), ('admin', 'shipping.manage'),
  ('manager', 'shipping.read'), ('manager', 'shipping.manage'), ('sales', 'shipping.read'), ('sales', 'shipping.manage'),
  ('support', 'shipping.read'), ('inventory_manager', 'shipping.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
