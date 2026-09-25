-- KITSYUU platform M2: application database roles (additive only).
--   kitsyuu_website: the customer website. Catalogue reads plus customer / cart / wishlist / order / auth data.
--                    No access to staff, roles, permissions or the audit log.
--   kitsyuu_admin:   the Admin/ERP app. Broad access, but it cannot change stock_qty directly (adjust_stock() only)
--                    and cannot UPDATE / DELETE / TRUNCATE audit history.
-- Both roles are created NOLOGIN: nothing can connect as them yet. M3 enables login for kitsyuu_admin with a password
-- supplied from the environment (never stored in a migration). Until then this migration has no runtime effect.
-- Existing policies for anon / authenticated (Supabase Auth) are not touched: the policies added below apply only to
-- these two roles. Row-level ownership checks for customer data are enforced in the website's server code, which
-- is the only holder of the kitsyuu_website credentials.
-- Safe to re-run: roles are created if missing; grants are idempotent; policies are dropped and recreated.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'kitsyuu_website') then create role kitsyuu_website nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kitsyuu_admin') then create role kitsyuu_admin nologin; end if;
end $$;
comment on role kitsyuu_website is 'KITSYUU customer website (server-side only)';
comment on role kitsyuu_admin is 'KITSYUU Admin/ERP app (server-side only)';

grant usage on schema public to kitsyuu_website, kitsyuu_admin;

-- ======================= kitsyuu_website =======================
grant select on public.categories, public.products, public.product_variants, public.product_images, public.collections,
  public.collection_products, public.product_relations, public.settings, public.site_content, public.tax_rates
  to kitsyuu_website;
grant select, insert, update on public.customers to kitsyuu_website;
grant select, insert, update, delete on public.customer_sessions, public.carts, public.cart_items, public.wishlists,
  public.wishlist_items, public.addresses to kitsyuu_website;
grant select, insert, update on public.auth_tokens to kitsyuu_website;
grant select, insert on public.auth_attempts to kitsyuu_website;
grant select, insert, update on public.orders, public.payments to kitsyuu_website;
grant select, insert on public.order_items, public.order_status_history to kitsyuu_website;
grant select on public.invoices, public.invoice_items to kitsyuu_website;

-- ======================= kitsyuu_admin =======================
grant select on all tables in schema public to kitsyuu_admin;              -- includes the reporting views
grant insert, update, delete on public.categories, public.products, public.product_images, public.collections,
  public.collection_products, public.product_relations to kitsyuu_admin;
-- Variants: every column except stock_qty (stock changes only through adjust_stock()).
grant insert, delete on public.product_variants to kitsyuu_admin;
grant update (product_id, size, sku, sort_order, price_paise, stock_source, is_active, reorder_level) on public.product_variants to kitsyuu_admin;
grant insert, update on public.staff_users, public.roles to kitsyuu_admin;
grant delete on public.roles to kitsyuu_admin;                               -- in-use roles are protected by FK restrict
grant insert, update, delete on public.role_permissions, public.staff_user_roles, public.staff_sessions to kitsyuu_admin;
grant insert, update on public.auth_tokens to kitsyuu_admin;
grant insert on public.auth_attempts to kitsyuu_admin;
grant update (full_name, phone, status, email_verified_at) on public.customers to kitsyuu_admin;
grant insert, update on public.settings, public.tax_rates, public.inventory_reasons to kitsyuu_admin;
grant insert, update, delete on public.site_content to kitsyuu_admin;
grant update on public.orders to kitsyuu_admin;
grant insert on public.order_status_history to kitsyuu_admin;
grant insert, update on public.payments, public.refunds, public.invoices to kitsyuu_admin;
grant insert, update, delete on public.invoice_items to kitsyuu_admin;
grant insert on public.audit_logs to kitsyuu_admin;                          -- append only: no update/delete/truncate
revoke update, delete, truncate on public.audit_logs from kitsyuu_admin, kitsyuu_website;
revoke truncate on all tables in schema public from kitsyuu_admin, kitsyuu_website;

grant execute on function public.adjust_stock(uuid, integer, text, uuid, text, uuid) to kitsyuu_admin;
grant execute on function public.next_document_number(text, text, date) to kitsyuu_admin;
grant execute on function public.financial_year_of(date) to kitsyuu_admin, kitsyuu_website;
grant usage on sequence public.auth_attempts_id_seq to kitsyuu_website, kitsyuu_admin;
grant usage on sequence public.audit_logs_id_seq to kitsyuu_admin;

-- ======================= RLS policies for the app roles =======================
-- Tables have RLS enabled, so each app role needs a policy per table it uses. Which operations it may perform is set by
-- the grants above; these policies only decide which rows are visible to it.
do $$
declare t text;
begin
  -- kitsyuu_admin: all rows of every table it has privileges on.
  foreach t in array array[
    'categories', 'products', 'product_variants', 'product_images', 'collections', 'collection_products', 'product_relations',
    'profiles', 'addresses', 'cart_items', 'wishlist_items', 'orders', 'order_items', 'order_status_history',
    'inventory_movements', 'payment_events',
    'staff_users', 'roles', 'permissions', 'role_permissions', 'staff_user_roles', 'staff_sessions',
    'customers', 'customer_sessions', 'auth_tokens', 'auth_attempts', 'inventory_reasons',
    'carts', 'wishlists', 'tax_rates', 'payments', 'refunds', 'invoices', 'invoice_items', 'document_sequences',
    'settings', 'site_content'
  ] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;

  -- kitsyuu_website: customer-side tables (row ownership is checked by the website server code).
  foreach t in array array[
    'customers', 'customer_sessions', 'auth_tokens', 'auth_attempts', 'carts', 'cart_items', 'wishlists', 'wishlist_items',
    'addresses', 'orders', 'order_items', 'order_status_history', 'payments', 'invoices', 'invoice_items', 'tax_rates',
    'categories', 'collections', 'collection_products', 'product_relations'
  ] loop
    execute format('drop policy if exists "app website: rows" on public.%I', t);
    execute format('create policy "app website: rows" on public.%I for all to kitsyuu_website using (true) with check (true)', t);
  end loop;
end $$;

-- Audit log: the admin app may read and append, nothing else (the triggers also block update/delete/truncate).
drop policy if exists "app admin: all rows" on public.audit_logs;
drop policy if exists "app admin: read" on public.audit_logs;
drop policy if exists "app admin: append" on public.audit_logs;
create policy "app admin: read" on public.audit_logs for select to kitsyuu_admin using (true);
create policy "app admin: append" on public.audit_logs for insert to kitsyuu_admin with check (true);

-- Website catalogue visibility mirrors the existing public policies: only active products and their variants/images.
drop policy if exists "app website: rows" on public.products;
create policy "app website: rows" on public.products for select to kitsyuu_website using (status = 'active');
drop policy if exists "app website: rows" on public.product_variants;
create policy "app website: rows" on public.product_variants for select to kitsyuu_website
  using (exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
drop policy if exists "app website: rows" on public.product_images;
create policy "app website: rows" on public.product_images for select to kitsyuu_website
  using (exists (select 1 from public.products p where p.id = product_id and p.status = 'active'));
-- Website sees only public settings and published content.
drop policy if exists "app website: rows" on public.settings;
create policy "app website: rows" on public.settings for select to kitsyuu_website using (is_public);
drop policy if exists "app website: rows" on public.site_content;
create policy "app website: rows" on public.site_content for select to kitsyuu_website using (status = 'published');
