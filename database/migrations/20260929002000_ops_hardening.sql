-- KITSYUU platform M9: operations hardening. Additive only; no existing row is changed.
-- 1. Permission system.read (the admin System page: database health, configuration modes, recent sign-in counts).
--    Granted to super_admin and admin, as every new code is (see 20260925000400_staff_access.sql).
-- 2. Setting security.checkout_orders_per_hour: how many orders one customer may create per hour (a security limit
--    against checkout abuse, not a business rule). Kept if it already exists.
-- 3. Index for the sign-in history in the audit view (newest first).
-- Safe to re-run.

insert into public.permissions (code, module, description) values
  ('system.read', 'system', 'View system health and configuration status')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, 'system.read' from public.roles r where r.code in ('super_admin', 'admin')
on conflict do nothing;

insert into public.settings (key, value, description, is_public) values
  ('security.checkout_orders_per_hour', '10', 'Maximum orders one customer may create per hour (checkout abuse limit)', false)
on conflict (key) do nothing;

create index if not exists auth_attempts_attempted_at_idx on public.auth_attempts (attempted_at desc);

-- The website role reads this one security setting (checkout rate limit); every other private setting stays hidden.
drop policy if exists "app website: security settings" on public.settings;
create policy "app website: security settings" on public.settings for select to kitsyuu_website
  using (key = 'security.checkout_orders_per_hour');
