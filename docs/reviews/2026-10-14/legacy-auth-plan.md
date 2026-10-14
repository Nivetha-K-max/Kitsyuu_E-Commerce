# Retire legacy Supabase Auth policies — migration PLAN (not applied)

Review date 2026-10-14. Read-only review; nothing was run against any database. Draft SQL:
`docs/reviews/2026-10-14/legacy-auth-policies.draft.sql`; the checks and the undo script are also split out as `legacy-auth-preflight.sql` and `legacy-auth-rollback.sql` next to it (untested — must be rehearsed per "Test steps" below).

## 1. Inventory

### 1a. Policies that use auth.uid() / is_admin() (which reads profiles via auth.uid()) or target `authenticated` for writes

All created in `database/migrations/20260925000200_auth_roles_rls.sql` unless noted. "Replaced by" = what serves that access today.

| Table | Policy | Line | Predicate | Replaced by |
|---|---|---|---|---|
| categories | categories: admin write | 50 | authenticated, is_admin() | kitsyuu_admin "app admin: all rows" (20260925001100:71-82) + RBAC `categories.write` |
| products | products: public read active | 52-53 | anon+auth, `status='active' OR is_admin()` | keep for anon; drop the is_admin() arm (store reads via anon key, `apps/website/lib/supabase/public.ts:36`) |
| products | products: admin write | 54 | authenticated, is_admin() | kitsyuu_admin + `products.write` |
| product_variants | variants: public read | 56-57 | anon+auth, is_admin() OR active product | keep for anon without is_admin() |
| product_variants | variants: admin write | 58 | is_admin() | kitsyuu_admin (stock only via adjust_stock) |
| product_images | images: public read | 60-61 | anon+auth, is_admin() OR active | keep for anon without is_admin() |
| product_images | images: admin write | 62 | is_admin() | kitsyuu_admin |
| collections | collections: admin write | 65 | is_admin() | kitsyuu_admin |
| collection_products | collection_products: admin write | 67 | is_admin() | kitsyuu_admin |
| product_relations | relations: admin write | 69 | is_admin() | kitsyuu_admin |
| profiles | profiles: read own or admin | 72-73 | `id = auth.uid() OR is_admin()` | public.customers via kitsyuu_website (20260925000500, 20260927001400) |
| profiles | profiles: update own | 74-75 | `id = auth.uid()` | customer profile via kitsyuu_website |
| addresses | addresses: owner | 79-80 | `user_id = auth.uid()` | `addresses.customer_id` (20260927001400:20) + kitsyuu_website |
| addresses | addresses: admin read | 81 | is_admin() | kitsyuu_admin |
| cart_items | cart: owner | 83-84 | `user_id = auth.uid()` | carts/cart_id (20260925000700, 20260928001600) + kitsyuu_website |
| wishlist_items | wishlist: owner | 86-87 | `user_id = auth.uid()` | wishlists/wishlist_id + kitsyuu_website |
| orders | orders: read own or admin | 90-91 | `user_id = auth.uid() OR is_admin()` | `orders.customer_id` (20260928001600) + kitsyuu_website / kitsyuu_admin |
| orders | orders: admin update | 92-93 | is_admin() | kitsyuu_admin + orders.* permissions |
| order_items | order_items: read own or admin | 95-96 | via orders.user_id = auth.uid() | as orders |
| order_status_history | status_history: read own or admin | 98-99 | via orders.user_id = auth.uid() | as orders |
| order_status_history | status_history: admin insert | 100-101 | is_admin() | kitsyuu_admin (order-state.ts) |
| inventory_movements | inventory: admin read | 103 | is_admin() | kitsyuu_admin |
| storage.objects | product-images: admin insert/update/delete | `20260925000300_storage.sql:10-16` | authenticated + is_admin() | service-role Storage API (`apps/admin/lib/server.ts:53`) |

Not legacy (keep): every `"…: public read"` policy `to anon, authenticated` on catalogue/content tables —
categories (re-created 20260926001300:14), collections / collection_products (20260929002200:22-24), product_relations (0200:68),
attributes / attribute_values / product_attribute_values (20260928001800:50-55), site_content (20260929002700:42), banners
(20260930003300:76), size_charts (20261001003700:133), collection_groups (20261003003900:39), and
"product-images: public read" (0300:8). They reference no auth function; `authenticated` there is harmless (it can only
see what anon sees). They go away only when the store stops using the anon key (Step 6), in a separate migration.

### 1b. Functions, trigger, grants
* `public.is_admin()` — SECURITY DEFINER, reads `profiles.role` via `auth.uid()`; EXECUTE granted to anon, authenticated (0200:8-13).
* `public.handle_new_user()` + trigger `on_auth_user_created` AFTER INSERT ON auth.users (0200:16-24): still creates a
  `profiles` row for every new Supabase sign-up. The hosted project's sign-up endpoint is reachable with the public anon key.
* `grant update (full_name, phone) on public.profiles to authenticated` (0200:28).
* Tables from `20260925000100_schema.sql` (profiles, addresses, cart_items, wishlist_items, orders, order_items,
  order_status_history, inventory_movements, payment_events, catalogue) never had Supabase's default ALL grants to
  anon/authenticated revoked — only RLS stands between the public API and them. Later tables all revoke explicitly.

### 1c. Supabase Auth tables / columns (data, NOT dropped by this plan)
* FKs to auth.users: profiles.id, addresses.user_id, cart_items.user_id, wishlist_items.user_id, orders.user_id (on delete
  restrict), order_status_history.changed_by, inventory_movements.created_by (`20260925000100_schema.sql:107-204`).
* Mirror inserts reading auth.users: 20260925000500:99-102 and 20260927001400:7-12 (both "safe to re-run" — re-running would
  mirror any Supabase account created since; do NOT re-run them; `setup-all.sql` contains them too).

### 1d. App code still using Supabase Auth
* `apps/website/lib/legacy-auth.ts:19-31` — `sb.auth.signInWithPassword` + `signOut` (verify-on-login; flag
  `LEGACY_SUPABASE_AUTH`, `legacyAuthEnabled()` line 14-17: ON in a deployed environment unless `off`, OFF elsewhere).
  Called from `apps/website/app/auth-actions.ts:19` → `packages/auth/src/customer-auth.ts:118-139`.
  GoTrue does not consult RLS, so dropping these policies does NOT break this path.
* `apps/website/app/auth/confirm/route.ts` — old Supabase confirmation links, now only redirects to /login (no Supabase call).
* `database/scripts/promote-admin.mjs:19` — `sb.auth.admin.listUsers` + profiles.role (README: "retired in M6"); becomes
  meaningless once is_admin() is gone. Retire/delete the script in the same change.
* Non-auth Supabase use that stays: `apps/website/lib/supabase/public.ts` (anon catalogue reads), Storage via service role.
* Tooling that references the dropped objects: `database/scripts/db-apply.mjs:28-30` (evidence query for 0200 uses
  is_admin / on_auth_user_created — only matters for `--mark-applied` of 0200, already recorded on live),
  `database/scripts/db-snapshot.mjs:75-76` (fingerprint will change — expected), `database/test/supabase-shim.sql` (unchanged).

## 2. Preconditions
1. Confirm nobody calls PostgREST/Storage with an `authenticated` JWT: Supabase dashboard → API / Storage logs, filter on
   role = authenticated for the last 30 days (only anon and service_role expected). The repo has no such caller.
2. Confirm image uploads in production use `STORAGE_DRIVER=supabase` with the service-role key (apps/admin/lib/server.ts:53),
   not a signed-in Supabase user.
3. Legacy sign-in flag: dropping policies is independent of it (see 1d). Before the LATER step that drops `auth.users`
   FKs/profiles, `LEGACY_SUPABASE_AUTH=off` must be set in production and preflight Q6 must return 0 un-migrated accounts
   (or the business accepts that those customers use "forgot password").
4. Recommended alongside: disable new sign-ups in Supabase Auth (dashboard → Authentication → Providers/Sign-ups) — this is a
   dashboard setting, not SQL.
5. Migration ledger: production has 4400–4900 applied via SQL Editor and not in `app_private.applied_migrations`
   (memory note). Record them first, or apply this file the same way and record it with a new EVIDENCE entry.

## 3. Ordered steps
1. Run the read-only preflight (section 4) on production in a `READ ONLY` transaction; save the output.
2. Rehearse locally (section 6) — twice in one transaction to prove re-runnability.
3. `npm run db:snapshot -- before.json` (production).
4. Apply the migration (one transaction). If the trigger drop is refused (not owner of auth.users), the draft falls back to
   a no-op `handle_new_user()`; record that in the release note.
5. `db:snapshot -- after.json` + `--compare`; run preflight again — Q1/Q2 must be empty, Q3 unchanged row counts.
6. Smoke: storefront catalogue (anon), image URLs, ERP product edit + image upload, customer login/checkout.
7. Later, separate migration: drop `auth.users` FKs and legacy `user_id` columns/`profiles` once Q6 = 0 and the flag is off.

## 4. Read-only preflight (production; `begin transaction read only; … rollback;`)
```sql
-- Q1 policies that reference auth functions or is_admin(), or target authenticated
select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies
 where coalesce(qual,'') ~* 'auth\.(uid|jwt|role)\(|is_admin\(' or coalesce(with_check,'') ~* 'auth\.(uid|jwt|role)\(|is_admin\('
    or 'authenticated' = any(roles)
 order by 1,2,3;
-- Q2 functions/triggers
select p.oid::regprocedure, p.prosecdef, array_to_string(p.proacl, ',') acl from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname in ('is_admin','handle_new_user');
select tgname, tgrelid::regclass, tgenabled from pg_trigger where tgname = 'on_auth_user_created';
select tableowner from pg_tables where schemaname = 'auth' and tablename = 'users';   -- can we drop the trigger?
select current_user, pg_has_role(current_user, (select tableowner from pg_tables where schemaname='auth' and tablename='users'), 'member') as owns_auth_users;
-- Q3 grants to anon/authenticated on public tables (expect catalogue SELECT + the 0100 tables)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated') group by 1,2 order by 1,2;
-- Q4 dependants of is_admin() other than the listed policies (should be none)
select classid::regclass, objid, deptype from pg_depend where refobjid = 'public.is_admin()'::regprocedure;
-- Q5 who is a Supabase "admin" today, and Supabase accounts not mirrored
select count(*) filter (where role = 'admin') admins, count(*) total from public.profiles;
select count(*) unmirrored from auth.users u where not exists (select 1 from public.customers c where c.id = u.id or c.email = lower(btrim(u.email)));
-- Q6 accounts still waiting to move off Supabase (blocks the LATER FK/profiles step, not this one)
select count(*) filter (where password_hash is null) not_migrated,
       count(*) filter (where password_hash is null and email_verified_at is null) not_migrated_unverified,
       count(*) total_legacy
  from public.customers where legacy_auth_user_id is not null;
-- Q7 rows still owned only by a Supabase user id (informational)
select (select count(*) from public.orders where customer_id is null and user_id is not null) legacy_orders,
       (select count(*) from public.addresses where customer_id is null) legacy_addresses,
       (select count(*) from public.cart_items where cart_id is null) legacy_cart_lines,
       (select count(*) from public.wishlist_items where wishlist_id is null) legacy_wishlist_lines;
-- Q8 storage policies
select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects';
```

## 5. Rollback SQL (restores the 0200/0300 state exactly)
```sql
begin;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Supabase default privileges that existed before (ALL to anon, authenticated on the 0100 tables)
grant all on public.profiles, public.addresses, public.cart_items, public.wishlist_items, public.orders, public.order_items,
  public.order_status_history, public.inventory_movements, public.payment_events, public.categories, public.products,
  public.product_variants, public.product_images, public.collections, public.collection_products, public.product_relations
  to anon, authenticated;
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
-- NB: run Q3 output from the preflight to restore the exact original grant set if it differed from "ALL".

drop policy if exists "products: public read active" on public.products;
create policy "products: public read active" on public.products for select to anon, authenticated using (status = 'active' or (select public.is_admin()));
drop policy if exists "variants: public read" on public.product_variants;
create policy "variants: public read" on public.product_variants for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
drop policy if exists "images: public read" on public.product_images;
create policy "images: public read" on public.product_images for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
create policy "categories: admin write" on public.categories for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "products: admin write" on public.products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "variants: admin write" on public.product_variants for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "images: admin write" on public.product_images for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "collections: admin write" on public.collections for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "collection_products: admin write" on public.collection_products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "relations: admin write" on public.product_relations for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "profiles: read own or admin" on public.profiles for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: update own" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "addresses: owner" on public.addresses for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "addresses: admin read" on public.addresses for select to authenticated using ((select public.is_admin()));
create policy "cart: owner" on public.cart_items for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "wishlist: owner" on public.wishlist_items for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "orders: read own or admin" on public.orders for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "orders: admin update" on public.orders for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "order_items: read own or admin" on public.order_items for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "status_history: read own or admin" on public.order_status_history for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "status_history: admin insert" on public.order_status_history for insert to authenticated with check ((select public.is_admin()));
create policy "inventory: admin read" on public.inventory_movements for select to authenticated using ((select public.is_admin()));
create policy "product-images: admin insert" on storage.objects for insert to authenticated with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product-images: admin update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin())) with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product-images: admin delete" on storage.objects for delete to authenticated using (bucket_id = 'product-images' and (select public.is_admin()));
commit;
```
Rollback is only needed if an unknown `authenticated` caller appears; the platform itself never used these paths after M6.

## 6. Test steps on a LOCAL database (never the demo DB, never kitsyuu_test while tests run)
`test-db.mjs --create` drops/recreates `kitsyuu_test` and the test suites drop the local demo DB, so build a separate
throwaway database by hand:
1. `createdb kitsyuu_legacy_rehearsal` on localhost; run `database/test/supabase-shim.sql`, then every file in
   `database/migrations/` in order, then `database/seed/catalogue.sql` (same order as `test-db.mjs:create`).
2. Save Q1–Q8 output (before). Expect Q1 to list the 25 legacy policies (22 in public, 3 of them the rewritten catalogue reads; 3 on storage.objects) + the keep-list public-read policies.
3. `begin; \i legacy-auth-policies.draft.sql; \i legacy-auth-policies.draft.sql; rollback;` — proves it runs twice cleanly.
4. Apply it for real in the rehearsal DB. Q1 must show only the keep-list "public read" policies; Q2 empty
   (shim: postgres owns auth.users, so the trigger is dropped — the no-op fallback path is exercised only on Supabase;
   to test it, `alter table auth.users owner to <another role>` in the rehearsal DB first).
5. As anon (`set local role anon`): `select count(*) from products` = active products only; inactive product hidden;
   `insert into products …` fails; `select * from orders` fails (permission denied).
6. As authenticated: same results as anon for catalogue; no access to profiles/addresses/orders/cart/wishlist.
7. As kitsyuu_admin / kitsyuu_website: spot-check unchanged access (select products incl. inactive as admin; customers as website).
8. Run the rollback SQL, re-run Q1–Q3 and diff against step 2 (must match), then re-apply the draft.
9. Only then: point a local website/admin at the rehearsal DB (`CATALOGUE_SOURCE=database`) for a manual smoke; drop the DB after.
