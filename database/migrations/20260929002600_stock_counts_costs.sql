-- KITSYUU platform M15: stock counts (stock-take) and stock value. Additive only.
-- Stock count: opening a count snapshots the expected quantity of each size; staff enter what they physically counted;
-- posting applies counted − expected to the CURRENT stock through adjust_stock (new system reason 'count_adjust'), so
-- sales or production recorded while the count was in progress are kept.
-- Stock value: the costing method is NOT decided (average, FIFO…), so none is computed. Staff with costs.manage may enter
-- a unit cost per size (variant_costs, kept apart from product_variants so the website role can never read it); the
-- value shown is quantity × that cost where one is entered. Materials are valued at their last purchase price (from real
-- purchase orders), labelled as such.
-- Safe to re-run.

insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values
  ('count_adjust', 'Stock count difference', 'any', true, 9)
on conflict (code) do nothing;

do $$ begin create type public.stock_count_status as enum ('open', 'posted', 'cancelled'); exception when duplicate_object then null; end $$;

create table if not exists public.stock_counts (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  status      public.stock_count_status not null default 'open',
  note        text check (note is null or length(note) <= 300),
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  posted_by   uuid references public.staff_users (id) on delete set null,
  posted_at   timestamptz,
  constraint stock_counts_posted_consistent check ((status = 'posted') = (posted_at is not null))
);
create table if not exists public.stock_count_lines (
  id             uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references public.stock_counts (id) on delete cascade,
  variant_id     uuid not null references public.product_variants (id) on delete restrict,
  expected_qty   integer not null,
  counted_qty    integer check (counted_qty is null or counted_qty >= 0),
  unique (stock_count_id, variant_id)
);
create unique index if not exists stock_counts_one_open on public.stock_counts ((true)) where status = 'open';

create table if not exists public.variant_costs (
  variant_id      uuid primary key references public.product_variants (id) on delete cascade,
  unit_cost_paise integer not null check (unit_cost_paise >= 0),
  updated_by      uuid references public.staff_users (id) on delete set null,
  updated_at      timestamptz not null default now()
);

alter table public.stock_counts      enable row level security;
alter table public.stock_count_lines enable row level security;
alter table public.variant_costs     enable row level security;
revoke all on public.stock_counts, public.stock_count_lines, public.variant_costs from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.stock_counts, public.stock_count_lines, public.variant_costs to kitsyuu_admin;
grant delete on public.variant_costs to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['stock_counts', 'stock_count_lines', 'variant_costs'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('inventory.count', 'inventory', 'Run stock counts and post their differences to stock'),
  ('costs.manage', 'costs', 'Enter unit costs of finished pieces (used for stock value)')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'inventory.count'), ('super_admin', 'costs.manage'),
  ('admin', 'inventory.count'), ('admin', 'costs.manage'),
  ('manager', 'inventory.count'),
  ('inventory_manager', 'inventory.count'),
  ('accountant', 'costs.manage')
) x(role, code) on r.code = x.role
on conflict do nothing;
