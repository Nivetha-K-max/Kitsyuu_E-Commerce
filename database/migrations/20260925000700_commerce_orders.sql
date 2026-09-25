-- KITSYUU platform M2: database carts and wishlists (for M8) and new order columns (additive only).
-- The website keeps its browser (localStorage) cart and wishlist until M8; these tables start empty.
-- cart_items and wishlist_items already exist from Phase 4.2 (empty, keyed by the Supabase Auth user), so they are
-- extended with a link to the new carts / wishlists instead of being recreated.
-- Safe to re-run: every statement is guarded.

-- ---------- types ----------
do $$ begin
  create type public.cart_status as enum ('active', 'converted', 'merged', 'abandoned');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_status as enum ('unpaid', 'pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded');
exception when duplicate_object then null; end $$;

-- ---------- carts ----------
-- A cart belongs to a customer, or to a guest identified by the SHA-256 of a random cookie token.
create table if not exists public.carts (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid references public.customers (id) on delete cascade,
  guest_token_hash bytea unique check (octet_length(guest_token_hash) = 32),
  status           public.cart_status not null default 'active',
  currency         text not null default 'INR',
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint carts_has_owner check (customer_id is not null or guest_token_hash is not null)
);
create unique index if not exists carts_one_active_per_customer on public.carts (customer_id) where status = 'active' and customer_id is not null;
drop trigger if exists carts_updated_at on public.carts;
create trigger carts_updated_at before update on public.carts for each row execute function public.set_updated_at();

alter table public.cart_items add column if not exists cart_id uuid references public.carts (id) on delete cascade;
create unique index if not exists cart_items_cart_variant_key on public.cart_items (cart_id, variant_id) where cart_id is not null;
comment on column public.cart_items.cart_id is 'M8 database cart. Legacy user_id (Supabase Auth) stays until M6/M8.';

-- ---------- wishlists ----------
create table if not exists public.wishlists (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists wishlists_updated_at on public.wishlists;
create trigger wishlists_updated_at before update on public.wishlists for each row execute function public.set_updated_at();

alter table public.wishlist_items add column if not exists wishlist_id uuid references public.wishlists (id) on delete cascade;
create unique index if not exists wishlist_items_wishlist_product_key on public.wishlist_items (wishlist_id, product_id) where wishlist_id is not null;
comment on column public.wishlist_items.wishlist_id is 'M8 database wishlist. Legacy user_id (Supabase Auth) stays until M6/M8.';

-- ---------- orders: link to customers + payment status (nullable; there are no orders yet) ----------
alter table public.orders add column if not exists customer_id uuid references public.customers (id) on delete restrict;
alter table public.orders add column if not exists payment_status public.payment_status;
create index if not exists orders_customer_idx on public.orders (customer_id, created_at desc) where customer_id is not null;

-- ---------- lock down the new tables ----------
alter table public.carts     enable row level security;
alter table public.wishlists enable row level security;
revoke all on public.carts, public.wishlists from anon, authenticated;
