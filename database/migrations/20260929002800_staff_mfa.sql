-- KITSYUU platform M18: optional two-factor sign-in for staff (authenticator app codes). Additive only.
-- Opt-in per staff member; which roles must use it is a business decision, so nothing is enforced here.
-- The TOTP secret is stored AES-256-GCM encrypted (key in the admin app's MFA_ENCRYPTION_KEY, never in the database);
-- recovery codes are stored only as SHA-256 hashes and work once. A staff member holding staff.manage can reset another
-- person's two-factor (lost phone); that is audited.
-- Safe to re-run.

create table if not exists public.staff_mfa (
  staff_user_id  uuid primary key references public.staff_users (id) on delete cascade,
  secret_enc     bytea not null check (octet_length(secret_enc) between 29 and 256),
  enabled_at     timestamptz,                       -- null while the enrolment is not confirmed with a first code
  last_used_step bigint,                            -- the last accepted 30-second step: a code is never accepted twice
  created_at     timestamptz not null default now()
);
create table if not exists public.staff_mfa_recovery_codes (
  id            uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references public.staff_users (id) on delete cascade,
  code_hash     bytea not null unique check (octet_length(code_hash) = 32),
  used_at       timestamptz
);
create index if not exists staff_mfa_recovery_staff_idx on public.staff_mfa_recovery_codes (staff_user_id);

alter table public.staff_mfa                enable row level security;
alter table public.staff_mfa_recovery_codes enable row level security;
revoke all on public.staff_mfa, public.staff_mfa_recovery_codes from anon, authenticated, kitsyuu_website;
grant select, insert, update, delete on public.staff_mfa, public.staff_mfa_recovery_codes to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.staff_mfa;
create policy "app admin: all rows" on public.staff_mfa for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.staff_mfa_recovery_codes;
create policy "app admin: all rows" on public.staff_mfa_recovery_codes for all to kitsyuu_admin using (true) with check (true);
