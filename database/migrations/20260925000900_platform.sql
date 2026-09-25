-- KITSYUU platform M2: settings, editable site content and the append-only audit log (additive only).
-- Only settings the architecture needs are seeded. site_content starts empty (the landing content arrives in M5).
-- audit_logs starts empty: no events are invented.
-- Safe to re-run: every statement is guarded.

-- ---------- settings (typed JSON values, editable later from the admin app) ----------
create table if not exists public.settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  value       jsonb not null,
  description text not null default '',
  is_public   boolean not null default false,          -- true = the storefront may read it; false = internal
  updated_by  uuid references public.staff_users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
drop trigger if exists settings_updated_at on public.settings;
create trigger settings_updated_at before update on public.settings for each row execute function public.set_updated_at();

insert into public.settings (key, value, description, is_public) values
  ('store.currency',                     '"INR"',          'Store currency (ISO 4217)', true),
  ('store.timezone',                     '"Asia/Kolkata"', 'Business time zone for dates, reports and financial years', true),
  ('billing.prices_include_tax',         'true',           'Listed prices already include tax (no separate GST line)', true),
  ('billing.default_tax_rate_code',      '"PROTOTYPE_INCLUSIVE"', 'tax_rates.code applied when a product has no specific rate', false),
  ('billing.invoice_prefix',             '"KTS"',          'Invoice number prefix: numbers look like KTS/26-27/00001', false),
  ('inventory.low_stock_threshold',      '3',              'A variant is low on stock at or below this quantity, unless it has its own reorder level', false),
  ('auth.staff_session_idle_minutes',    '30',             'Staff session ends after this much inactivity', false),
  ('auth.staff_session_absolute_hours',  '12',             'Staff session ends this long after login, even if active', false),
  ('auth.customer_session_days',         '30',             'Customer session lifetime, renewed while in use', false),
  ('auth.login_max_failures',            '5',              'Failed logins allowed per email (and per IP) within the window before throttling', false),
  ('auth.login_window_minutes',          '15',             'Window for counting failed logins', false),
  ('auth.token_ttl_minutes',             '{"email_verification": 1440, "password_reset": 60, "staff_invitation": 4320}', 'Lifetime of one-time links, by purpose', false)
on conflict (key) do nothing;

-- ---------- site content (landing and page copy; one row per key, locale and draft/published state) ----------
create table if not exists public.site_content (
  id           uuid primary key default gen_random_uuid(),
  key          text not null check (key ~ '^[a-z][a-z0-9_.-]*$'),    -- e.g. 'landing.hero'
  locale       text not null default 'en-IN',
  status       text not null default 'draft' check (status in ('draft', 'published')),
  content      jsonb not null default '{}'::jsonb,
  updated_by   uuid references public.staff_users (id) on delete set null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint site_content_key_locale_status_key unique (key, locale, status)
);
drop trigger if exists site_content_updated_at on public.site_content;
create trigger site_content_updated_at before update on public.site_content for each row execute function public.set_updated_at();

-- ---------- audit log (append-only) ----------
do $$ begin
  create type public.audit_actor_type as enum ('staff', 'customer', 'system');
exception when duplicate_object then null; end $$;

create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_type  public.audit_actor_type not null,
  staff_id    uuid references public.staff_users (id) on delete restrict,   -- staff are disabled, never deleted, so the actor stays known
  customer_id uuid references public.customers (id) on delete restrict,
  action      text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),   -- e.g. 'product.update', 'inventory.adjust'
  entity_type text not null,                                                 -- e.g. 'products'
  entity_id   text,                                                          -- text, so text ids (ky-proto-001) and uuids both fit
  before_data jsonb,
  after_data  jsonb,
  request_id  text,
  ip          inet,
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb,
  constraint audit_logs_actor check (
    (actor_type = 'staff' and staff_id is not null) or (actor_type = 'customer' and customer_id is not null) or actor_type = 'system')
);
create index if not exists audit_logs_occurred_idx on public.audit_logs (occurred_at desc);
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index if not exists audit_logs_staff_idx on public.audit_logs (staff_id, occurred_at desc) where staff_id is not null;
create index if not exists audit_logs_action_idx on public.audit_logs (action, occurred_at desc);

-- Two layers keep it append-only: no role is granted UPDATE/DELETE/TRUNCATE (see the app-roles migration), and these
-- triggers reject those operations for everyone, including the table owner and service_role.
create or replace function public.audit_logs_block_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only: % is not allowed', tg_op using errcode = '42501';
end $$;
drop trigger if exists audit_logs_no_update_delete on public.audit_logs;
create trigger audit_logs_no_update_delete before update or delete on public.audit_logs
  for each row execute function public.audit_logs_block_change();
drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_block_change();

-- ---------- lock down ----------
alter table public.settings     enable row level security;
alter table public.site_content enable row level security;
alter table public.audit_logs   enable row level security;
revoke all on public.settings, public.site_content, public.audit_logs from anon, authenticated;
revoke update, delete, truncate on public.audit_logs from service_role;
revoke all on sequence public.audit_logs_id_seq from anon, authenticated;
revoke all on function public.audit_logs_block_change() from public, anon, authenticated;
