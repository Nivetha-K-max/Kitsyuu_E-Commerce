-- KITSYUU leads pipeline and content studio (2026-10-12). Additive only; safe to re-run. New tables and permissions only.
-- LOCAL ONLY so far: prepared and tested on throwaway local test databases. It must be reviewed and go through the
-- live-migration procedure (database/README.md) before any production use.
--
-- Two staff tools the client already works with elsewhere, rebuilt on this platform (no Meta / ads connection: leads are
-- entered by staff):
-- * leads / lead_events    a sales pipeline. A lead is a person and what they asked about, in one stage at a time; every
--                          stage change is a row in lead_events. One lead per phone number (phone_key = its last ten
--                          digits). A lead is not a customer and gets no login; customer_id may point at a customer later.
-- * content_ideas          research notes for content (a title, a description, a link), sorted into exploring /
--                          shortlisted / parked.
-- * content_pieces         content being made, in one stage at a time: idea → script → shoot → edit → scheduled → posted.
--                          Moving to the next stage is requested (requested_stage) and approved by someone who may
--                          approve; target_on is the day it is planned for (the calendar).
-- Staff data only: the store's role has no access to any of it.

create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(btrim(name)) between 1 and 120),
  phone             text not null check (length(phone) between 7 and 24),
  phone_key         text not null check (phone_key ~ '^[0-9]{7,15}$'),
  email             text check (email is null or (email = lower(btrim(email)) and email like '%_@_%' and length(email) <= 254)),
  interest          text check (interest is null or length(interest) <= 120),
  timeline          text check (timeline is null or length(timeline) <= 80),
  source            text not null default 'manual' check (source ~ '^[a-z][a-z0-9_]{1,23}$'),
  stage             text not null default 'new' check (stage in ('new', 'engaged', 'qualified', 'visited', 'converted', 'disqualified')),
  notes             text check (notes is null or length(notes) <= 2000),
  disqualify_reason text check (disqualify_reason is null or length(disqualify_reason) <= 300),
  assigned_to       uuid references public.staff_users (id) on delete set null,
  customer_id       uuid references public.customers (id) on delete set null,
  created_by        uuid references public.staff_users (id) on delete set null,
  stage_changed_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint leads_disqualified_has_reason check (stage <> 'disqualified' or disqualify_reason is not null)
);
create unique index if not exists leads_phone_key_idx on public.leads (phone_key);
create index if not exists leads_stage_idx on public.leads (stage, created_at desc);
drop trigger if exists leads_updated_at on public.leads;
create trigger leads_updated_at before update on public.leads for each row execute function public.set_updated_at();

create table if not exists public.lead_events (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.leads (id) on delete cascade,
  from_stage text,
  to_stage   text not null,
  note       text check (note is null or length(note) <= 500),
  staff_id   uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, id);
create index if not exists lead_events_stage_idx on public.lead_events (to_stage, created_at);

create table if not exists public.content_pieces (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(btrim(title)) between 1 and 160),
  platform        text check (platform is null or platform in ('instagram', 'facebook', 'youtube', 'whatsapp', 'other')),
  format          text check (format is null or format in ('reel', 'post', 'story', 'video', 'other')),
  stage           text not null default 'idea' check (stage in ('idea', 'script', 'shoot', 'edit', 'scheduled', 'posted')),
  target_on       date,
  owner_id        uuid references public.staff_users (id) on delete set null,
  hook            text check (hook is null or length(hook) <= 300),
  script          text check (script is null or length(script) <= 6000),
  footage_link    text check (footage_link is null or (footage_link ~ '^https://' and length(footage_link) <= 500)),
  final_link      text check (final_link is null or (final_link ~ '^https://' and length(final_link) <= 500)),
  posted_link     text check (posted_link is null or (posted_link ~ '^https://' and length(posted_link) <= 500)),
  notes           text check (notes is null or length(notes) <= 2000),
  requested_stage text check (requested_stage is null or requested_stage in ('script', 'shoot', 'edit', 'scheduled', 'posted')),
  requested_by    uuid references public.staff_users (id) on delete set null,
  requested_at    timestamptz,
  sent_back_note  text check (sent_back_note is null or length(sent_back_note) <= 300),
  posted_at       timestamptz,
  created_by      uuid references public.staff_users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint content_pieces_request_complete check ((requested_stage is null) = (requested_at is null)),
  constraint content_pieces_posted_consistent check ((stage = 'posted') = (posted_at is not null))
);
create index if not exists content_pieces_stage_idx on public.content_pieces (stage, created_at desc);
create index if not exists content_pieces_target_idx on public.content_pieces (target_on);
drop trigger if exists content_pieces_updated_at on public.content_pieces;
create trigger content_pieces_updated_at before update on public.content_pieces for each row execute function public.set_updated_at();

create table if not exists public.content_ideas (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(btrim(title)) between 1 and 160),
  description text check (description is null or length(description) <= 2000),
  link       text check (link is null or (link ~ '^https://' and length(link) <= 500)),
  status     text not null default 'exploring' check (status in ('exploring', 'shortlisted', 'parked')),
  piece_id   uuid unique references public.content_pieces (id) on delete set null,
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_ideas_status_idx on public.content_ideas (status, created_at desc);
drop trigger if exists content_ideas_updated_at on public.content_ideas;
create trigger content_ideas_updated_at before update on public.content_ideas for each row execute function public.set_updated_at();

alter table public.leads          enable row level security;
alter table public.lead_events    enable row level security;
alter table public.content_ideas  enable row level security;
alter table public.content_pieces enable row level security;
revoke all on public.leads, public.lead_events, public.content_ideas, public.content_pieces from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.leads, public.content_pieces to kitsyuu_admin;
grant select, insert, update, delete on public.content_ideas to kitsyuu_admin;
grant delete on public.content_pieces to kitsyuu_admin;                 -- only an idea nobody has moved yet can be removed (checked in the service)
grant select, insert on public.lead_events to kitsyuu_admin;            -- history is added to, never edited
grant usage on sequence public.lead_events_id_seq to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['leads', 'lead_events', 'content_ideas', 'content_pieces'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('leads.read', 'leads', 'View the leads pipeline and its conversion figures, and export leads'),
  ('leads.manage', 'leads', 'Add and edit leads and move them between stages'),
  ('studio.read', 'studio', 'View content ideas, the content pipeline and the content calendar'),
  ('studio.manage', 'studio', 'Add and edit content ideas and pieces, plan dates, and ask for a piece to move to its next stage'),
  ('studio.approve', 'studio', 'Approve or send back a content piece''s move to its next stage')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'leads.read'), ('super_admin', 'leads.manage'), ('super_admin', 'studio.read'), ('super_admin', 'studio.manage'), ('super_admin', 'studio.approve'),
  ('admin', 'leads.read'), ('admin', 'leads.manage'), ('admin', 'studio.read'), ('admin', 'studio.manage'), ('admin', 'studio.approve'),
  ('manager', 'leads.read'), ('manager', 'leads.manage'), ('manager', 'studio.read'), ('manager', 'studio.manage'),
  ('sales', 'leads.read'), ('sales', 'leads.manage')
) x(role, code) on r.code = x.role
on conflict do nothing;
