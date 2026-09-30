-- KITSYUU ERP module 5: customer support tickets. Additive only; safe to re-run.
-- * support_categories: ticket categories (editable data; the starting list is the one the business asked for).
-- * support_tickets: one conversation per issue, optionally about an order, with priority, status and assignee.
-- * support_messages: the thread. Internal notes (is_internal) are never shown to the customer.
-- Customers open and follow tickets from their account; staff can also open one for a customer.

create table if not exists public.support_categories (
  code       text primary key check (code ~ '^[a-z][a-z_]{1,31}$'),
  label      text not null check (length(btrim(label)) between 1 and 60),
  sort_order integer not null default 0,
  is_active  boolean not null default true
);
insert into public.support_categories (code, label, sort_order) values
  ('order', 'Order issue', 1), ('payment', 'Payment issue', 2), ('shipping', 'Shipping issue', 3), ('return_refund', 'Return / refund', 4),
  ('product', 'Product issue', 5), ('account', 'Account issue', 6), ('general', 'General enquiry', 7)
on conflict (code) do nothing;

create table if not exists public.support_tickets (
  id                     uuid primary key default gen_random_uuid(),
  number                 text not null unique default ('TCK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  customer_id            uuid references public.customers (id) on delete set null,
  contact_email          text not null check (contact_email = lower(btrim(contact_email)) and contact_email like '%_@_%'),
  contact_name           text check (contact_name is null or length(contact_name) <= 120),
  order_id               uuid references public.orders (id) on delete set null,
  subject                text not null check (length(btrim(subject)) between 1 and 160),
  category_code          text not null references public.support_categories (code),
  priority               text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status                 text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
  assigned_to            uuid references public.staff_users (id) on delete set null,
  channel                text not null default 'store' check (channel in ('store', 'staff')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  closed_at              timestamptz,
  last_customer_reply_at timestamptz,
  last_staff_reply_at    timestamptz
);
create index if not exists support_tickets_status_idx on public.support_tickets (status, updated_at desc);
create index if not exists support_tickets_customer_idx on public.support_tickets (customer_id, created_at desc);
create index if not exists support_tickets_assignee_idx on public.support_tickets (assigned_to);
drop trigger if exists support_tickets_updated_at on public.support_tickets;
create trigger support_tickets_updated_at before update on public.support_tickets for each row execute function public.set_updated_at();

create table if not exists public.support_messages (
  id            bigint generated always as identity primary key,
  ticket_id     uuid not null references public.support_tickets (id) on delete cascade,
  author_type   text not null check (author_type in ('customer', 'staff', 'system')),
  staff_user_id uuid references public.staff_users (id) on delete set null,
  customer_id   uuid references public.customers (id) on delete set null,
  body          text not null check (length(btrim(body)) between 1 and 4000),
  is_internal   boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint support_messages_internal_staff check (not is_internal or author_type in ('staff', 'system'))
);
create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

alter table public.support_categories enable row level security;
alter table public.support_tickets    enable row level security;
alter table public.support_messages   enable row level security;
revoke all on public.support_categories, public.support_tickets, public.support_messages from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.support_categories, public.support_tickets to kitsyuu_admin;
grant select, insert on public.support_messages to kitsyuu_admin;
grant usage on sequence public.support_messages_id_seq to kitsyuu_admin;
grant select on public.support_categories to kitsyuu_website;
grant select, insert on public.support_tickets, public.support_messages to kitsyuu_website;
grant update (status, last_customer_reply_at) on public.support_tickets to kitsyuu_website;
grant usage on sequence public.support_messages_id_seq to kitsyuu_website;
do $$ declare t text; begin
  foreach t in array array['support_categories', 'support_tickets', 'support_messages'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists "app website: categories" on public.support_categories;
create policy "app website: categories" on public.support_categories for select to kitsyuu_website using (is_active);
drop policy if exists "app website: rows" on public.support_tickets;
create policy "app website: rows" on public.support_tickets for all to kitsyuu_website using (true) with check (true);
-- Internal notes never reach the store, even by mistake in a query.
drop policy if exists "app website: public messages" on public.support_messages;
create policy "app website: public messages" on public.support_messages for select to kitsyuu_website using (not is_internal);
drop policy if exists "app website: add messages" on public.support_messages;
create policy "app website: add messages" on public.support_messages for insert to kitsyuu_website with check (author_type = 'customer' and not is_internal);

insert into public.permissions (code, module, description) values
  ('support.read', 'support', 'View support tickets'),
  ('support.manage', 'support', 'Reply to, assign and resolve support tickets')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'support.read'), ('super_admin', 'support.manage'), ('admin', 'support.read'), ('admin', 'support.manage'),
  ('manager', 'support.read'), ('manager', 'support.manage'), ('support', 'support.read'), ('support', 'support.manage'),
  ('sales', 'support.read'), ('sales', 'support.manage')
) x(role, code) on r.code = x.role
on conflict do nothing;
