-- READ-ONLY production checks for migrations 20261014005000 (staff branch scope) and 20261014005100 (shipping address
-- permission). Review artefact, 2026-10-14. NOT RUN ANYWHERE YET. Run only with the owner's approval, as the owner role,
-- in the Supabase SQL Editor or psql. Everything is inside one READ ONLY transaction that is rolled back.
begin transaction read only;

-- P1 Migration ledger: what db-apply believes has run (the newest first).
select name, applied_at from app_private.applied_migrations order by name desc limit 15;

-- P2 Migrations 4400–4900 were run in the SQL Editor (not in the ledger). Are their objects there? Expect every value true.
select
  has_table_privilege('kitsyuu_admin', 'public.discount_redemptions', 'insert')                              as m4400_pos_coupon_grant,
  to_regclass('public.referrals') is not null and to_regclass('public.referral_codes') is not null           as m4500_referrals,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'materials' and column_name = 'kind') as m4600_packaging,
  to_regclass('public.production_milestones') is not null                                                    as m4700_milestones,
  to_regclass('public.leads') is not null and exists (select 1 from public.permissions where code = 'leads.read') as m4800_leads,
  to_regclass('public.store_credit_accounts') is not null and exists (select 1 from public.permissions where code = 'pos.credit_sell') as m4900_store_credit;

-- P3 Neither new migration has run yet. Expect: false, false.
select to_regclass('public.staff_locations') is not null as m5000_already_there,
       exists (select 1 from public.permissions where code = 'shipping.addresses') as m5100_already_there;

-- P4 Every role, seeded or made on the Roles page (is_system = false), with how many active staff hold it.
select r.code, r.name, r.is_system,
       (select count(*) from public.staff_user_roles sur join public.staff_users s on s.id = sur.staff_user_id
         where sur.role_id = r.id and s.status = 'active') as active_staff
  from public.roles r order by r.is_system desc, r.code;

-- P5 THE KEY CHECK for 005100: roles that can see the Shipping pages today (shipping.read) but are NOT among the roles the
-- migration grants shipping.addresses to. Each row = a role whose staff would stop seeing customer names and addresses on
-- shipments. Expect no rows; any row needs a decision (grant it in the migration, or accept the change).
select r.code, r.name, r.is_system
  from public.roles r join public.role_permissions rp on rp.role_id = r.id and rp.permission_code = 'shipping.read'
 where r.code not in ('super_admin', 'admin', 'manager', 'sales', 'support', 'inventory_manager');

-- P6 The current shipping / order / customer permissions of every role (the live role matrix).
select r.code,
       bool_or(rp.permission_code = 'shipping.read')   as shipping_read,
       bool_or(rp.permission_code = 'shipping.manage') as shipping_manage,
       bool_or(rp.permission_code = 'orders.read')     as orders_read,
       bool_or(rp.permission_code = 'customers.read')  as customers_read,
       bool_or(rp.permission_code = 'staff.manage')    as staff_manage
  from public.roles r left join public.role_permissions rp on rp.role_id = r.id
 group by r.code order by r.code;

-- P7 Branch scope context: the locations staff could be assigned to (005000 assigns nobody by itself).
select code, name, kind, is_online, is_active from public.locations order by is_online desc, code;

-- P8 Who will run the migration, and whether it may create tables and policies in public.
select current_user, has_schema_privilege(current_user, 'public', 'create') as can_create_in_public,
       pg_has_role(current_user, 'kitsyuu_admin', 'member') as member_of_admin_role;

rollback;

-- ---------------------------------------------------------------- AFTER the migrations (also read only)
-- V1 select to_regclass('public.staff_locations') is not null,
--           has_table_privilege('kitsyuu_admin', 'public.staff_locations', 'select,insert,delete'),
--           not has_table_privilege('kitsyuu_website', 'public.staff_locations', 'select');            -- expect true, true, true
-- V2 select count(*) from public.staff_locations;                                                      -- expect 0 (nobody limited)
-- V3 select r.code from public.role_permissions rp join public.roles r on r.id = rp.role_id
--     where rp.permission_code = 'shipping.addresses' order by 1;                                      -- the six roles above
-- V4 re-run P5 with 'shipping.addresses' in place of the role list: no role with shipping.read lacks it (unless decided).
