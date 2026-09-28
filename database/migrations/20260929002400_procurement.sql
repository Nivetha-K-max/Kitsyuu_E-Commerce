-- KITSYUU platform M13: vendors, materials and purchasing (KITSYUU makes its own clothes). Additive only.
-- Built for what is known; nothing undecided is fixed in the schema:
--   * units of measure are typed by staff per material (metres, kg, pieces…): no fixed list;
--   * there is no approval step for purchase orders (not decided); staff with procurement.manage place them;
--   * deliveries may arrive in parts; each receipt adds what actually arrived;
--   * finished garments are still restocked through the existing stock adjustments (inventory), not through POs.
-- Material stock follows the same rule as product stock: it changes only through a ledger row (material_movements) written
-- by the function adjust_material_stock(), and a trigger refuses any other change to materials.stock_qty.
-- Costs (unit prices on purchase orders) are only shown to staff with costs.read; the admin role reads them, the pages hide them.
-- Safe to re-run.

create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  contact    text check (contact is null or length(contact) <= 120),
  email      text check (email is null or (email = lower(btrim(email)) and email like '%_@_%')),
  phone      text check (phone is null or phone ~ '^[+0-9 ()-]{6,20}$'),
  gstin      text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  address    text check (address is null or length(address) <= 400),
  notes      text check (notes is null or length(notes) <= 1000),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists vendors_name_key on public.vendors (lower(name));
drop trigger if exists vendors_updated_at on public.vendors;
create trigger vendors_updated_at before update on public.vendors for each row execute function public.set_updated_at();

create table if not exists public.materials (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  name          text not null check (length(btrim(name)) between 1 and 120),
  unit          text not null check (length(btrim(unit)) between 1 and 20),
  stock_qty     numeric(14, 3) not null default 0 check (stock_qty >= 0),
  reorder_level numeric(14, 3) check (reorder_level is null or reorder_level >= 0),
  notes         text check (notes is null or length(notes) <= 1000),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists materials_updated_at on public.materials;
create trigger materials_updated_at before update on public.materials for each row execute function public.set_updated_at();

do $$ begin create type public.po_status as enum ('draft', 'ordered', 'partially_received', 'received', 'cancelled'); exception when duplicate_object then null; end $$;

create table if not exists public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text not null unique,
  vendor_id     uuid not null references public.vendors (id) on delete restrict,
  status        public.po_status not null default 'draft',
  expected_on   date,
  notes         text check (notes is null or length(notes) <= 1000),
  ordered_at    timestamptz,
  created_by    uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists purchase_orders_status_idx on public.purchase_orders (status, created_at desc);
create index if not exists purchase_orders_vendor_idx on public.purchase_orders (vendor_id);
drop trigger if exists purchase_orders_updated_at on public.purchase_orders;
create trigger purchase_orders_updated_at before update on public.purchase_orders for each row execute function public.set_updated_at();

create table if not exists public.purchase_order_lines (
  id               uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete restrict,
  qty_ordered      numeric(14, 3) not null check (qty_ordered > 0),
  qty_received     numeric(14, 3) not null default 0 check (qty_received >= 0 and qty_received <= qty_ordered),
  unit_cost_paise  integer check (unit_cost_paise is null or unit_cost_paise >= 0),
  position         smallint not null default 0,
  unique (purchase_order_id, material_id)
);

create table if not exists public.goods_receipts (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders (id) on delete restrict,
  received_at       timestamptz not null default now(),
  received_by       uuid references public.staff_users (id) on delete set null,
  note              text check (note is null or length(note) <= 500)
);
create table if not exists public.goods_receipt_lines (
  id                  uuid primary key default gen_random_uuid(),
  goods_receipt_id    uuid not null references public.goods_receipts (id) on delete cascade,
  purchase_order_line_id uuid not null references public.purchase_order_lines (id) on delete restrict,
  qty                 numeric(14, 3) not null check (qty > 0)
);

-- Material stock ledger: every change of materials.stock_qty is one row here (balance after included).
create table if not exists public.material_movements (
  id            bigint generated always as identity primary key,
  material_id   uuid not null references public.materials (id) on delete restrict,
  delta         numeric(14, 3) not null check (delta <> 0),
  balance_after numeric(14, 3) not null check (balance_after >= 0),
  reason        text not null check (reason in ('receipt', 'consume', 'correction', 'damage')),
  goods_receipt_id uuid references public.goods_receipts (id) on delete restrict,
  staff_id      uuid references public.staff_users (id) on delete restrict,
  note          text check (note is null or length(note) <= 300),
  created_at    timestamptz not null default now()
);
create index if not exists material_movements_material_idx on public.material_movements (material_id, created_at desc);

-- The only way to change material stock (mirrors adjust_stock for garments). Refuses to go below zero.
create or replace function public.adjust_material_stock(p_material_id uuid, p_delta numeric, p_reason text, p_staff_id uuid, p_note text, p_receipt_id uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_old numeric; v_new numeric;
begin
  if p_delta = 0 then raise exception 'delta must not be zero'; end if;
  select stock_qty into v_old from public.materials where id = p_material_id for update;
  if v_old is null then raise exception 'material % not found', p_material_id; end if;
  if v_old + p_delta < 0 then raise exception 'not enough stock of this material' using errcode = '23514'; end if;
  perform set_config('kitsyuu.material_stock_ledger', 'on', true);
  update public.materials set stock_qty = stock_qty + p_delta where id = p_material_id returning stock_qty into v_new;
  insert into public.material_movements (material_id, delta, balance_after, reason, goods_receipt_id, staff_id, note)
    values (p_material_id, p_delta, v_new, p_reason, p_receipt_id, p_staff_id, p_note);
  perform set_config('kitsyuu.material_stock_ledger', 'off', true);
  return v_new;
end $$;
revoke execute on function public.adjust_material_stock(uuid, numeric, text, uuid, text, uuid) from public, anon, authenticated;

create or replace function public.guard_material_stock() returns trigger language plpgsql as $$
begin
  if new.stock_qty is distinct from old.stock_qty and coalesce(current_setting('kitsyuu.material_stock_ledger', true), 'off') <> 'on' then
    raise exception 'materials.stock_qty changes only through adjust_material_stock()';
  end if;
  return new;
end $$;
drop trigger if exists materials_guard_stock on public.materials;
create trigger materials_guard_stock before update on public.materials for each row execute function public.guard_material_stock();

alter table public.vendors              enable row level security;
alter table public.materials            enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.goods_receipts       enable row level security;
alter table public.goods_receipt_lines  enable row level security;
alter table public.material_movements   enable row level security;
revoke all on public.vendors, public.materials, public.purchase_orders, public.purchase_order_lines, public.goods_receipts,
  public.goods_receipt_lines, public.material_movements from anon, authenticated;

-- Admin app only (the website never sees purchasing). Ledger rows are append-only for the app.
grant select, insert, update on public.vendors, public.materials, public.purchase_orders, public.purchase_order_lines to kitsyuu_admin;
grant delete on public.purchase_order_lines to kitsyuu_admin;                   -- lines of a draft PO can be removed
grant select, insert on public.goods_receipts, public.goods_receipt_lines, public.material_movements to kitsyuu_admin;
grant execute on function public.adjust_material_stock(uuid, numeric, text, uuid, text, uuid) to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['vendors', 'materials', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'material_movements'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

-- Permissions. costs.read shows purchase prices (and later production costs and stock value).
insert into public.permissions (code, module, description) values
  ('procurement.read', 'procurement', 'View vendors, materials, material stock and purchase orders'),
  ('procurement.manage', 'procurement', 'Create and edit vendors, materials and purchase orders; adjust material stock'),
  ('procurement.receive', 'procurement', 'Record deliveries (goods receipts) against purchase orders'),
  ('costs.read', 'costs', 'See purchase prices, production costs and stock value')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'procurement.read'), ('super_admin', 'procurement.manage'), ('super_admin', 'procurement.receive'), ('super_admin', 'costs.read'),
  ('admin', 'procurement.read'), ('admin', 'procurement.manage'), ('admin', 'procurement.receive'), ('admin', 'costs.read'),
  ('manager', 'procurement.read'), ('manager', 'procurement.manage'), ('manager', 'procurement.receive'),
  ('inventory_manager', 'procurement.read'), ('inventory_manager', 'procurement.receive'),
  ('accountant', 'procurement.read'), ('accountant', 'costs.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
