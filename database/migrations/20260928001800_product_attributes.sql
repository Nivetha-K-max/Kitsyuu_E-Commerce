-- KITSYUU platform: product attributes for the store filters (Fabric, Sleeve length, Pattern, Occasion, Gender, Brand, …).
-- The business defines the attributes and their values in the admin and tags each product; nothing is pre-filled here,
-- so no attribute, value or product tag is invented by the platform. The storefront shows an attribute as a filter only
-- when it is active and at least one product in the list carries one of its values.
-- Ids are fixed once created (the store uses them in links: /shop?fabric=cotton), like category ids.
-- Additive only: three new tables, their RLS policies and grants. No existing table or row is changed.
-- Safe to re-run.

create table if not exists public.attributes (
  id          text primary key check (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  label       text not null check (length(btrim(label)) between 1 and 60),
  description text not null default '',
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.attributes is 'Product attributes the store can filter by (defined by the business in the admin). Inactive attributes are hidden from the store (RLS).';
drop trigger if exists attributes_updated_at on public.attributes;
create trigger attributes_updated_at before update on public.attributes for each row execute function public.set_updated_at();

create table if not exists public.attribute_values (
  attribute_id text not null references public.attributes (id) on delete cascade,
  slug         text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  label        text not null check (length(btrim(label)) between 1 and 60),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  primary key (attribute_id, slug)
);
comment on table public.attribute_values is 'The values of an attribute (e.g. fabric → cotton). A value in use by a product cannot be deleted (FK restrict).';

create table if not exists public.product_attribute_values (
  product_id   text not null references public.products (id) on delete cascade,
  attribute_id text not null,
  value_slug   text not null,
  created_at   timestamptz not null default now(),
  primary key (product_id, attribute_id, value_slug),
  foreign key (attribute_id, value_slug) references public.attribute_values (attribute_id, slug) on delete restrict
);
create index if not exists product_attribute_values_value_idx on public.product_attribute_values (attribute_id, value_slug);
comment on table public.product_attribute_values is 'Which attribute values a product has (a product can have several values of one attribute).';

alter table public.attributes               enable row level security;
alter table public.attribute_values         enable row level security;
alter table public.product_attribute_values enable row level security;

-- Storefront (Supabase public key and the website role): read-only, and only for active attributes.
grant select on public.attributes, public.attribute_values, public.product_attribute_values to anon, authenticated, kitsyuu_website;
drop policy if exists "attributes: public read" on public.attributes;
create policy "attributes: public read" on public.attributes for select to anon, authenticated using (is_active);
drop policy if exists "attribute_values: public read" on public.attribute_values;
create policy "attribute_values: public read" on public.attribute_values for select to anon, authenticated
  using (exists (select 1 from public.attributes a where a.id = attribute_id and a.is_active));
drop policy if exists "product_attribute_values: public read" on public.product_attribute_values;
create policy "product_attribute_values: public read" on public.product_attribute_values for select to anon, authenticated
  using (exists (select 1 from public.attributes a where a.id = attribute_id and a.is_active));
drop policy if exists "app website: rows" on public.attributes;
create policy "app website: rows" on public.attributes for select to kitsyuu_website using (is_active);
drop policy if exists "app website: rows" on public.attribute_values;
create policy "app website: rows" on public.attribute_values for select to kitsyuu_website
  using (exists (select 1 from public.attributes a where a.id = attribute_id and a.is_active));
drop policy if exists "app website: rows" on public.product_attribute_values;
create policy "app website: rows" on public.product_attribute_values for select to kitsyuu_website
  using (exists (select 1 from public.attributes a where a.id = attribute_id and a.is_active));

-- Admin app: full access; which staff may change what is decided by permissions in the app
-- (categories.write for the attribute definitions, products.write for tagging products).
grant select, insert, update, delete on public.attributes, public.attribute_values, public.product_attribute_values to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.attributes;
create policy "app admin: all rows" on public.attributes for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.attribute_values;
create policy "app admin: all rows" on public.attribute_values for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.product_attribute_values;
create policy "app admin: all rows" on public.product_attribute_values for all to kitsyuu_admin using (true) with check (true);
