-- KITSYUU platform M8: fulfilment data for orders (additive only).
-- The order status stays the ONE status (processing → shipped → delivered through the existing order workflow). A shipment
-- row holds the operational details of that delivery; it has no status column of its own:
--   · packing_state: operational metadata while the order is processing (not started / packing / packed);
--   · carrier_code: which carrier delivers it ('manual' until a real carrier is integrated; codes come from the carrier
--     registry in packages/core/src/fulfilment/carrier.ts, no carrier is hard-coded here);
--   · tracking_number: OPTIONAL (an order may be marked shipped without one);
--   · shipped_at / delivered_at: set when the order enters shipped / delivered.
-- One shipment per order (partial shipments are out of scope). Tables start empty; no existing row changes.
-- Safe to re-run: every statement is guarded.

do $$ begin
  create type public.packing_state as enum ('not_started', 'packing', 'packed');
exception when duplicate_object then null; end $$;

create table if not exists public.shipments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null unique references public.orders (id) on delete restrict,
  carrier_code    text not null default 'manual' check (carrier_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  tracking_number text check (tracking_number is null or (tracking_number = btrim(tracking_number) and length(tracking_number) between 1 and 64)),
  packing_state   public.packing_state not null default 'not_started',
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_by      uuid references public.staff_users (id) on delete restrict,
  updated_by      uuid references public.staff_users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint shipments_delivered_after_shipped check (delivered_at is null or (shipped_at is not null and delivered_at >= shipped_at))
);
create index if not exists shipments_shipped_idx on public.shipments (shipped_at desc) where shipped_at is not null;
create index if not exists shipments_packing_idx on public.shipments (packing_state) where shipped_at is null;
drop trigger if exists shipments_updated_at on public.shipments;
create trigger shipments_updated_at before update on public.shipments for each row execute function public.set_updated_at();
comment on table public.shipments is 'Fulfilment details of an order. The order status (processing/shipped/delivered) is the status; this table has none.';

-- ---------- lock down; the admin manages shipments ----------
alter table public.shipments enable row level security;
revoke all on public.shipments from public, anon, authenticated;
grant select, insert, update on public.shipments to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.shipments;
create policy "app admin: all rows" on public.shipments for all to kitsyuu_admin using (true) with check (true);
