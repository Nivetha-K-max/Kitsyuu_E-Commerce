-- KITSYUU platform M8: the Admin/ERP database role may no longer read customer authentication secrets.
-- Migration 1100 granted kitsyuu_admin SELECT on every table, which includes customers.password_hash,
-- customer_sessions.token_hash and the customer rows of auth_tokens (email-verification and password-reset links).
-- The admin needs none of them. PostgreSQL cannot revoke one column while a table-wide SELECT grant exists, so:
--   · customers, customer_sessions: the table-wide SELECT is replaced by SELECT on every column except the secret one;
--     customer_sessions also gets UPDATE (revoked_at) so staff can end a disabled customer's sessions;
--   · auth_tokens: the admin still needs token_hash for STAFF invitations and password resets (they are looked up by
--     their hash), so this table is restricted by row instead: the admin's policy now covers staff tokens only, and
--     customer tokens are invisible to it.
-- Nothing is deleted; no data changes. The website role (kitsyuu_website) is not affected.
-- Note for later migrations: "grant select on all tables in schema public to kitsyuu_admin" would restore the
-- table-wide SELECT on these tables; do not use it again.
-- Safe to re-run: every statement is idempotent.

-- ---------- customers: everything except password_hash ----------
revoke select on public.customers from kitsyuu_admin;
grant select (id, email, full_name, phone, status, email_verified_at, last_login_at, password_changed_at, legacy_auth_user_id,
  created_at, updated_at) on public.customers to kitsyuu_admin;

-- ---------- customer_sessions: everything except token_hash; staff may end sessions ----------
revoke select on public.customer_sessions from kitsyuu_admin;
grant select (id, customer_id, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at, ip, user_agent)
  on public.customer_sessions to kitsyuu_admin;
grant update (revoked_at) on public.customer_sessions to kitsyuu_admin;

-- ---------- auth_tokens: the admin sees and writes staff tokens only ----------
drop policy if exists "app admin: all rows" on public.auth_tokens;
drop policy if exists "app admin: staff tokens" on public.auth_tokens;
create policy "app admin: staff tokens" on public.auth_tokens for all to kitsyuu_admin
  using (staff_user_id is not null) with check (staff_user_id is not null and customer_id is null);
