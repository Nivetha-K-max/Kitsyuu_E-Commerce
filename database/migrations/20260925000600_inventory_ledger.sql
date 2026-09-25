-- KITSYUU platform M2: inventory ledger (additive only).
-- Stock changes only through public.adjust_stock(), which updates product_variants.stock_qty and writes the matching
-- inventory_movements row (with balance_after) in the same transaction. A trigger rejects any other change to stock_qty.
-- The existing 110 'seed' movements and every variant's stock_qty are left exactly as they are:
-- new columns are nullable with no default, so existing rows are not rewritten.
-- Safe to re-run: every statement is guarded.

-- ---------- reasons are data, not a hard-coded list ----------
create table if not exists public.inventory_reasons (
  code       text primary key check (code ~ '^[a-z][a-z_]*$'),
  label      text not null,
  direction  text not null check (direction in ('in', 'out', 'any')),   -- which sign of delta the reason allows
  is_system  boolean not null default false,       -- used by the platform itself (seed, sale, cancel), not for manual adjustments
  is_active  boolean not null default true,
  sort_order int not null default 0
);
insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values
  ('seed',         'Initial stock',           'in',  true,  0),
  ('sale',         'Sale',                    'out', true,  1),
  ('cancel',       'Order cancelled',         'in',  true,  2),
  ('restock',      'Restock',                 'in',  false, 3),
  ('return',       'Customer return',         'in',  false, 4),
  ('damage',       'Damaged / written off',   'out', false, 5),
  ('correction',   'Stock count correction',  'any', false, 6),
  ('admin_adjust', 'Manual adjustment',       'any', false, 7)
on conflict (code) do nothing;
alter table public.inventory_reasons enable row level security;
revoke all on public.inventory_reasons from anon, authenticated;

-- The Phase 4.2 CHECK list (seed, sale, restock, admin_adjust, cancel) becomes a foreign key to inventory_reasons.
-- Every existing value is in the new table, so no existing row changes; the FK is added before the CHECK is dropped.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_movements_reason_fkey' and conrelid = 'public.inventory_movements'::regclass) then
    alter table public.inventory_movements add constraint inventory_movements_reason_fkey foreign key (reason) references public.inventory_reasons (code);
  end if;
end $$;
alter table public.inventory_movements drop constraint if exists inventory_movements_reason_check;

-- ---------- new ledger columns (nullable: the existing 110 rows keep null) ----------
alter table public.inventory_movements add column if not exists staff_id uuid references public.staff_users (id) on delete restrict;
alter table public.inventory_movements add column if not exists balance_after integer check (balance_after >= 0);
create index if not exists inventory_movements_staff_idx on public.inventory_movements (staff_id) where staff_id is not null;
comment on column public.inventory_movements.balance_after is 'stock_qty after this movement. Null for the Phase 4.2 seed rows (their balance equals their delta).';
comment on column public.inventory_movements.created_by is 'Legacy (Supabase Auth user). New movements record staff_id instead.';

-- Per-variant low-stock level. Null = use the inventory.low_stock_threshold setting.
alter table public.product_variants add column if not exists reorder_level integer check (reorder_level >= 0);

-- ---------- the only way to change stock ----------
create or replace function public.adjust_stock(
  p_variant_id uuid,
  p_delta      integer,
  p_reason     text,
  p_staff_id   uuid default null,
  p_note       text default null,
  p_order_id   uuid default null
) returns table (movement_id bigint, balance_after integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_direction text;
  v_active    boolean;
  v_stock     integer;
  v_id        bigint;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'adjust_stock: delta must be a non-zero integer' using errcode = '22023';
  end if;

  select r.direction, r.is_active into v_direction, v_active from public.inventory_reasons r where r.code = p_reason;
  if not found then raise exception 'adjust_stock: unknown reason %', p_reason using errcode = '22023'; end if;
  if not v_active then raise exception 'adjust_stock: reason % is not active', p_reason using errcode = '22023'; end if;
  if (v_direction = 'in' and p_delta < 0) or (v_direction = 'out' and p_delta > 0) then
    raise exception 'adjust_stock: reason % does not allow a change of %', p_reason, p_delta using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff_users s where s.id = p_staff_id and s.status = 'active') then
    raise exception 'adjust_stock: staff user % is not active', p_staff_id using errcode = '42501';
  end if;

  -- Row lock: concurrent adjustments of the same variant queue here instead of losing updates.
  select v.stock_qty into v_stock from public.product_variants v where v.id = p_variant_id for update;
  if not found then raise exception 'adjust_stock: variant % not found', p_variant_id using errcode = 'P0002'; end if;
  if v_stock + p_delta < 0 then
    raise exception 'adjust_stock: insufficient stock (have %, change %)', v_stock, p_delta using errcode = '23514';
  end if;

  perform set_config('kitsyuu.stock_adjust', 'on', true);
  update public.product_variants set stock_qty = v_stock + p_delta where id = p_variant_id;
  perform set_config('kitsyuu.stock_adjust', 'off', true);

  insert into public.inventory_movements (variant_id, delta, reason, order_id, staff_id, note, balance_after)
  values (p_variant_id, p_delta, p_reason, p_order_id, p_staff_id, p_note, v_stock + p_delta)
  returning id into v_id;

  return query select v_id, v_stock + p_delta;
end $$;
comment on function public.adjust_stock(uuid, integer, text, uuid, text, uuid) is
  'Changes a variant''s stock and writes the inventory ledger row in one transaction. The only permitted way to change stock_qty. Callers are trusted server code, which passes the acting staff id.';

-- Guard: any change to stock_qty outside adjust_stock() is rejected, whoever makes it.
create or replace function public.guard_stock_qty() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.stock_qty is distinct from old.stock_qty and coalesce(current_setting('kitsyuu.stock_adjust', true), 'off') <> 'on' then
    raise exception 'stock_qty can only be changed through public.adjust_stock()' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists product_variants_guard_stock on public.product_variants;
create trigger product_variants_guard_stock before update of stock_qty on public.product_variants
  for each row execute function public.guard_stock_qty();

-- Supabase grants EXECUTE on new functions to anon/authenticated by default: the public API must never call these.
revoke all on function public.adjust_stock(uuid, integer, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.guard_stock_qty() from public, anon, authenticated;
