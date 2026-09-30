-- KITSYUU ERP module 1: pricing and discounts. Additive only; safe to re-run.
-- * compare-at ("was") prices on products and sizes; nothing is filled in.
-- * price_history: every price change from now on (manual, bulk or scheduled), with who and when.
-- * price_changes: price changes scheduled for a later time; applied by the admin job (or when staff open Pricing).
-- * discounts: automatic discounts and coupon codes (percent or fixed; order-wide or for chosen products, categories or
--   collections; dates, minimum order, cap, usage limits). None exist, and the master switch discounts.enabled has no
--   row, so it is OFF: checkout behaves exactly as before until the business turns discounts on ("no discounts at launch").
-- * discount_redemptions: which discount an order used and how much it took off (usage limits count these).

alter table public.products         add column if not exists compare_at_paise integer check (compare_at_paise is null or compare_at_paise >= 0);
alter table public.product_variants add column if not exists compare_at_paise integer check (compare_at_paise is null or compare_at_paise >= 0);
alter table public.carts            add column if not exists coupon_code text check (coupon_code is null or coupon_code ~ '^[A-Z0-9_-]{3,32}$');

create table if not exists public.price_history (
  id            bigint generated always as identity primary key,
  product_id    text not null references public.products (id) on delete cascade,
  variant_id    uuid references public.product_variants (id) on delete cascade,
  field         text not null check (field in ('price', 'compare_at')),
  old_paise     integer check (old_paise is null or old_paise >= 0),
  new_paise     integer check (new_paise is null or new_paise >= 0),
  source        text not null check (source in ('manual', 'bulk', 'scheduled')),
  change_id     uuid,
  staff_user_id uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists price_history_product_idx on public.price_history (product_id, created_at desc);
create index if not exists price_history_created_idx on public.price_history (created_at desc);

-- Every change of a price or compare-at price is recorded by a trigger, whichever screen or job made it. The service that
-- makes the change may say who and how for the current transaction (set_config('kitsyuu.price_source' / 'kitsyuu.staff_id'
-- / 'kitsyuu.price_change', …, true)); without that the row says 'manual' with no staff member (the audit log has who).
create or replace function public.record_price_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_source text := coalesce(nullif(current_setting('kitsyuu.price_source', true), ''), 'manual');
  v_staff  uuid := nullif(current_setting('kitsyuu.staff_id', true), '')::uuid;
  v_change uuid := nullif(current_setting('kitsyuu.price_change', true), '')::uuid;
  v_product text; v_variant uuid;
begin
  if v_source not in ('manual', 'bulk', 'scheduled') then v_source := 'manual'; end if;
  if tg_table_name = 'products' then v_product := new.id; v_variant := null;
  else v_product := new.product_id; v_variant := new.id; end if;
  if new.price_paise is distinct from old.price_paise then
    insert into public.price_history (product_id, variant_id, field, old_paise, new_paise, source, change_id, staff_user_id)
    values (v_product, v_variant, 'price', old.price_paise, new.price_paise, v_source, v_change, v_staff);
  end if;
  if new.compare_at_paise is distinct from old.compare_at_paise then
    insert into public.price_history (product_id, variant_id, field, old_paise, new_paise, source, change_id, staff_user_id)
    values (v_product, v_variant, 'compare_at', old.compare_at_paise, new.compare_at_paise, v_source, v_change, v_staff);
  end if;
  return new;
end $$;
revoke all on function public.record_price_history() from public, anon, authenticated;
drop trigger if exists products_price_history on public.products;
create trigger products_price_history after update of price_paise, compare_at_paise on public.products
  for each row execute function public.record_price_history();
drop trigger if exists product_variants_price_history on public.product_variants;
create trigger product_variants_price_history after update of price_paise, compare_at_paise on public.product_variants
  for each row execute function public.record_price_history();

create table if not exists public.price_changes (
  id                   uuid primary key default gen_random_uuid(),
  product_id           text not null references public.products (id) on delete cascade,
  variant_id           uuid references public.product_variants (id) on delete cascade,
  new_price_paise      integer check (new_price_paise is null or new_price_paise >= 0),
  new_compare_at_paise integer check (new_compare_at_paise is null or new_compare_at_paise >= 0),
  clear_compare_at     boolean not null default false,
  effective_at         timestamptz not null,
  status               text not null default 'scheduled' check (status in ('scheduled', 'applied', 'cancelled', 'failed')),
  note                 text check (note is null or length(note) <= 300),
  failure_reason       text check (failure_reason is null or length(failure_reason) <= 300),
  created_by           uuid references public.staff_users (id) on delete set null,
  created_at           timestamptz not null default now(),
  applied_at           timestamptz,
  cancelled_at         timestamptz,
  constraint price_changes_something check (new_price_paise is not null or new_compare_at_paise is not null or clear_compare_at),
  constraint price_changes_compare_one_way check (not (clear_compare_at and new_compare_at_paise is not null))
);
create index if not exists price_changes_due_idx on public.price_changes (effective_at) where status = 'scheduled';

create table if not exists public.discounts (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) between 1 and 120),
  code               text unique check (code is null or code ~ '^[A-Z0-9_-]{3,32}$'),    -- null = applies automatically
  kind               text not null check (kind in ('percent', 'fixed')),
  value              integer not null check (value > 0),                                  -- percent: basis points; fixed: paise
  scope              text not null default 'order' check (scope in ('order', 'products', 'categories', 'collections')),
  product_ids        text[] not null default '{}',
  category_ids       text[] not null default '{}',
  collection_ids     text[] not null default '{}',
  min_order_paise    integer check (min_order_paise is null or min_order_paise >= 0),
  max_discount_paise integer check (max_discount_paise is null or max_discount_paise > 0),
  starts_at          timestamptz,
  ends_at            timestamptz,
  is_active          boolean not null default false,
  usage_limit        integer check (usage_limit is null or usage_limit > 0),
  per_customer_limit integer check (per_customer_limit is null or per_customer_limit > 0),
  created_by         uuid references public.staff_users (id) on delete set null,
  updated_by         uuid references public.staff_users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint discounts_percent_range check (kind <> 'percent' or value <= 10000),
  constraint discounts_dates check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint discounts_targets check (
    (scope = 'order') or (scope = 'products' and cardinality(product_ids) > 0)
    or (scope = 'categories' and cardinality(category_ids) > 0) or (scope = 'collections' and cardinality(collection_ids) > 0))
);
create index if not exists discounts_active_idx on public.discounts (is_active, starts_at, ends_at);
drop trigger if exists discounts_updated_at on public.discounts;
create trigger discounts_updated_at before update on public.discounts for each row execute function public.set_updated_at();

create table if not exists public.discount_redemptions (
  id           bigint generated always as identity primary key,
  discount_id  uuid not null references public.discounts (id) on delete restrict,
  order_id     uuid not null references public.orders (id) on delete cascade,
  customer_id  uuid references public.customers (id) on delete set null,
  code         text,
  amount_paise integer not null check (amount_paise > 0),
  created_at   timestamptz not null default now(),
  unique (discount_id, order_id)
);
create index if not exists discount_redemptions_customer_idx on public.discount_redemptions (discount_id, customer_id);

alter table public.price_history        enable row level security;
alter table public.price_changes        enable row level security;
alter table public.discounts            enable row level security;
alter table public.discount_redemptions enable row level security;
revoke all on public.price_history, public.price_changes, public.discounts, public.discount_redemptions from anon, authenticated, kitsyuu_website;
grant select, insert on public.price_history to kitsyuu_admin;
grant usage on sequence public.price_history_id_seq to kitsyuu_admin;
grant select, insert, update on public.price_changes, public.discounts to kitsyuu_admin;
grant select on public.discount_redemptions to kitsyuu_admin;
grant update (compare_at_paise) on public.product_variants to kitsyuu_admin;
-- The store prices carts with the active discounts and records what an order used.
grant select on public.discounts, public.discount_redemptions to kitsyuu_website;
grant insert on public.discount_redemptions to kitsyuu_website;
grant usage on sequence public.discount_redemptions_id_seq to kitsyuu_website;
grant update (coupon_code) on public.carts to kitsyuu_website;
do $$ begin
  execute 'drop policy if exists "app admin: all rows" on public.price_history';
  execute 'create policy "app admin: all rows" on public.price_history for all to kitsyuu_admin using (true) with check (true)';
  execute 'drop policy if exists "app admin: all rows" on public.price_changes';
  execute 'create policy "app admin: all rows" on public.price_changes for all to kitsyuu_admin using (true) with check (true)';
  execute 'drop policy if exists "app admin: all rows" on public.discounts';
  execute 'create policy "app admin: all rows" on public.discounts for all to kitsyuu_admin using (true) with check (true)';
  execute 'drop policy if exists "app admin: all rows" on public.discount_redemptions';
  execute 'create policy "app admin: all rows" on public.discount_redemptions for all to kitsyuu_admin using (true) with check (true)';
end $$;
drop policy if exists "app website: active discounts" on public.discounts;
create policy "app website: active discounts" on public.discounts for select to kitsyuu_website using (is_active);
drop policy if exists "app website: redemptions" on public.discount_redemptions;
create policy "app website: redemptions" on public.discount_redemptions for all to kitsyuu_website using (true) with check (true);
drop policy if exists "app website: discount settings" on public.settings;
create policy "app website: discount settings" on public.settings for select to kitsyuu_website using (key like 'discounts.%');

insert into public.permissions (code, module, description) values
  ('pricing.read', 'pricing', 'View prices, discounts, coupons and price history'),
  ('pricing.manage', 'pricing', 'Change prices, schedule price changes and manage discounts and coupons')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'pricing.read'), ('super_admin', 'pricing.manage'), ('admin', 'pricing.read'), ('admin', 'pricing.manage'),
  ('manager', 'pricing.read'), ('manager', 'pricing.manage'), ('accountant', 'pricing.read'), ('sales', 'pricing.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
