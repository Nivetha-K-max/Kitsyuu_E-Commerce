-- Client change request: collections grouped as Men / Women / Sale, and a tag-based attribute system.
-- Additive only. Existing collections (New Arrivals) and every product membership stay exactly as they are; existing
-- attributes, values and product tags are unchanged (every existing value stays active). Nothing is deleted.
-- Safe to re-run.

-- ---------------------------------------------------------------- A. collection groups
-- A group is how staff find collections in the admin (Men, Women, Sale as the client asked; more can be added).
-- A collection belongs to at most one group; a product can be in any number of collections (collection_products,
-- unchanged). Category / subcategory stay a separate concept on the product.
create table if not exists public.collection_groups (
  id         text primary key check (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  label      text not null check (length(btrim(label)) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
insert into public.collection_groups (id, label, sort_order) values ('men', 'Men', 0), ('women', 'Women', 1), ('sale', 'Sale', 2)
on conflict (id) do nothing;

alter table public.collections add column if not exists group_id text references public.collection_groups (id) on delete set null;
-- Search-engine text for the collection's page (empty = the store's defaults). Nothing is pre-filled.
alter table public.collections add column if not exists seo_title text;
alter table public.collections add column if not exists seo_description text;
do $$ begin
  alter table public.collections add constraint collections_seo_lengths check (
    (seo_title is null or length(seo_title) between 1 and 70) and (seo_description is null or length(seo_description) between 1 and 160));
exception when duplicate_object then null; end $$;

-- The three collections the client asked for, one per group. Created HIDDEN and EMPTY: no product is guessed into Men or
-- Women; staff add products, then show each collection in the store. (Skipped if a collection with that id exists.)
insert into public.collections (id, label, data_status, note, is_active, sort_order, group_id)
select x.id, x.label, 'official', null, false, (select coalesce(max(sort_order), 0) + 1 from public.collections) + x.n, x.id
from (values ('men', 'Men', 0), ('women', 'Women', 1), ('sale', 'Sale', 2)) x(id, label, n)
on conflict (id) do nothing;

alter table public.collection_groups enable row level security;
grant select on public.collection_groups to anon, authenticated, kitsyuu_website;
grant select, insert, update on public.collection_groups to kitsyuu_admin;
drop policy if exists "collection_groups: public read" on public.collection_groups;
create policy "collection_groups: public read" on public.collection_groups for select to anon, authenticated using (true);
drop policy if exists "app website: rows" on public.collection_groups;
create policy "app website: rows" on public.collection_groups for select to kitsyuu_website using (true);
drop policy if exists "app admin: all rows" on public.collection_groups;
create policy "app admin: all rows" on public.collection_groups for all to kitsyuu_admin using (true) with check (true);

-- ---------------------------------------------------------------- B. attributes as tags
-- Single choice (Fit: one value) or several (Colour: Black and Grey). Every existing attribute stays "several", as today.
alter table public.attributes add column if not exists selection text not null default 'multi';
do $$ begin
  alter table public.attributes add constraint attributes_selection_check check (selection in ('single', 'multi'));
exception when duplicate_object then null; end $$;
-- A value is deactivated instead of deleted: products keep it, the store stops offering it as a filter, staff cannot
-- pick it for more products. Optional colour swatch (#rrggbb) for colour values.
alter table public.attribute_values add column if not exists is_active boolean not null default true;
alter table public.attribute_values add column if not exists swatch text;
do $$ begin
  alter table public.attribute_values add constraint attribute_values_swatch_check check (swatch is null or swatch ~ '^#[0-9a-f]{6}$');
exception when duplicate_object then null; end $$;
comment on column public.attribute_values.is_active is 'Inactive values stay on the products that have them but are not offered in the store filters or for new tagging.';
