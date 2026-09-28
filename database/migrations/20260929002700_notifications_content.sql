-- KITSYUU platform M17: customer notifications, store announcement, customer notes. Additive only; the one policy change
-- lets the store read PUBLISHED site content with the public key (drafts stay private).
-- Which emails are sent is a business decision, so every new email is a setting that starts OFF
-- (notifications.order_shipped, notifications.order_cancelled; written from the admin, not seeded here).
-- Safe to re-run.

create table if not exists public.notification_log (
  id         bigint generated always as identity primary key,
  event      text not null check (event ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),     -- e.g. 'order.shipped'
  order_id   uuid references public.orders (id) on delete set null,
  recipient  text not null,
  subject    text not null,
  status     text not null check (status in ('sent', 'failed')),
  error      text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists notification_log_created_idx on public.notification_log (created_at desc);
create index if not exists notification_log_order_idx on public.notification_log (order_id);

create table if not exists public.customer_notes (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 1000),
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists customer_notes_customer_idx on public.customer_notes (customer_id, created_at desc);

alter table public.notification_log enable row level security;
alter table public.customer_notes   enable row level security;
revoke all on public.notification_log, public.customer_notes from anon, authenticated, kitsyuu_website;
grant select, insert on public.notification_log, public.customer_notes to kitsyuu_admin;
grant usage on sequence public.notification_log_id_seq to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.notification_log;
create policy "app admin: all rows" on public.notification_log for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.customer_notes;
create policy "app admin: all rows" on public.customer_notes for all to kitsyuu_admin using (true) with check (true);

-- Store: published content (e.g. the announcement bar) is public; drafts never are.
grant select on public.site_content to anon, authenticated;
drop policy if exists "site_content: public read published" on public.site_content;
create policy "site_content: public read published" on public.site_content for select to anon, authenticated using (status = 'published');

insert into public.permissions (code, module, description) values
  ('content.manage', 'content', 'Edit and publish store content such as the announcement bar'),
  ('customers.note', 'customers', 'Add internal notes to a customer')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'content.manage'), ('super_admin', 'customers.note'),
  ('admin', 'content.manage'), ('admin', 'customers.note'),
  ('manager', 'content.manage'), ('manager', 'customers.note'),
  ('support', 'customers.note'), ('sales', 'customers.note')
) x(role, code) on r.code = x.role
on conflict do nothing;
