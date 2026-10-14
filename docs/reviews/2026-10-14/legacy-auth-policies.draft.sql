-- DRAFT — NOT APPLIED, NOT IN database/migrations. Review artefact only (2026-10-14).
-- Proposed file name if adopted: database/migrations/20261014005200_retire_supabase_auth_policies.sql (005000 is taken by the staff branch scope)
--
-- KITSYUU: retire the Supabase-Auth-era RLS policies, helper functions, trigger and default grants.
-- What replaced them (already live):
--   * staff writes to catalogue/orders/stock  -> kitsyuu_admin role ("app admin: all rows", 20260925001100) + RBAC in packages/core
--   * customer reads of own profile/addresses/cart/wishlist/orders -> kitsyuu_website role ("app website: rows", 20260925001100,
--     20260928001600) + ownership checks in packages/core / packages/auth
--   * product image uploads -> Storage REST API with the service-role key (apps/admin/lib/server.ts:53, packages/core/src/storage.ts)
--   * Supabase Auth users -> public.customers (20260925000500, 20260927001400) with platform sessions
-- What is KEPT on purpose:
--   * anon (+authenticated) SELECT policies on the catalogue: the store still reads the catalogue through the public anon key
--     (apps/website/lib/supabase/public.ts) until the planned move to the website role ("Step 6").
--   * "product-images: public read" on storage.objects (public bucket).
--   * auth.users, public.profiles and every user_id / changed_by / created_by column and FK: data, not policy. Dropping them is a
--     later, separate migration (the legacy verify-on-login check still needs auth.users while LEGACY_SUPABASE_AUTH is on).
-- Nothing here deletes or rewrites rows. Safe to re-run (every statement is guarded / idempotent).

-- ---------------------------------------------------------------- 1. catalogue read policies: same rows, without is_admin()
-- 20260925000200 lines 52-61 OR'ed public.is_admin() into the public read policies. Recreate them with the anon-visible
-- condition only, so is_admin() can be dropped. (Same predicate as the kitsyuu_website policies in 20260925001100:104-110.)
drop policy if exists "products: public read active" on public.products;
create policy "products: public read active" on public.products for select to anon, authenticated
  using (status = 'active');

drop policy if exists "variants: public read" on public.product_variants;
create policy "variants: public read" on public.product_variants for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));

drop policy if exists "images: public read" on public.product_images;
create policy "images: public read" on public.product_images for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));

-- ---------------------------------------------------------------- 2. Supabase-admin write policies (authenticated + is_admin)
drop policy if exists "categories: admin write"          on public.categories;
drop policy if exists "products: admin write"            on public.products;
drop policy if exists "variants: admin write"            on public.product_variants;
drop policy if exists "images: admin write"              on public.product_images;
drop policy if exists "collections: admin write"         on public.collections;
drop policy if exists "collection_products: admin write" on public.collection_products;
drop policy if exists "relations: admin write"           on public.product_relations;
drop policy if exists "orders: admin update"             on public.orders;
drop policy if exists "status_history: admin insert"     on public.order_status_history;
drop policy if exists "inventory: admin read"            on public.inventory_movements;
drop policy if exists "addresses: admin read"            on public.addresses;

-- ---------------------------------------------------------------- 3. Supabase-customer owner policies (auth.uid())
drop policy if exists "profiles: read own or admin"       on public.profiles;
drop policy if exists "profiles: update own"              on public.profiles;
drop policy if exists "addresses: owner"                  on public.addresses;
drop policy if exists "cart: owner"                       on public.cart_items;
drop policy if exists "wishlist: owner"                   on public.wishlist_items;
drop policy if exists "orders: read own or admin"         on public.orders;
drop policy if exists "order_items: read own or admin"    on public.order_items;
drop policy if exists "status_history: read own or admin" on public.order_status_history;

-- ---------------------------------------------------------------- 4. Storage: admin write policies (uploads use the service role)
drop policy if exists "product-images: admin insert" on storage.objects;
drop policy if exists "product-images: admin update" on storage.objects;
drop policy if exists "product-images: admin delete" on storage.objects;

-- ---------------------------------------------------------------- 5. default grants that only those policies used
-- Tables created in 20260925000100 never had their Supabase default privileges revoked (later tables do, per the README
-- convention). With the policies gone RLS already denies everything; the revokes make it explicit (defence in depth).
revoke all on public.profiles, public.addresses, public.cart_items, public.wishlist_items, public.orders, public.order_items,
  public.order_status_history, public.inventory_movements, public.payment_events
  from anon, authenticated;
-- Catalogue: keep SELECT for the public API, remove write privileges.
revoke insert, update, delete, truncate, references, trigger on public.categories, public.products, public.product_variants,
  public.product_images, public.collections, public.collection_products, public.product_relations
  from anon, authenticated;

-- ---------------------------------------------------------------- 6. trigger + functions
-- No more public.profiles rows for new Supabase sign-ups. Dropping a trigger needs ownership of auth.users, which the
-- hosted project's "postgres" role may not have; if so, neutralise the function instead (it stays, does nothing).
do $$ begin
  begin
    drop trigger if exists on_auth_user_created on auth.users;
    drop function if exists public.handle_new_user();
  exception when insufficient_privilege then
    raise notice 'cannot drop trigger on auth.users (not owner): handle_new_user() becomes a no-op instead';
    execute $f$create or replace function public.handle_new_user() returns trigger
      language plpgsql security definer set search_path = '' as $b$ begin return new; end $b$$f$;
  end;
end $$;
-- is_admin() must go after every policy that calls it (sections 1, 2, 4). Fails loudly if anything still depends on it.
drop function if exists public.is_admin();

-- ---------------------------------------------------------------- 7. post-conditions (abort the transaction if not met)
do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))
     and (coalesce(qual, '') ~* 'auth\.(uid|jwt|role)\(|is_admin\(' or coalesce(with_check, '') ~* 'auth\.(uid|jwt|role)\(|is_admin\(');
  if n > 0 then raise exception 'retire legacy auth: % policies still reference auth.uid()/jwt()/role() or is_admin()', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('products', 'product_variants', 'product_images', 'categories', 'collections', 'collection_products', 'product_relations')
     and 'anon' = any(roles) and cmd = 'SELECT';
  if n < 7 then raise exception 'retire legacy auth: expected 7 anon catalogue read policies, found %', n; end if;
end $$;
