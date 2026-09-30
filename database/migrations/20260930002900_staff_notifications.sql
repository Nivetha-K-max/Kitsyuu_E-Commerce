-- KITSYUU ERP module 8: staff notifications (the notification centre). Additive only; safe to re-run.
-- A notification is shown to every staff member who holds its permission (e.g. an order alert needs orders.read), and
-- each person's read state is kept separately. Which alert kinds are raised is a setting per kind (alerts.<kind>),
-- written from the admin; a kind with no setting row is ON (internal alerts, not a customer-facing rule).
-- dedupe_key stops the same event being raised twice (e.g. one low-stock alert per size per day).

create table if not exists public.staff_notifications (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),        -- e.g. 'order.placed'
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title       text not null check (length(btrim(title)) between 1 and 160),
  body        text check (body is null or length(body) <= 500),
  entity_type text check (entity_type is null or entity_type ~ '^[a-z][a-z_]*$'),
  entity_id   text check (entity_id is null or length(entity_id) <= 80),
  link        text check (link is null or (link ~ '^/[^/]' and length(link) <= 300)),   -- an admin path only
  permission  text not null references public.permissions (code),
  dedupe_key  text unique check (dedupe_key is null or length(dedupe_key) <= 200),
  created_at  timestamptz not null default now()
);
create index if not exists staff_notifications_created_idx on public.staff_notifications (created_at desc);
create index if not exists staff_notifications_permission_idx on public.staff_notifications (permission, created_at desc);

create table if not exists public.staff_notification_reads (
  notification_id bigint not null references public.staff_notifications (id) on delete cascade,
  staff_user_id   uuid not null references public.staff_users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, staff_user_id)
);
create index if not exists staff_notification_reads_staff_idx on public.staff_notification_reads (staff_user_id);

alter table public.staff_notifications      enable row level security;
alter table public.staff_notification_reads enable row level security;
revoke all on public.staff_notifications, public.staff_notification_reads from anon, authenticated, kitsyuu_website;
grant select, insert on public.staff_notifications to kitsyuu_admin;
grant select, insert, delete on public.staff_notification_reads to kitsyuu_admin;
grant usage on sequence public.staff_notifications_id_seq to kitsyuu_admin;
-- The store raises alerts for events that happen there (a new order, a payment, a return request, a support ticket).
-- It does so only through raise_staff_notification() below (insert-only, skips a repeated dedupe key); it cannot read,
-- change or delete notifications.
revoke insert on public.staff_notifications from kitsyuu_website;

create or replace function public.raise_staff_notification(p_kind text, p_severity text, p_title text, p_body text, p_entity_type text,
  p_entity_id text, p_link text, p_permission text, p_dedupe_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.staff_notifications (kind, severity, title, body, entity_type, entity_id, link, permission, dedupe_key)
  values (p_kind, p_severity, p_title, p_body, p_entity_type, p_entity_id, p_link, p_permission, p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function public.raise_staff_notification(text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.raise_staff_notification(text, text, text, text, text, text, text, text, text) to kitsyuu_website, kitsyuu_admin;

drop policy if exists "app admin: all rows" on public.staff_notifications;
create policy "app admin: all rows" on public.staff_notifications for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.staff_notification_reads;
create policy "app admin: all rows" on public.staff_notification_reads for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app website: raise" on public.staff_notifications;
-- The store only reads the alert switches (alerts.*) to know whether to raise one.
drop policy if exists "app website: alert settings" on public.settings;
create policy "app website: alert settings" on public.settings for select to kitsyuu_website using (key like 'alerts.%');
