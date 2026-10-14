-- UNDO script for legacy-auth-policies.draft.sql (review artefact, 2026-10-14). NOT A MIGRATION: do not put it in
-- database/migrations. Copied from legacy-auth-plan.md section 5. Restores the 20260925000200/0300 state; run only if the
-- retirement was applied and an unknown 'authenticated' caller turns up, with the owner's approval.
begin;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Supabase default privileges that existed before (ALL to anon, authenticated on the 0100 tables)
grant all on public.profiles, public.addresses, public.cart_items, public.wishlist_items, public.orders, public.order_items,
  public.order_status_history, public.inventory_movements, public.payment_events, public.categories, public.products,
  public.product_variants, public.product_images, public.collections, public.collection_products, public.product_relations
  to anon, authenticated;
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
-- NB: run Q3 output from the preflight to restore the exact original grant set if it differed from "ALL".

drop policy if exists "products: public read active" on public.products;
create policy "products: public read active" on public.products for select to anon, authenticated using (status = 'active' or (select public.is_admin()));
drop policy if exists "variants: public read" on public.product_variants;
create policy "variants: public read" on public.product_variants for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
drop policy if exists "images: public read" on public.product_images;
create policy "images: public read" on public.product_images for select to anon, authenticated
  using ((select public.is_admin()) or exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
create policy "categories: admin write" on public.categories for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "products: admin write" on public.products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "variants: admin write" on public.product_variants for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "images: admin write" on public.product_images for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "collections: admin write" on public.collections for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "collection_products: admin write" on public.collection_products for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "relations: admin write" on public.product_relations for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "profiles: read own or admin" on public.profiles for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: update own" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "addresses: owner" on public.addresses for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "addresses: admin read" on public.addresses for select to authenticated using ((select public.is_admin()));
create policy "cart: owner" on public.cart_items for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "wishlist: owner" on public.wishlist_items for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "orders: read own or admin" on public.orders for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "orders: admin update" on public.orders for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "order_items: read own or admin" on public.order_items for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "status_history: read own or admin" on public.order_status_history for select to authenticated
  using ((select public.is_admin()) or exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "status_history: admin insert" on public.order_status_history for insert to authenticated with check ((select public.is_admin()));
create policy "inventory: admin read" on public.inventory_movements for select to authenticated using ((select public.is_admin()));
create policy "product-images: admin insert" on storage.objects for insert to authenticated with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product-images: admin update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin())) with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product-images: admin delete" on storage.objects for delete to authenticated using (bucket_id = 'product-images' and (select public.is_admin()));
commit;
