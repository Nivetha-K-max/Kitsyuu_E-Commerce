-- KITSYUU platform M14: production and quality control (KITSYUU makes its own clothes). Additive only.
-- Minimum model for what is known; the manufacturing stages are NOT decided, so none are modelled:
--   * a production order makes N pieces of one size (product variant): planned → in progress → completed / cancelled;
--   * the materials an order uses are recorded (optional plan per material, consumption drawn from material stock
--     through adjust_material_stock, reason 'consume');
--   * completing an order records the quality check: pieces passed and pieces rejected (with a reason). Only passed
--     pieces enter finished-goods stock, through adjust_stock with the new system reason 'production_in' (ledger kept).
--     A business that does not inspect records every piece as passed.
-- Safe to re-run.

insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values
  ('production_in', 'Produced (passed quality check)', 'in', true, 8)
on conflict (code) do nothing;

do $$ begin create type public.production_status as enum ('planned', 'in_progress', 'completed', 'cancelled'); exception when duplicate_object then null; end $$;

create table if not exists public.production_orders (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique,
  variant_id    uuid not null references public.product_variants (id) on delete restrict,
  qty_planned   integer not null check (qty_planned between 1 and 100000),
  status        public.production_status not null default 'planned',
  due_on        date,
  notes         text check (notes is null or length(notes) <= 1000),
  started_at    timestamptz,
  completed_at  timestamptz,
  cancel_note   text check (cancel_note is null or length(cancel_note) <= 300),
  created_by    uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint production_completed_consistent check ((status = 'completed') = (completed_at is not null))
);
create index if not exists production_orders_status_idx on public.production_orders (status, created_at desc);
create index if not exists production_orders_variant_idx on public.production_orders (variant_id);
drop trigger if exists production_orders_updated_at on public.production_orders;
create trigger production_orders_updated_at before update on public.production_orders for each row execute function public.set_updated_at();

create table if not exists public.production_inputs (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders (id) on delete cascade,
  material_id         uuid not null references public.materials (id) on delete restrict,
  qty_planned         numeric(14, 3) check (qty_planned is null or qty_planned > 0),
  qty_consumed        numeric(14, 3) not null default 0 check (qty_consumed >= 0),
  unique (production_order_id, material_id)
);

create table if not exists public.qc_results (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null unique references public.production_orders (id) on delete restrict,
  qty_passed          integer not null check (qty_passed >= 0),
  qty_rejected        integer not null check (qty_rejected >= 0),
  reject_reason       text check (reject_reason is null or length(reject_reason) <= 300),
  note                text check (note is null or length(note) <= 500),
  inspected_by        uuid references public.staff_users (id) on delete set null,
  inspected_at        timestamptz not null default now(),
  constraint qc_some_pieces check (qty_passed + qty_rejected > 0),
  constraint qc_reason_when_rejected check (qty_rejected = 0 or reject_reason is not null)
);

alter table public.production_orders enable row level security;
alter table public.production_inputs enable row level security;
alter table public.qc_results        enable row level security;
revoke all on public.production_orders, public.production_inputs, public.qc_results from anon, authenticated;
grant select, insert, update on public.production_orders, public.production_inputs to kitsyuu_admin;
grant delete on public.production_inputs to kitsyuu_admin;              -- planned inputs of a planned order can be removed
grant select, insert on public.qc_results to kitsyuu_admin;             -- a quality check is recorded once, never edited
do $$ declare t text; begin
  foreach t in array array['production_orders', 'production_inputs', 'qc_results'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('production.read', 'production', 'View production orders, materials used and quality checks'),
  ('production.manage', 'production', 'Plan, start, cancel production orders and record materials used'),
  ('qc.record', 'production', 'Record the quality check that completes a production order (adds passed pieces to stock)')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'production.read'), ('super_admin', 'production.manage'), ('super_admin', 'qc.record'),
  ('admin', 'production.read'), ('admin', 'production.manage'), ('admin', 'qc.record'),
  ('manager', 'production.read'), ('manager', 'production.manage'), ('manager', 'qc.record'),
  ('inventory_manager', 'production.read'), ('inventory_manager', 'qc.record')
) x(role, code) on r.code = x.role
on conflict do nothing;
