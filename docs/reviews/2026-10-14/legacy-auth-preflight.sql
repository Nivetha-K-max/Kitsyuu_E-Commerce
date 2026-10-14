-- READ-ONLY validation checks for retiring the legacy Supabase Auth policies (review artefact, 2026-10-14).
-- Copied from legacy-auth-plan.md section 4. Run before AND after the migration; on production only inside a read-only
-- transaction, and only with the owner's approval. Never run as part of db-apply.
begin transaction read only;
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
rollback;
