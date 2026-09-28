-- KITSYUU platform M11: catalogue completion. Additive, plus a policy change that only NARROWS public access.
-- 1. products.seo_title / seo_description: optional search-engine text per product (empty = the store's defaults).
-- 2. collections.is_active + sort_order: staff can create collections (hidden until activated) and order them.
--    Every existing collection (New Arrivals) stays active, so the store looks exactly the same after this migration.
-- 3. The store (public key and website role) sees only active collections and their product lists. Before, it saw all
--    collections; since all existing ones are active, nothing visible changes.
-- 4. product_relations.kind keeps its single value 'styled_with' ("Complete the look"), now managed from the admin.
-- Safe to re-run.

alter table public.products add column if not exists seo_title text;
alter table public.products add column if not exists seo_description text;
do $$ begin
  alter table public.products add constraint products_seo_lengths check (
    (seo_title is null or length(seo_title) between 1 and 70) and (seo_description is null or length(seo_description) between 1 and 160));
exception when duplicate_object then null; end $$;

alter table public.collections add column if not exists is_active boolean not null default true;
alter table public.collections add column if not exists sort_order integer not null default 0;
comment on column public.collections.is_active is 'Inactive collections are hidden from the store (RLS). New collections are created inactive by the admin.';

drop policy if exists "collections: public read" on public.collections;
create policy "collections: public read" on public.collections for select to anon, authenticated using (is_active);
drop policy if exists "collection_products: public read" on public.collection_products;
create policy "collection_products: public read" on public.collection_products for select to anon, authenticated
  using (exists (select 1 from public.collections c where c.id = collection_id and c.is_active));

drop policy if exists "app website: rows" on public.collections;
create policy "app website: rows" on public.collections for select to kitsyuu_website using (is_active);
drop policy if exists "app website: rows" on public.collection_products;
create policy "app website: rows" on public.collection_products for select to kitsyuu_website
  using (exists (select 1 from public.collections c where c.id = collection_id and c.is_active));
