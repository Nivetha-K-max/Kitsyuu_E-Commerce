-- KITSYUU store: core schema (Phase 4.2)
-- Money is integer paise. Product ids keep the existing catalogue ids (ky-proto-001 …) so they match
-- the storefront, cart and wishlist data exactly. New products get a generated kts-xxxxxxxx id.

-- ---------- enums ----------
create type public.app_role as enum ('customer', 'admin');
create type public.product_status as enum ('active', 'draft', 'archived');
create type public.order_status as enum ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'payment_failed', 'refunded');

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- catalogue ----------
create table public.categories (
  id          text primary key,                              -- 'tops', 'tops.hoodies'
  label       text not null,
  parent_id   text references public.categories (id) on delete restrict,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create table public.products (
  id             text primary key default ('kts-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  sku            text not null unique,
  slug           text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name           text not null,
  description    text not null default '',
  category_id    text not null references public.categories (id),
  subcategory_id text references public.categories (id),
  price_paise    integer not null check (price_paise >= 0),
  colour_label   text,
  colour_swatch  text,
  features       text[] not null default '{}',
  is_featured    boolean not null default false,
  status         public.product_status not null default 'active',
  data_status    text not null default 'prototype' check (data_status in ('prototype', 'official')),
  catalogue_ref  text,
  material       text,
  care           text,
  origin         text,
  review         jsonb not null default '{}'::jsonb,           -- image-rights review flags from the catalogue
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index products_category_idx on public.products (category_id);
create index products_subcategory_idx on public.products (subcategory_id);
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();

create table public.product_variants (
  id           uuid primary key default gen_random_uuid(),
  product_id   text not null references public.products (id) on delete cascade,
  size         text not null,
  sku          text not null unique,                          -- product sku + '-' + size
  sort_order   int  not null default 0,
  price_paise  integer check (price_paise >= 0),              -- null = use the product price
  stock_qty    integer not null default 0 check (stock_qty >= 0),
  stock_source text not null default 'manual' check (stock_source in ('prototype', 'manual', 'official')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_id, size)
);
comment on column public.product_variants.stock_source is 'prototype = demo stock seeded for development (10 per size), not real inventory';
create trigger product_variants_updated_at before update on public.product_variants for each row execute function public.set_updated_at();

create table public.product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   text not null references public.products (id) on delete cascade,
  storage_path text not null,                                 -- path inside the product-images bucket
  width        int,
  height       int,
  alt          text not null default '',
  quality      text not null default 'prototype' check (quality in ('prototype', 'official')),
  zoom         boolean not null default false,
  is_primary   boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  unique (product_id, storage_path)
);
create unique index product_images_one_primary on public.product_images (product_id) where is_primary;

create table public.collections (
  id          text primary key,                               -- 'new-arrivals'
  label       text not null,
  data_status text not null default 'prototype',
  note        text
);
create table public.collection_products (
  collection_id text not null references public.collections (id) on delete cascade,
  product_id    text not null references public.products (id) on delete cascade,
  position      int  not null,
  primary key (collection_id, product_id)
);

create table public.product_relations (
  product_id text not null references public.products (id) on delete cascade,
  related_id text not null references public.products (id) on delete cascade,
  kind       text not null default 'styled_with' check (kind in ('styled_with')),
  position   int  not null default 0,
  primary key (product_id, related_id, kind)
);

-- ---------- customers ----------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  phone      text,
  role       public.app_role not null default 'customer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();

create table public.addresses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  full_name  text not null,
  phone      text not null,
  line1      text not null,
  line2      text,
  city       text not null,
  state      text not null,
  pin        text not null check (pin ~ '^[1-9][0-9]{5}$'),
  country    text not null default 'India',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index addresses_user_idx on public.addresses (user_id);

create table public.cart_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  qty        int  not null check (qty between 1 and 10),     -- same cap as the storefront
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, variant_id)                                -- same product + size merges into one line
);
create trigger cart_items_updated_at before update on public.cart_items for each row execute function public.set_updated_at();

create table public.wishlist_items (
  user_id    uuid not null references auth.users (id) on delete cascade,
  product_id text not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

-- ---------- orders ----------
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  order_number        text not null unique default ('KTS-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
  user_id             uuid not null references auth.users (id) on delete restrict,
  status              public.order_status not null default 'pending_payment',
  currency            text not null default 'INR',
  subtotal_paise      integer not null check (subtotal_paise >= 0),
  total_paise         integer not null check (total_paise >= 0),   -- prices are tax-inclusive prototype prices; no GST line
  contact             jsonb not null default '{}'::jsonb,
  shipping_address    jsonb not null default '{}'::jsonb,
  razorpay_order_id   text unique,
  razorpay_payment_id text unique,
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index orders_user_idx on public.orders (user_id, created_at desc);
create index orders_status_idx on public.orders (status, created_at desc);
create trigger orders_updated_at before update on public.orders for each row execute function public.set_updated_at();

create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete cascade,
  product_id       text references public.products (id) on delete set null,
  variant_id       uuid references public.product_variants (id) on delete set null,
  sku              text not null,                             -- snapshot at purchase time
  name             text not null,
  size             text not null,
  image_path       text,
  unit_price_paise integer not null check (unit_price_paise >= 0),
  qty              int not null check (qty between 1 and 10),
  line_total_paise integer not null check (line_total_paise >= 0)
);
create index order_items_order_idx on public.order_items (order_id);

create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  changed_by  uuid references auth.users (id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

create table public.inventory_movements (
  id         bigint generated always as identity primary key,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  delta      int  not null,
  reason     text not null check (reason in ('seed', 'sale', 'restock', 'admin_adjust', 'cancel')),
  order_id   uuid references public.orders (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);
create index inventory_movements_variant_idx on public.inventory_movements (variant_id, created_at desc);

create table public.payment_events (
  id           text primary key,                              -- Razorpay event id: each event is processed once
  type         text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
