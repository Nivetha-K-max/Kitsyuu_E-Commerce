-- KITSYUU store: customer/admin roles and Row Level Security (Phase 4.2)
-- Deny by default: RLS is enabled on every table and only the policies below grant access.
-- The server (service-role key, never sent to the browser) bypasses RLS for order creation, payment
-- verification and stock changes.

-- ---------- roles ----------
-- True when the signed-in user has the admin role. SECURITY DEFINER so it can read profiles under RLS.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Every new auth user gets a customer profile. Admins are promoted separately (see scripts/promote-admin.mjs).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Customers may edit their own name and phone, never their role or email.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;

-- ---------- enable RLS everywhere ----------
alter table public.categories           enable row level security;
alter table public.products             enable row level security;
alter table public.product_variants     enable row level security;
alter table public.product_images       enable row level security;
alter table public.collections          enable row level security;
alter table public.collection_products  enable row level security;
alter table public.product_relations    enable row level security;
alter table public.profiles             enable row level security;
alter table public.addresses            enable row level security;
alter table public.cart_items           enable row level security;
alter table public.wishlist_items       enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;
alter table public.inventory_movements  enable row level security;
alter table public.payment_events       enable row level security;

-- ---------- catalogue: public read (active only), admin write ----------
create policy "categories: public read" on public.categories for select to anon, authenticated using (true);
create policy "categories: admin write" on public.categories for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "products: public read active" on public.products for select to anon, authenticated
  using (status = 'active' or (select public.is_admin()));
create policy "products: admin write" on public.products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "variants: public read" on public.product_variants for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
create policy "variants: admin write" on public.product_variants for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "images: public read" on public.product_images for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
create policy "images: admin write" on public.product_images for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "collections: public read" on public.collections for select to anon, authenticated using (true);
create policy "collections: admin write" on public.collections for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "collection_products: public read" on public.collection_products for select to anon, authenticated using (true);
create policy "collection_products: admin write" on public.collection_products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "relations: public read" on public.product_relations for select to anon, authenticated using (true);
create policy "relations: admin write" on public.product_relations for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------- profiles ----------
create policy "profiles: read own or admin" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- (no insert/delete policies: profiles are created by the auth trigger and removed with the auth user)

-- ---------- addresses, cart, wishlist: owner only ----------
create policy "addresses: owner" on public.addresses for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "addresses: admin read" on public.addresses for select to authenticated using ((select public.is_admin()));

create policy "cart: owner" on public.cart_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "wishlist: owner" on public.wishlist_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- orders: owner/admin read; writes only from the server (service role) ----------
create policy "orders: read own or admin" on public.orders for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "orders: admin update" on public.orders for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "order_items: read own or admin" on public.order_items for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));

create policy "status_history: read own or admin" on public.order_status_history for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "status_history: admin insert" on public.order_status_history for insert to authenticated
  with check ((select public.is_admin()));

create policy "inventory: admin read" on public.inventory_movements for select to authenticated using ((select public.is_admin()));
-- payment_events: no policies at all (server only).
