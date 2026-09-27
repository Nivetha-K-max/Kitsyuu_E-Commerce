-- KITSYUU platform M6: customer accounts on the platform's own authentication (additive only).
-- Supabase Auth (auth.users + public.profiles) is NOT changed or disabled: existing accounts keep working and are moved to
-- platform login one by one (their password is checked once against Supabase Auth, then stored as an Argon2id hash).
-- Nothing is deleted. Safe to re-run: every statement is guarded.

-- ---------- 1. mirror accounts created in Supabase Auth since M2 (same statement as M2; keeps each UUID) ----------
insert into public.customers (id, email, full_name, phone, email_verified_at, legacy_auth_user_id, created_at)
select p.id, lower(btrim(u.email)), p.full_name, p.phone, u.email_confirmed_at, p.id, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
where u.email is not null
on conflict do nothing;

-- ---------- 2. customers: when the password last changed (shown on the Security page) ----------
alter table public.customers add column if not exists password_changed_at timestamptz;

-- ---------- 3. addresses belong to customers ----------
-- New platform customers have no Supabase Auth user, so addresses get a customer_id. Existing rows are linked through the
-- M2 mirror (customers.id = the Supabase user id). user_id stays for existing rows but is no longer required.
alter table public.addresses add column if not exists customer_id uuid references public.customers (id) on delete cascade;
update public.addresses a set customer_id = c.id
from public.customers c
where a.customer_id is null and c.legacy_auth_user_id = a.user_id;
alter table public.addresses alter column user_id drop not null;
do $$ begin
  alter table public.addresses add constraint addresses_has_owner check (customer_id is not null or user_id is not null);
exception when duplicate_object then null; end $$;
create index if not exists addresses_customer_idx on public.addresses (customer_id) where customer_id is not null;
-- At most one default address per customer.
create unique index if not exists addresses_one_default_per_customer on public.addresses (customer_id) where is_default and customer_id is not null;

-- ---------- 4. customer session lifetime and login throttling ----------
-- auth.customer_session_days (M2, 30) is the idle lifetime, renewed while in use; this is the absolute limit.
insert into public.settings (key, value, description, is_public) values
  ('auth.customer_session_absolute_days', '90', 'Customer session ends this long after login, even if active', false),
  ('auth.customer_login_max_failures_per_ip', '50', 'Failed customer logins allowed per IP within the window (customers share IPs; the per-email limit is auth.login_max_failures)', false)
on conflict (key) do nothing;

-- ---------- 5. website role: audit trail and auth settings ----------
-- Customer sign-ins, password changes and similar events are audited by the website, append-only like the admin.
grant insert on public.audit_logs to kitsyuu_website;
grant usage on sequence public.audit_logs_id_seq to kitsyuu_website;
drop policy if exists "app website: append" on public.audit_logs;
create policy "app website: append" on public.audit_logs for insert to kitsyuu_website with check (actor_type in ('customer', 'system'));
-- The website reads the auth.* settings (session lifetimes, login throttling); other private settings stay hidden.
drop policy if exists "app website: auth settings" on public.settings;
create policy "app website: auth settings" on public.settings for select to kitsyuu_website using (key like 'auth.%');
