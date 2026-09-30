-- KITSYUU ERP module 3: returns and refunds. Additive only; safe to re-run.
-- The business decision so far is "all sales are final", so returns are OFF: the switch returns.enabled has no row, the
-- store offers no return button and every existing policy text stays as it is. Everything below only takes effect once
-- the business turns returns on and sets a return window (returns.window_days) in the admin.
-- * return_reasons: the reasons customers pick from (editable data, not a rule).
-- * return_requests / return_items / return_events: a request, the order lines and quantities it covers, and its history.
-- * refunds (existing table) gains the link to a return, how it was paid out (through the payment provider, or recorded
--   as done by hand with a reference) and a failure reason. A refund is only ever marked processed after the provider
--   confirms it, or when staff record that they paid it themselves.

create table if not exists public.return_reasons (
  code       text primary key check (code ~ '^[a-z][a-z_]{1,31}$'),
  label      text not null check (length(btrim(label)) between 1 and 80),
  sort_order integer not null default 0,
  is_active  boolean not null default true
);
insert into public.return_reasons (code, label, sort_order) values
  ('size_fit', 'Size or fit', 1), ('damaged', 'Arrived damaged', 2), ('wrong_item', 'Wrong item received', 3),
  ('not_as_described', 'Not as described', 4), ('quality', 'Quality issue', 5), ('changed_mind', 'Changed my mind', 6), ('other', 'Other', 7)
on conflict (code) do nothing;

-- Stock that leaves for an exchange goes through the ledger with its own reason (a returned item coming back uses the
-- existing 'return' reason).
insert into public.inventory_reasons (code, label, direction, is_system, sort_order)
values ('exchange', 'Exchange sent to customer', 'out', true, 9)
on conflict (code) do nothing;

create table if not exists public.return_requests (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique default ('RET-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  order_id            uuid not null references public.orders (id) on delete restrict,
  customer_id         uuid references public.customers (id) on delete set null,
  status              text not null default 'requested' check (status in ('requested', 'under_review', 'info_requested', 'approved', 'rejected',
                        'pickup_scheduled', 'picked_up', 'received', 'inspection', 'refund_pending', 'refunded', 'exchange_pending', 'exchanged',
                        'completed', 'cancelled')),
  resolution          text check (resolution is null or resolution in ('refund', 'exchange')),
  reason_code         text not null references public.return_reasons (code),
  description         text check (description is null or length(description) <= 2000),
  staff_note          text check (staff_note is null or length(staff_note) <= 1000),
  pickup_at           timestamptz,
  pickup_ref          text check (pickup_ref is null or length(pickup_ref) <= 80),
  received_at         timestamptz,
  inspection_result   text check (inspection_result is null or inspection_result in ('ok', 'damaged', 'not_returnable')),
  inspection_note     text check (inspection_note is null or length(inspection_note) <= 1000),
  refund_amount_paise integer check (refund_amount_paise is null or refund_amount_paise > 0),
  requested_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz
);
create index if not exists return_requests_status_idx on public.return_requests (status, requested_at desc);
create index if not exists return_requests_order_idx on public.return_requests (order_id);
drop trigger if exists return_requests_updated_at on public.return_requests;
create trigger return_requests_updated_at before update on public.return_requests for each row execute function public.set_updated_at();

create table if not exists public.return_items (
  id                  uuid primary key default gen_random_uuid(),
  return_id           uuid not null references public.return_requests (id) on delete cascade,
  order_item_id       uuid not null references public.order_items (id) on delete restrict,
  qty                 integer not null check (qty > 0),
  restock             boolean not null default false,
  restocked_qty       integer not null default 0 check (restocked_qty >= 0),
  exchange_variant_id uuid references public.product_variants (id) on delete restrict,
  unique (return_id, order_item_id),
  constraint return_items_restock_le_qty check (restocked_qty <= qty)
);

create table if not exists public.return_events (
  id            bigint generated always as identity primary key,
  return_id     uuid not null references public.return_requests (id) on delete cascade,
  from_status   text,
  to_status     text not null,
  note          text check (note is null or length(note) <= 1000),
  actor_type    text not null check (actor_type in ('customer', 'staff', 'system')),
  staff_user_id uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists return_events_return_idx on public.return_events (return_id, created_at);

alter table public.refunds add column if not exists return_id      uuid references public.return_requests (id) on delete restrict;
alter table public.refunds add column if not exists method         text check (method is null or method in ('provider', 'manual'));
alter table public.refunds add column if not exists reference      text check (reference is null or length(reference) <= 120);
alter table public.refunds add column if not exists failure_reason text check (failure_reason is null or length(failure_reason) <= 300);
alter table public.refunds add column if not exists processed_by   uuid references public.staff_users (id) on delete set null;
create index if not exists refunds_return_idx on public.refunds (return_id);

alter table public.return_reasons  enable row level security;
alter table public.return_requests enable row level security;
alter table public.return_items    enable row level security;
alter table public.return_events   enable row level security;
revoke all on public.return_reasons, public.return_requests, public.return_items, public.return_events from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.return_reasons, public.return_requests, public.return_items to kitsyuu_admin;
grant select, insert on public.return_events to kitsyuu_admin;
grant usage on sequence public.return_events_id_seq to kitsyuu_admin;
grant select on public.refunds to kitsyuu_admin;
-- The store: customers file a request and follow it (the core scopes every read and write to the signed-in customer).
grant select on public.return_reasons to kitsyuu_website;
grant select, insert on public.return_requests, public.return_items, public.return_events to kitsyuu_website;
grant update (status) on public.return_requests to kitsyuu_website;
grant usage on sequence public.return_events_id_seq to kitsyuu_website;
do $$ declare t text; begin
  foreach t in array array['return_reasons', 'return_requests', 'return_items', 'return_events'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
    execute format('drop policy if exists "app website: rows" on public.%I', t);
    execute format('create policy "app website: rows" on public.%I for all to kitsyuu_website using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists "app website: return settings" on public.settings;
create policy "app website: return settings" on public.settings for select to kitsyuu_website using (key like 'returns.%');

insert into public.permissions (code, module, description) values
  ('returns.read', 'returns', 'View return requests and refunds'),
  ('returns.manage', 'returns', 'Handle return requests: review, pickup, receiving, inspection, restock and exchanges')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'returns.read'), ('super_admin', 'returns.manage'), ('super_admin', 'refunds.create'),
  ('admin', 'returns.read'), ('admin', 'returns.manage'), ('admin', 'refunds.create'),
  ('manager', 'returns.read'), ('manager', 'returns.manage'), ('sales', 'returns.read'), ('sales', 'returns.manage'),
  ('support', 'returns.read'), ('accountant', 'returns.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
