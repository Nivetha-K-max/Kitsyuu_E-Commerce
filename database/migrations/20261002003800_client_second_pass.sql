-- Client change request, SECOND PASS: cash on delivery (COD), loyalty points, order editing before shipment.
-- Additive only: new columns have defaults that describe every existing order exactly as it is today (paid online, no
-- points, no COD fee, never edited); new tables start empty. Nothing is switched on: COD, loyalty earning and loyalty
-- redemption stay off until the business sets their settings (no row = off). No existing row is changed.

-- ---------------------------------------------------------------- A. cash on delivery
-- How the customer pays. Every existing order was placed for online payment.
alter table public.orders add column if not exists payment_method text not null default 'online';
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check (payment_method in ('online', 'cod'));
-- COD collection: to collect (placed) → collected (cash received) or refused (the customer did not take the parcel).
alter table public.orders add column if not exists cod_status text;
alter table public.orders drop constraint if exists orders_cod_status_check;
alter table public.orders add constraint orders_cod_status_check check (
  cod_status is null or cod_status in ('to_collect', 'collected', 'refused'));
alter table public.orders drop constraint if exists orders_cod_status_method;
alter table public.orders add constraint orders_cod_status_method check ((payment_method = 'cod') = (cod_status is not null));
-- The COD fee charged on the order (the delivery rate's COD fee at checkout); 0 for every other order.
alter table public.orders add column if not exists cod_fee_paise integer not null default 0;
alter table public.orders drop constraint if exists orders_cod_fee_check;
alter table public.orders add constraint orders_cod_fee_check check (cod_fee_paise >= 0 and (payment_method = 'cod' or cod_fee_paise = 0));

-- Staff record COD outcomes (collection, refusal, cancellation before dispatch).
insert into public.permissions (code, module, description) values
  ('orders.cod', 'orders', 'Record cash-on-delivery collection or refusal, and cancel cash-on-delivery orders before dispatch')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- B. loyalty points
-- One balance per customer, kept in step with the ledger below in the same transaction (never written from a browser).
create table if not exists public.loyalty_accounts (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  balance     integer not null default 0 check (balance >= 0),
  updated_at  timestamptz not null default now()
);
-- Every change of points. Positive rows (earned, restored, added) keep what is still unused in "remaining", so points are
-- spent oldest first and only unused points expire.
create table if not exists public.loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  points      integer not null check (points <> 0),
  kind        text not null check (kind in ('earn', 'redeem', 'adjust', 'import', 'restore', 'reverse', 'expire')),
  order_id    uuid references public.orders (id) on delete set null,
  reverses_id uuid references public.loyalty_transactions (id) on delete set null,
  reason      text check (reason is null or length(reason) <= 300),
  staff_id    uuid references public.staff_users (id) on delete set null,
  remaining   integer check (remaining is null or (remaining >= 0 and points > 0 and remaining <= points)),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint loyalty_sign check (
    (kind in ('earn', 'import', 'restore') and points > 0) or (kind in ('redeem', 'reverse', 'expire') and points < 0) or kind = 'adjust'),
  constraint loyalty_positive_remaining check ((points > 0) = (remaining is not null))
);
create index if not exists loyalty_transactions_customer on public.loyalty_transactions (customer_id, created_at desc);
create index if not exists loyalty_transactions_open on public.loyalty_transactions (customer_id, created_at) where remaining > 0;
-- One earning and one redemption per order; each row is reversed at most once.
create unique index if not exists loyalty_one_earn_per_order on public.loyalty_transactions (order_id) where kind = 'earn';
create unique index if not exists loyalty_one_redeem_per_order on public.loyalty_transactions (order_id) where kind = 'redeem';
create unique index if not exists loyalty_one_reversal on public.loyalty_transactions (reverses_id) where reverses_id is not null;

-- Points used on an order and what they took off (0 on every existing order).
alter table public.orders add column if not exists loyalty_points_used integer not null default 0;
alter table public.orders add column if not exists loyalty_discount_paise integer not null default 0;
alter table public.orders drop constraint if exists orders_loyalty_check;
alter table public.orders add constraint orders_loyalty_check check (loyalty_points_used >= 0 and loyalty_discount_paise >= 0
  and (loyalty_points_used > 0) = (loyalty_discount_paise > 0));

alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_transactions enable row level security;
revoke all on public.loyalty_accounts, public.loyalty_transactions from anon, authenticated, kitsyuu_website;
grant select, insert, update (balance, updated_at) on public.loyalty_accounts to kitsyuu_admin, kitsyuu_website;
grant select, insert, update (remaining) on public.loyalty_transactions to kitsyuu_admin, kitsyuu_website;
drop policy if exists "app admin: all rows" on public.loyalty_accounts;
create policy "app admin: all rows" on public.loyalty_accounts for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app website: rows" on public.loyalty_accounts;
create policy "app website: rows" on public.loyalty_accounts for all to kitsyuu_website using (true) with check (true);
drop policy if exists "app admin: all rows" on public.loyalty_transactions;
create policy "app admin: all rows" on public.loyalty_transactions for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app website: rows" on public.loyalty_transactions;
create policy "app website: rows" on public.loyalty_transactions for all to kitsyuu_website using (true) with check (true);

-- The store reads the loyalty settings (earning and redemption rules) like the other commerce settings.
drop policy if exists "app website: loyalty settings" on public.settings;
create policy "app website: loyalty settings" on public.settings for select to kitsyuu_website using (key like 'loyalty.%');

insert into public.permissions (code, module, description) values
  ('loyalty.read', 'loyalty', 'View loyalty point balances and history'),
  ('loyalty.adjust', 'loyalty', 'Add or remove loyalty points (with a reason) and import opening balances')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- C. order editing before shipment
-- One row per staff edit: what the order was and became, and the money difference. A lower total on an order paid online
-- leaves a refund due, made from the order page (through the payment provider or recorded as paid outside the platform).
create table if not exists public.order_edits (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete cascade,
  staff_id         uuid references public.staff_users (id) on delete set null,
  note             text not null check (length(note) between 1 and 500),
  before           jsonb not null,
  after            jsonb not null,
  total_before     integer not null,
  total_after      integer not null check (total_after >= 0),
  refund_due_paise integer not null default 0 check (refund_due_paise >= 0),
  refund_id        uuid references public.refunds (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists order_edits_order on public.order_edits (order_id, created_at);
alter table public.order_edits enable row level security;
revoke all on public.order_edits from anon, authenticated, kitsyuu_website;
grant select, insert, update (refund_id) on public.order_edits to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.order_edits;
create policy "app admin: all rows" on public.order_edits for all to kitsyuu_admin using (true) with check (true);

-- The admin app may now change the lines of an order that has not shipped (core checks everything; see order-edit.ts).
grant update (variant_id, sku, size, image_path, qty, line_total_paise), delete on public.order_items to kitsyuu_admin;

insert into public.permissions (code, module, description) values
  ('orders.edit', 'orders', 'Edit an order before it ships (sizes, quantities, delivery address)')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- permissions for the full-access roles
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'orders.cod'), ('admin', 'orders.cod'),
  ('super_admin', 'orders.edit'), ('admin', 'orders.edit'),
  ('super_admin', 'loyalty.read'), ('admin', 'loyalty.read'),
  ('super_admin', 'loyalty.adjust'), ('admin', 'loyalty.adjust')
) x(role, code) on r.code = x.role
on conflict do nothing;
