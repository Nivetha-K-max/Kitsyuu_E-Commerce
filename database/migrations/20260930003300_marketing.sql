-- KITSYUU ERP module 4: marketing and promotions. Additive only; safe to re-run.
-- * campaigns: a named promotion with dates, target products / collections and the discounts it uses (discounts.campaign_id).
-- * banners: promotional banners for the store (home or shop page). None exist; the store shows a banner only while one
--   is active and inside its dates, so the store looks exactly as before until staff publish one.
-- * customer_segments: saved customer filters (new, returning, high-value, lapsed, with an abandoned cart…). The
--   thresholds are entered by staff; nothing is pre-set.

create table if not exists public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique check (length(btrim(name)) between 1 and 120),
  description    text check (description is null or length(description) <= 1000),
  starts_at      timestamptz,
  ends_at        timestamptz,
  is_active      boolean not null default false,
  product_ids    text[] not null default '{}',
  collection_ids text[] not null default '{}',
  created_by     uuid references public.staff_users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint campaigns_dates check (ends_at is null or starts_at is null or ends_at > starts_at)
);
drop trigger if exists campaigns_updated_at on public.campaigns;
create trigger campaigns_updated_at before update on public.campaigns for each row execute function public.set_updated_at();
alter table public.discounts add column if not exists campaign_id uuid references public.campaigns (id) on delete set null;
create index if not exists discounts_campaign_idx on public.discounts (campaign_id);

create table if not exists public.banners (
  id          uuid primary key default gen_random_uuid(),
  placement   text not null check (placement in ('home', 'shop')),
  heading     text not null check (length(btrim(heading)) between 1 and 80),
  body        text check (body is null or length(body) <= 240),
  cta_label   text check (cta_label is null or length(btrim(cta_label)) between 1 and 30),
  link        text check (link is null or (link ~ '^/[^/]' and length(link) <= 200)),     -- a path inside the store only
  image_path  text check (image_path is null or image_path ~ '^[a-z0-9/_.-]{1,200}$'),
  starts_at   timestamptz,
  ends_at     timestamptz,
  is_active   boolean not null default false,
  sort_order  integer not null default 0,
  campaign_id uuid references public.campaigns (id) on delete set null,
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint banners_dates check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint banners_cta check ((cta_label is null) = (link is null))
);
drop trigger if exists banners_updated_at on public.banners;
create trigger banners_updated_at before update on public.banners for each row execute function public.set_updated_at();

create table if not exists public.customer_segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  rules       jsonb not null default '{}'::jsonb,
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists customer_segments_updated_at on public.customer_segments;
create trigger customer_segments_updated_at before update on public.customer_segments for each row execute function public.set_updated_at();

alter table public.campaigns         enable row level security;
alter table public.banners           enable row level security;
alter table public.customer_segments enable row level security;
revoke all on public.campaigns, public.banners, public.customer_segments from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.campaigns, public.banners to kitsyuu_admin;
grant select, insert, update, delete on public.customer_segments to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['campaigns', 'banners', 'customer_segments'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;
-- Store: only live banners are public (active and inside their dates), read with the public key like the catalogue.
grant select on public.banners to anon, authenticated;
drop policy if exists "banners: public read live" on public.banners;
create policy "banners: public read live" on public.banners for select to anon, authenticated
  using (is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

insert into public.permissions (code, module, description) values
  ('marketing.read', 'marketing', 'View campaigns, banners, customer segments and promotion reports'),
  ('marketing.manage', 'marketing', 'Create and publish campaigns, banners and customer segments')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'marketing.read'), ('super_admin', 'marketing.manage'), ('admin', 'marketing.read'), ('admin', 'marketing.manage'),
  ('manager', 'marketing.read'), ('manager', 'marketing.manage'), ('sales', 'marketing.read'), ('accountant', 'marketing.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
