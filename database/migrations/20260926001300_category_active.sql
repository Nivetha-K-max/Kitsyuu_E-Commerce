-- KITSYUU platform M4: category active flag and description (additive), and storefront visibility of categories.
-- is_active / description were part of the approved v2 catalogue design but were not added in M2.
-- Inactive categories are hidden from the storefront by the READ policies below (anon/authenticated and the website
-- role), so the website needs no code change. The admin app (core services) refuses to deactivate a category while an
-- active product uses it or while it has active subcategories, so no visible product ever points at a hidden category.
-- The policy change narrows existing public access; it never widens it.
-- Safe to re-run.

alter table public.categories add column if not exists is_active boolean not null default true;
alter table public.categories add column if not exists description text not null default '';
comment on column public.categories.is_active is 'Inactive categories are hidden from the storefront (RLS). Deactivation is refused while active products use the category.';

drop policy if exists "categories: public read" on public.categories;
create policy "categories: public read" on public.categories for select to anon, authenticated using (is_active);

drop policy if exists "app website: rows" on public.categories;
create policy "app website: rows" on public.categories for select to kitsyuu_website using (is_active);
