-- KITSYUU platform M2: customer accounts, sessions and auth support tables (additive only).
-- Supabase Auth (auth.users + public.profiles) stays the live login system until M6. Nothing here reads or changes it
-- except the one-way copy of existing accounts into public.customers at the bottom, which keeps each account's UUID.
-- Safe to re-run: every statement is guarded.

-- ---------- types ----------
do $$ begin
  create type public.customer_status as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.auth_token_purpose as enum ('email_verification', 'password_reset', 'staff_invitation');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.auth_realm as enum ('customer', 'staff');
exception when duplicate_object then null; end $$;

-- ---------- customers ----------
create table if not exists public.customers (
  id                  uuid primary key default gen_random_uuid(),   -- existing accounts keep their Supabase Auth user id
  email               text not null check (email = lower(btrim(email)) and email like '%_@_%'),   -- stored normalised
  full_name           text,
  phone               text,
  password_hash       text,                  -- argon2id, or a legacy bcrypt hash carried over in M6; null until then
  status              public.customer_status not null default 'active',
  email_verified_at   timestamptz,
  last_login_at       timestamptz,
  legacy_auth_user_id uuid unique,           -- the Supabase Auth user this row mirrors until M6 (no FK: auth.users is being retired)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists customers_email_key on public.customers (email);
drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at before update on public.customers for each row execute function public.set_updated_at();

-- ---------- customer sessions (same design as staff_sessions: only the token's SHA-256 is stored) ----------
create table if not exists public.customer_sessions (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers (id) on delete cascade,
  token_hash      bytea not null unique check (octet_length(token_hash) = 32),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  ip              inet,
  user_agent      text
);
create index if not exists customer_sessions_customer_idx on public.customer_sessions (customer_id);
create index if not exists customer_sessions_expires_idx on public.customer_sessions (expires_at);

-- ---------- one-time tokens: email verification, password reset, staff invitation ----------
-- Only the SHA-256 of the token is stored; the token itself exists only in the emailed link.
create table if not exists public.auth_tokens (
  id            uuid primary key default gen_random_uuid(),
  purpose       public.auth_token_purpose not null,
  customer_id   uuid references public.customers (id) on delete cascade,
  staff_user_id uuid references public.staff_users (id) on delete cascade,
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  expires_at    timestamptz not null,
  used_at       timestamptz,                                        -- set once; a used token is never accepted again
  created_at    timestamptz not null default now(),
  created_ip    inet,
  metadata      jsonb not null default '{}'::jsonb,
  constraint auth_tokens_one_subject check (num_nonnulls(customer_id, staff_user_id) = 1),
  constraint auth_tokens_invitation_is_staff check (purpose <> 'staff_invitation' or staff_user_id is not null),
  constraint auth_tokens_expiry_after_creation check (expires_at > created_at)
);
create index if not exists auth_tokens_customer_idx on public.auth_tokens (customer_id) where customer_id is not null;
create index if not exists auth_tokens_staff_idx on public.auth_tokens (staff_user_id) where staff_user_id is not null;
create index if not exists auth_tokens_expires_idx on public.auth_tokens (expires_at);

-- ---------- login attempts (throttling) ----------
-- Recorded for every attempt, including unknown emails, so throttling cannot reveal which emails have accounts.
create table if not exists public.auth_attempts (
  id             bigint generated always as identity primary key,
  realm          public.auth_realm not null,
  email          text not null,                                    -- normalised (lower-case, trimmed)
  ip             inet,
  succeeded      boolean not null,
  failure_reason text,
  attempted_at   timestamptz not null default now()
);
create index if not exists auth_attempts_email_idx on public.auth_attempts (realm, email, attempted_at desc);
create index if not exists auth_attempts_ip_idx on public.auth_attempts (realm, ip, attempted_at desc);

-- ---------- lock down ----------
alter table public.customers         enable row level security;
alter table public.customer_sessions enable row level security;
alter table public.auth_tokens       enable row level security;
alter table public.auth_attempts     enable row level security;
revoke all on public.customers, public.customer_sessions, public.auth_tokens, public.auth_attempts from anon, authenticated;
revoke all on sequence public.auth_attempts_id_seq from anon, authenticated;

-- ---------- copy existing accounts (one-way, keeps the UUID) ----------
-- Every Supabase Auth account that has a profile gets a customers row with the SAME id, so orders, carts and
-- addresses can move to customers in M6 without re-keying. No password is copied here (that is M6), and
-- auth.users / profiles are only read. Accounts created after this migration are copied by M6 with this same
-- statement (on conflict do nothing).
insert into public.customers (id, email, full_name, phone, email_verified_at, legacy_auth_user_id, created_at)
select p.id, lower(btrim(u.email)), p.full_name, p.phone, u.email_confirmed_at, p.id, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
where u.email is not null
on conflict do nothing;
