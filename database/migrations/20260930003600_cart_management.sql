-- KITSYUU ERP module 7: cart and wishlist management (read-only views for staff) and abandoned-cart recovery.
-- Additive only; safe to re-run. Staff can see carts and wishlists but never change a customer's cart.
-- A cart counts as abandoned only after the threshold the business sets (carts.abandon_after_hours); with no value set,
-- no cart is treated as abandoned.
-- * cart_recovery: the recovery status of an abandoned cart (open, emailed, recovered, dismissed) and the campaign it is
--   linked to. A recovery email is only sent when the business turns that email on (notifications.abandoned_cart).

create table if not exists public.cart_recovery (
  cart_id     uuid primary key references public.carts (id) on delete cascade,
  status      text not null default 'open' check (status in ('open', 'emailed', 'recovered', 'dismissed')),
  campaign_id uuid references public.campaigns (id) on delete set null,
  emailed_at  timestamptz,
  email_count integer not null default 0 check (email_count >= 0),
  note        text check (note is null or length(note) <= 300),
  updated_by  uuid references public.staff_users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table public.cart_recovery enable row level security;
revoke all on public.cart_recovery from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.cart_recovery to kitsyuu_admin;
grant select on public.carts, public.cart_items, public.wishlists, public.wishlist_items to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.cart_recovery;
create policy "app admin: all rows" on public.cart_recovery for all to kitsyuu_admin using (true) with check (true);

insert into public.permissions (code, module, description) values
  ('carts.read', 'carts', 'View customer carts, wishlists and abandoned-cart recovery'),
  ('carts.manage', 'carts', 'Change abandoned-cart recovery status and send recovery emails')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'carts.read'), ('super_admin', 'carts.manage'), ('admin', 'carts.read'), ('admin', 'carts.manage'),
  ('manager', 'carts.read'), ('manager', 'carts.manage'), ('sales', 'carts.read'), ('sales', 'carts.manage'), ('support', 'carts.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
