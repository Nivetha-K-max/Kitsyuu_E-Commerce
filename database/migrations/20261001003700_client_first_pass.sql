-- KITSYUU client change request, first pass. Additive only; safe to re-run. No existing row is changed: every new column
-- starts empty and every new behaviour is off until staff set it up.
-- A. Sale price: a separate sale price (with optional dates) on products and sizes; the base price is never overwritten.
--    Price history also records sale-price changes. New permission pricing.sale_override (exceed the staff discount limit).
-- B. Abandoned checkout: checkout_reminders records the one reminder per unpaid order (no duplicates).
-- C. Newsletter: newsletter_subscribers with consent, unsubscribe token (hash only) and status; one row per email.
-- D. Billing address: orders.billing_address (null = same as the delivery address, as for every existing order).
-- E. Size charts: size_charts, assigned to a category or a product (a product's own chart wins).
-- F. Production ↔ purchasing: production_purchase_orders links a production order to the purchase orders raised for it.

-- ---------------------------------------------------------------- A. sale price
alter table public.products         add column if not exists sale_price_paise integer check (sale_price_paise is null or sale_price_paise > 0);
alter table public.products         add column if not exists sale_starts_at   timestamptz;
alter table public.products         add column if not exists sale_ends_at     timestamptz;
alter table public.product_variants add column if not exists sale_price_paise integer check (sale_price_paise is null or sale_price_paise > 0);
do $$ begin
  alter table public.products add constraint products_sale_dates check (sale_ends_at is null or sale_starts_at is null or sale_ends_at > sale_starts_at);
exception when duplicate_object then null; end $$;
grant update (sale_price_paise) on public.product_variants to kitsyuu_admin;

alter table public.price_history drop constraint if exists price_history_field_check;
alter table public.price_history add constraint price_history_field_check check (field in ('price', 'compare_at', 'sale'));

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
  if new.sale_price_paise is distinct from old.sale_price_paise then
    insert into public.price_history (product_id, variant_id, field, old_paise, new_paise, source, change_id, staff_user_id)
    values (v_product, v_variant, 'sale', old.sale_price_paise, new.sale_price_paise, v_source, v_change, v_staff);
  end if;
  return new;
end $$;
revoke all on function public.record_price_history() from public, anon, authenticated;
drop trigger if exists products_price_history on public.products;
create trigger products_price_history after update of price_paise, compare_at_paise, sale_price_paise on public.products
  for each row execute function public.record_price_history();
drop trigger if exists product_variants_price_history on public.product_variants;
create trigger product_variants_price_history after update of price_paise, compare_at_paise, sale_price_paise on public.product_variants
  for each row execute function public.record_price_history();

insert into public.permissions (code, module, description) values
  ('pricing.sale_override', 'pricing', 'Set a sale price deeper than the maximum sale discount in Settings')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values ('super_admin', 'pricing.sale_override'), ('admin', 'pricing.sale_override')) x(role, code) on r.code = x.role
on conflict do nothing;

-- ---------------------------------------------------------------- B. abandoned checkout
create table if not exists public.checkout_reminders (
  order_id   uuid primary key references public.orders (id) on delete cascade,
  status     text not null check (status in ('sending', 'sent', 'failed')),
  recipient  text not null,
  error      text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
alter table public.checkout_reminders enable row level security;
revoke all on public.checkout_reminders from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.checkout_reminders to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.checkout_reminders;
create policy "app admin: all rows" on public.checkout_reminders for all to kitsyuu_admin using (true) with check (true);

-- ---------------------------------------------------------------- C. newsletter
create table if not exists public.newsletter_subscribers (
  id                     uuid primary key default gen_random_uuid(),
  email                  text not null check (email = lower(email) and length(email) between 3 and 254 and email like '%_@_%.__%'),
  status                 text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed')),
  consent_text           text not null check (length(consent_text) between 1 and 300),
  consented_at           timestamptz not null default now(),
  source                 text not null default 'store' check (source ~ '^[a-z][a-z_]{1,31}$'),
  customer_id            uuid references public.customers (id) on delete set null,
  unsubscribe_token_hash bytea not null unique,
  unsubscribed_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists newsletter_subscribers_email_key on public.newsletter_subscribers (email);
drop trigger if exists newsletter_subscribers_updated_at on public.newsletter_subscribers;
create trigger newsletter_subscribers_updated_at before update on public.newsletter_subscribers for each row execute function public.set_updated_at();
alter table public.newsletter_subscribers enable row level security;
revoke all on public.newsletter_subscribers from anon, authenticated, kitsyuu_website;
grant select, update (status, unsubscribed_at, unsubscribe_token_hash) on public.newsletter_subscribers to kitsyuu_admin;
-- The store signs people up and unsubscribes them (core scopes each call to one email or one token).
grant select, insert, update (status, consent_text, consented_at, source, customer_id, unsubscribe_token_hash, unsubscribed_at)
  on public.newsletter_subscribers to kitsyuu_website;
drop policy if exists "app admin: all rows" on public.newsletter_subscribers;
create policy "app admin: all rows" on public.newsletter_subscribers for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app website: rows" on public.newsletter_subscribers;
create policy "app website: rows" on public.newsletter_subscribers for all to kitsyuu_website using (true) with check (true);

-- ---------------------------------------------------------------- D. billing address
alter table public.orders add column if not exists billing_address jsonb;

-- ---------------------------------------------------------------- E. size charts
create table if not exists public.size_charts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(btrim(name)) between 1 and 80),
  unit       text not null default 'cm' check (unit in ('cm', 'in')),
  headers    text[] not null check (cardinality(headers) between 1 and 8),
  rows       jsonb not null default '[]'::jsonb,
  notes      text check (notes is null or length(notes) <= 500),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists size_charts_updated_at on public.size_charts;
create trigger size_charts_updated_at before update on public.size_charts for each row execute function public.set_updated_at();
alter table public.products   add column if not exists size_chart_id uuid references public.size_charts (id) on delete set null;
alter table public.categories add column if not exists size_chart_id uuid references public.size_charts (id) on delete set null;
alter table public.size_charts enable row level security;
revoke all on public.size_charts from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.size_charts to kitsyuu_admin;
grant select on public.size_charts to anon, authenticated, kitsyuu_website;
drop policy if exists "app admin: all rows" on public.size_charts;
create policy "app admin: all rows" on public.size_charts for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "size_charts: public read active" on public.size_charts;
create policy "size_charts: public read active" on public.size_charts for select to anon, authenticated, kitsyuu_website using (is_active);

-- ---------------------------------------------------------------- F. production ↔ purchasing
create table if not exists public.production_purchase_orders (
  production_order_id uuid not null references public.production_orders (id) on delete cascade,
  purchase_order_id   uuid not null references public.purchase_orders (id) on delete cascade,
  created_by          uuid references public.staff_users (id) on delete set null,
  created_at          timestamptz not null default now(),
  primary key (production_order_id, purchase_order_id)
);
create index if not exists production_purchase_orders_po_idx on public.production_purchase_orders (purchase_order_id);
alter table public.production_purchase_orders enable row level security;
revoke all on public.production_purchase_orders from anon, authenticated, kitsyuu_website;
grant select, insert on public.production_purchase_orders to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.production_purchase_orders;
create policy "app admin: all rows" on public.production_purchase_orders for all to kitsyuu_admin using (true) with check (true);
