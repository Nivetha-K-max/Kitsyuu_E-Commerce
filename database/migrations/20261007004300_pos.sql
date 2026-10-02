-- POS (point of sale) billing at a branch (2026-10-02). Additive only; existing rows are unchanged.
--
-- A POS sale is NOT a separate order model: it is an order in public.orders with channel 'retail' (offline) at the branch
-- where it was rung up (orders.location_id), created through the same pricing, staff-discount rules, stock ledger
-- (sell_order_at_location → adjust_location_stock, reason retail_sale) and audit as an offline draft order. On top of that:
--   * orders.pos_number / pos_session_id: the POS bill number and the cashier session the sale belongs to (POS = these set);
--   * pos_sessions: a cashier's shift at a branch (open → sales → close with the cash counted and the variance);
--   * a captured row in public.payments (provider 'pos', method cash / card / upi) for every POS sale, so the existing
--     returns / refunds workflow (which refunds captured payments) works for POS sales too;
--   * product_variants.barcode: optional, for scanning at the counter;
--   * inventory reason pos_void: a sale voided at the counter puts its stock back at the same branch;
--   * permissions pos.access / pos.sell / pos.void / pos.reports (discounts keep orders.discount, refunds keep refunds.create).

-- ---------------------------------------------------------------- barcodes
alter table public.product_variants add column if not exists barcode text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'product_variants_barcode_format') then
    alter table public.product_variants add constraint product_variants_barcode_format check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,64}$');
  end if;
end $$;
create unique index if not exists product_variants_barcode_key on public.product_variants (barcode) where barcode is not null;
-- Counter search by SKU prefix / product name (case-insensitive).
create index if not exists product_variants_sku_lower on public.product_variants (lower(sku) text_pattern_ops);
create index if not exists products_name_lower on public.products (lower(name) text_pattern_ops);

-- ---------------------------------------------------------------- cashier sessions
create table if not exists public.pos_sessions (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique,
  location_id         uuid not null references public.locations (id) on delete restrict,
  staff_id            uuid not null references public.staff_users (id) on delete restrict,
  status              text not null default 'open' check (status in ('open', 'closed')),
  opening_cash_paise  integer not null default 0 check (opening_cash_paise >= 0),
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz,
  closed_by           uuid references public.staff_users (id) on delete restrict,
  expected_cash_paise integer,
  counted_cash_paise  integer check (counted_cash_paise is null or counted_cash_paise >= 0),
  variance_paise      integer,
  close_note          text check (close_note is null or length(close_note) <= 500),
  constraint pos_sessions_closed_complete check (status = 'open' or (closed_at is not null and expected_cash_paise is not null and counted_cash_paise is not null and variance_paise is not null))
);
-- One open session per cashier (a cashier works one till at a time).
create unique index if not exists pos_sessions_one_open_per_staff on public.pos_sessions (staff_id) where status = 'open';
create index if not exists pos_sessions_location_opened on public.pos_sessions (location_id, opened_at desc);

-- ---------------------------------------------------------------- orders: the POS link
alter table public.orders add column if not exists pos_session_id uuid references public.pos_sessions (id) on delete restrict;
alter table public.orders add column if not exists pos_number text;
create unique index if not exists orders_pos_number_key on public.orders (pos_number) where pos_number is not null;
create index if not exists orders_pos_session_idx on public.orders (pos_session_id) where pos_session_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_pos_is_retail') then
    alter table public.orders add constraint orders_pos_is_retail check ((pos_number is null and pos_session_id is null) or (channel = 'retail' and pos_number is not null and pos_session_id is not null));
  end if;
end $$;

-- ---------------------------------------------------------------- stock: a voided POS sale goes back to its branch
insert into public.inventory_reasons (code, label, direction, is_system, sort_order) values ('pos_void', 'POS sale voided', 'in', true, 11)
on conflict (code) do nothing;

-- Stock movement for an OFFLINE order at its own branch, linked to the order on the ledger row: a POS void (pos_void),
-- and returns / exchanges of offline orders (return / exchange), so a sale at Store 1 never moves Store 2 or online stock.
-- Refuses online orders (they keep adjust_stock); never below zero (adjust_location_stock).
create or replace function public.order_stock_at_location(p_order_id uuid, p_variant_id uuid, p_delta integer, p_reason text, p_staff_id uuid, p_note text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_loc uuid; v_channel text; v_mid bigint;
begin
  select o.location_id, o.channel into v_loc, v_channel from public.orders o where o.id = p_order_id;
  if not found then raise exception 'order_stock_at_location: order % not found', p_order_id using errcode = 'P0002'; end if;
  if v_channel <> 'retail' or v_loc is null then raise exception 'order_stock_at_location: order % is not an offline order', p_order_id using errcode = '22023'; end if;
  if p_reason not in ('pos_void', 'return', 'exchange') then raise exception 'order_stock_at_location: reason % is not allowed here', p_reason using errcode = '22023'; end if;
  select a.movement_id into v_mid from public.adjust_location_stock(p_variant_id, v_loc, p_delta, p_reason, p_staff_id, p_note) a;
  update public.inventory_movements set order_id = p_order_id where id = v_mid;
  return v_mid;
end $$;
revoke all on function public.order_stock_at_location(uuid, uuid, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.order_stock_at_location(uuid, uuid, integer, text, uuid, text) to kitsyuu_admin;

-- ---------------------------------------------------------------- access
alter table public.pos_sessions enable row level security;
revoke all on public.pos_sessions from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.pos_sessions to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.pos_sessions;
create policy "app admin: all rows" on public.pos_sessions for all to kitsyuu_admin using (true) with check (true);
grant update (barcode) on public.product_variants to kitsyuu_admin;

insert into public.permissions (code, module, description) values
  ('pos.access', 'pos', 'Open the POS counter, see POS sales and print bills'),
  ('pos.sell', 'pos', 'Open / close a cashier session and ring up POS sales (take cash, card or UPI payment)'),
  ('pos.void', 'pos', 'Void a POS sale of the open session (stock back to the branch, payment returned)'),
  ('pos.reports', 'pos', 'See POS reports and the cashier sessions of every cashier')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('pos.access'), ('pos.sell'), ('pos.void'), ('pos.reports')) p(code)
where r.code in ('super_admin', 'admin', 'manager')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('pos.access'), ('pos.sell')) p(code)
where r.code = 'sales'
on conflict do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('pos.access'), ('pos.reports')) p(code)
where r.code = 'accountant'
on conflict do nothing;
