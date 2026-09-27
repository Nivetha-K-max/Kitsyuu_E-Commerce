-- KITSYUU platform M7: core commerce — database cart and wishlist, checkout foundation, provider-neutral payments and
-- order stock (additive only).
-- Orders, cart lines and wishlist lines can now belong to platform customers (M6) instead of Supabase Auth users. Existing
-- rows keep their user_id; nothing is deleted or rewritten.
-- No business values are invented here: payment hold time, shipping charges, discounts and tax rules stay unset / as
-- already configured (tax_rates), and are read from settings when someone decides them.
-- Stock is still changed ONLY through public.adjust_stock(): the website gets two narrow functions that take or return
-- exactly the stock of ONE order, never an arbitrary amount.
-- Safe to re-run: every statement is guarded.

-- ---------- 1. orders belong to customers; amounts ready for discounts, shipping and tax ----------
alter table public.orders alter column user_id drop not null;
do $$ begin
  alter table public.orders add constraint orders_has_owner check (customer_id is not null or user_id is not null);
exception when duplicate_object then null; end $$;
alter table public.orders add column if not exists cart_id uuid references public.carts (id) on delete set null;
alter table public.orders add column if not exists idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$');
alter table public.orders add column if not exists discount_paise integer not null default 0 check (discount_paise >= 0);
alter table public.orders add column if not exists shipping_paise integer not null default 0 check (shipping_paise >= 0);
alter table public.orders add column if not exists tax_paise integer not null default 0 check (tax_paise >= 0);
alter table public.orders add column if not exists prices_include_tax boolean not null default true;
-- Snapshot of how the amounts were worked out (tax rate, shipping method, discount rules) when the order was placed.
alter table public.orders add column if not exists pricing jsonb not null default '{}'::jsonb;
-- Only set when a payment hold time is configured (checkout.payment_window_minutes); null = no automatic expiry.
alter table public.orders add column if not exists payment_expires_at timestamptz;
comment on column public.orders.idempotency_key is 'Random key of the checkout form: submitting the same form twice returns the same order.';
comment on column public.orders.tax_paise is 'Tax amount. With prices_include_tax it is the part of the total that is tax; otherwise it is added.';
comment on column public.orders.razorpay_order_id is 'Legacy (Phase 4.2). Payments of any provider are recorded in public.payments.';
create unique index if not exists orders_customer_idempotency_key on public.orders (customer_id, idempotency_key)
  where idempotency_key is not null and customer_id is not null;
create index if not exists orders_cart_open_idx on public.orders (cart_id) where cart_id is not null and status in ('pending_payment', 'payment_failed');
create index if not exists orders_payment_expiry_idx on public.orders (payment_expires_at)
  where payment_expires_at is not null and status in ('pending_payment', 'payment_failed');

-- ---------- 2. cart and wishlist lines belong to carts / wishlists (M2 tables) ----------
alter table public.cart_items alter column user_id drop not null;
do $$ begin
  alter table public.cart_items add constraint cart_items_has_owner check (cart_id is not null or user_id is not null);
exception when duplicate_object then null; end $$;

-- wishlist_items was keyed by (user_id, product_id); platform wishlists have no Supabase user, so it gets its own id and
-- the old key becomes a unique index for the legacy rows (same guarantee).
do $$ begin
  if exists (select 1 from pg_constraint c where c.conname = 'wishlist_items_pkey' and c.conrelid = 'public.wishlist_items'::regclass
             and pg_get_constraintdef(c.oid) like '%(user_id, product_id)%') then
    alter table public.wishlist_items drop constraint wishlist_items_pkey;
  end if;
end $$;
alter table public.wishlist_items add column if not exists id uuid not null default gen_random_uuid();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wishlist_items_pkey' and conrelid = 'public.wishlist_items'::regclass) then
    alter table public.wishlist_items add constraint wishlist_items_pkey primary key (id);
  end if;
end $$;
create unique index if not exists wishlist_items_user_product_key on public.wishlist_items (user_id, product_id) where user_id is not null;
alter table public.wishlist_items alter column user_id drop not null;
do $$ begin
  alter table public.wishlist_items add constraint wishlist_items_has_owner check (wishlist_id is not null or user_id is not null);
exception when duplicate_object then null; end $$;

-- ---------- 3. payments: one row per payment attempt, for any provider ----------
-- A checkout creates a 'created' row holding the provider's reference (provider_order_id); the provider's result updates it.
create index if not exists payments_provider_order_idx on public.payments (provider, provider_order_id);
-- Provider notifications (webhooks): each event id is stored once, then processed.
alter table public.payment_events add column if not exists provider text not null default 'razorpay';
alter table public.payment_events add column if not exists order_id uuid references public.orders (id) on delete set null;
alter table public.payment_events add column if not exists outcome text;
alter table public.payment_events alter column provider drop default;
create index if not exists payment_events_order_idx on public.payment_events (order_id) where order_id is not null;

-- ---------- 4. order stock for the website (narrow wrappers around adjust_stock) ----------
-- Takes the stock of a new, unpaid order: one 'sale' ledger row per size, all or nothing (adjust_stock refuses to go
-- below zero and the whole transaction rolls back). Sizes are locked in a fixed order so concurrent checkouts cannot
-- deadlock. Running it again for the same order does nothing.
create or replace function public.reserve_order_stock(p_order_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.order_status;
  v_number text;
  v_units  integer := 0;
  r        record;
begin
  select o.status, o.order_number into v_status, v_number from public.orders o where o.id = p_order_id for update;
  if not found then raise exception 'reserve_order_stock: order % not found', p_order_id using errcode = 'P0002'; end if;
  if v_status <> 'pending_payment' then
    raise exception 'reserve_order_stock: order % is %', v_number, v_status using errcode = '22023';
  end if;
  if exists (select 1 from public.inventory_movements m where m.order_id = p_order_id) then return 0; end if;
  for r in select i.variant_id, sum(i.qty)::int as qty from public.order_items i where i.order_id = p_order_id
           group by i.variant_id order by i.variant_id loop
    if r.variant_id is null then raise exception 'reserve_order_stock: order % has a line without a size', v_number using errcode = '22023'; end if;
    perform public.adjust_stock(r.variant_id, -r.qty, 'sale', null, 'Order ' || v_number, p_order_id);
    v_units := v_units + r.qty;
  end loop;
  return v_units;
end $$;

-- Returns what a CANCELLED order still holds (its sales minus earlier returns) as 'cancel' ledger rows.
-- Running it again returns nothing more.
create or replace function public.release_order_stock(p_order_id uuid, p_note text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.order_status;
  v_number text;
  v_units  integer := 0;
  r        record;
begin
  select o.status, o.order_number into v_status, v_number from public.orders o where o.id = p_order_id for update;
  if not found then raise exception 'release_order_stock: order % not found', p_order_id using errcode = 'P0002'; end if;
  if v_status <> 'cancelled' then
    raise exception 'release_order_stock: order % is %, not cancelled', v_number, v_status using errcode = '22023';
  end if;
  for r in select m.variant_id, sum(m.delta)::int as net from public.inventory_movements m
           where m.order_id = p_order_id and m.reason in ('sale', 'cancel') group by m.variant_id order by m.variant_id loop
    if r.net < 0 then
      perform public.adjust_stock(r.variant_id, -r.net, 'cancel', null, coalesce(p_note, 'Order ' || v_number || ' cancelled'), p_order_id);
      v_units := v_units - r.net;
    end if;
  end loop;
  return v_units;
end $$;

revoke all on function public.reserve_order_stock(uuid) from public, anon, authenticated;
revoke all on function public.release_order_stock(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_order_stock(uuid) to kitsyuu_website, kitsyuu_admin;
grant execute on function public.release_order_stock(uuid, text) to kitsyuu_website, kitsyuu_admin;

-- ---------- 5. website role ----------
grant select, insert, update on public.payment_events to kitsyuu_website;
drop policy if exists "app website: rows" on public.payment_events;
create policy "app website: rows" on public.payment_events for all to kitsyuu_website using (true) with check (true);
-- Ledger rows of orders (to know what an order holds). Other stock movements stay hidden from the website.
grant select on public.inventory_movements to kitsyuu_website;
drop policy if exists "app website: order stock" on public.inventory_movements;
create policy "app website: order stock" on public.inventory_movements for select to kitsyuu_website using (order_id is not null);
-- Commerce configuration the website reads (checkout, shipping, payments); other private settings stay hidden.
drop policy if exists "app website: checkout settings" on public.settings;
drop policy if exists "app website: commerce settings" on public.settings;
create policy "app website: commerce settings" on public.settings for select to kitsyuu_website
  using (key like 'checkout.%' or key like 'shipping.%' or key like 'payments.%');
-- Catalogue visibility is unchanged: the website still sees only active products. A cart or wishlist line whose product
-- was archived no longer resolves and is shown as unavailable / dropped.
