-- KITSYUU platform M12: customer reviews and ratings. Additive only.
-- Business decisions (2026-09-28): only customers who bought the item may review it; every review (and its photos) is
-- checked by staff before anyone else sees it; customers may add photos.
-- Not decided, so left as a setting that starts OFF: whether "bought" means paid or delivered (reviews.eligibility,
-- written from the admin; while it is unset no review can be written).
-- One review per purchased order line (a customer who buys the same item twice may review each purchase).
-- Photos are stored re-encoded (WebP, metadata such as GPS removed) in the database, so an unapproved photo is never
-- reachable from any public URL; they are served only by the apps, after the approval check.
-- Safe to re-run.

do $$ begin create type public.review_status as enum ('pending', 'approved', 'rejected'); exception when duplicate_object then null; end $$;

create table if not exists public.reviews (
  id              uuid primary key default gen_random_uuid(),
  product_id      text not null references public.products (id) on delete cascade,
  customer_id     uuid not null references public.customers (id) on delete cascade,
  order_item_id   uuid not null unique references public.order_items (id) on delete restrict,
  rating          smallint not null check (rating between 1 and 5),
  title           text check (title is null or length(btrim(title)) between 1 and 80),
  body            text not null check (length(btrim(body)) between 1 and 2000),
  display_name    text not null check (length(btrim(display_name)) between 1 and 40),
  status          public.review_status not null default 'pending',
  moderation_note text check (moderation_note is null or length(moderation_note) <= 300),
  moderated_by    uuid references public.staff_users (id) on delete set null,
  moderated_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint reviews_moderated_consistent check ((status = 'pending') = (moderated_at is null))
);
create index if not exists reviews_product_status_idx on public.reviews (product_id, status);
create index if not exists reviews_status_created_idx on public.reviews (status, created_at);
create index if not exists reviews_customer_idx on public.reviews (customer_id);
drop trigger if exists reviews_updated_at on public.reviews;
create trigger reviews_updated_at before update on public.reviews for each row execute function public.set_updated_at();
comment on table public.reviews is 'Verified-purchase reviews (one per order line). Public only when approved by staff.';

create table if not exists public.review_photos (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.reviews (id) on delete cascade,
  position     smallint not null check (position between 0 and 9),
  content_type text not null default 'image/webp' check (content_type = 'image/webp'),
  width        integer not null check (width > 0),
  height       integer not null check (height > 0),
  bytes        bytea not null check (octet_length(bytes) between 1 and 2097152),
  created_at   timestamptz not null default now(),
  unique (review_id, position)
);

alter table public.reviews       enable row level security;
alter table public.review_photos enable row level security;
revoke all on public.reviews, public.review_photos from anon, authenticated;

-- Website: customers write their own reviews and read approved ones (row ownership is checked by the website server
-- code, as for carts and orders). No update or delete: a submitted review is changed only by moderation.
grant select, insert on public.reviews, public.review_photos to kitsyuu_website;
drop policy if exists "app website: rows" on public.reviews;
create policy "app website: rows" on public.reviews for all to kitsyuu_website using (true) with check (status = 'pending' and moderated_at is null);
drop policy if exists "app website: rows" on public.review_photos;
create policy "app website: rows" on public.review_photos for all to kitsyuu_website using (true) with check (true);

-- Admin: read everything, moderate (status and note only). Reviews are never deleted from the admin.
grant select on public.reviews, public.review_photos to kitsyuu_admin;
grant update (status, moderation_note, moderated_by, moderated_at) on public.reviews to kitsyuu_admin;
drop policy if exists "app admin: all rows" on public.reviews;
create policy "app admin: all rows" on public.reviews for all to kitsyuu_admin using (true) with check (true);
drop policy if exists "app admin: all rows" on public.review_photos;
create policy "app admin: all rows" on public.review_photos for all to kitsyuu_admin using (true) with check (true);

-- Permissions (granted to super_admin and admin with every new code; moderation also to managers and support).
insert into public.permissions (code, module, description) values
  ('reviews.read', 'reviews', 'View customer reviews, including those waiting for approval'),
  ('reviews.moderate', 'reviews', 'Approve or reject customer reviews')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('reviews.read'), ('reviews.moderate')) p(code)
where r.code in ('super_admin', 'admin', 'manager', 'support')
on conflict do nothing;

-- The website reads the review switch (reviews.eligibility) like the other commerce settings.
drop policy if exists "app website: review settings" on public.settings;
create policy "app website: review settings" on public.settings for select to kitsyuu_website using (key like 'reviews.%');

-- Rating totals for the store (average and count of APPROVED reviews per product). Only these aggregates are public:
-- the store reads them with the public key like the catalogue, so product pages never depend on the website database.
-- The view runs with its owner's rights (it reads reviews, which the public key cannot) and exposes no text or customer data.
create or replace view public.v_product_ratings with (security_invoker = false) as
  select product_id, round(avg(rating)::numeric, 1)::float8 as average, count(*)::int as count
  from public.reviews where status = 'approved' group by product_id;
revoke all on public.v_product_ratings from public;
grant select on public.v_product_ratings to anon, authenticated, kitsyuu_website, kitsyuu_admin;
