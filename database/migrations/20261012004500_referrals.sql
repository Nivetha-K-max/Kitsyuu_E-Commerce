-- KITSYUU referrals (2026-10-12). Additive only; safe to re-run.
-- LOCAL ONLY so far: prepared and tested on throwaway local test databases. It must be reviewed and go through the
-- live-migration procedure (database/README.md) before any production use.
--
-- A customer shares their referral code. Someone who creates an account with it is attributed to them (once, at sign-up).
-- When that new customer's first eligible order has been delivered and the return period has passed, BOTH receive a
-- reward: a personal, single-use coupon in the existing discounts table, so rewards are checked, limited, combined and
-- shown on bills by the same coupon engine as every other coupon.
-- OFF until the business switches it on (referrals.enabled). The reward amount, the coupon's validity and its minimum
-- order are settings the business can change; the values below are the ones the business approved on 2026-10-12.
--
-- * referral_codes   one shareable code per customer (made when the customer first opens their referral page).
-- * referrals        who referred whom (one referral per referred customer, never oneself), its state and why it was
--                    rejected, and the order that qualified it.
-- * referral_rewards the coupon given to each of the two parties: at most one per party per referral (unique), so a
--                    repeated or simultaneous run can never give a second one.
-- * discounts.customer_id  a coupon that belongs to one customer (a reward): nobody else can use it.

create table if not exists public.referral_codes (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Z0-9]{6,12}$'),
  created_at  timestamptz not null default now()
);

create table if not exists public.referrals (
  id                  uuid primary key default gen_random_uuid(),
  referrer_id         uuid not null references public.customers (id) on delete cascade,
  referred_id         uuid not null unique references public.customers (id) on delete cascade,   -- a customer is referred once
  code                text not null,
  status              text not null default 'pending' check (status in ('pending', 'rewarded', 'rejected')),
  reject_reason       text check (reject_reason is null or length(reject_reason) <= 300),
  qualifying_order_id uuid references public.orders (id) on delete set null,
  rejected_by         uuid references public.staff_users (id) on delete set null,
  attributed_at       timestamptz not null default now(),
  rewarded_at         timestamptz,
  rejected_at         timestamptz,
  constraint referrals_not_self check (referrer_id <> referred_id),
  constraint referrals_state check ((status = 'rewarded') = (rewarded_at is not null) and (status = 'rejected') = (rejected_at is not null))
);
create index if not exists referrals_referrer_idx on public.referrals (referrer_id, attributed_at desc);
create index if not exists referrals_pending_idx on public.referrals (attributed_at) where status = 'pending';

alter table public.discounts add column if not exists customer_id uuid references public.customers (id) on delete cascade;
create index if not exists discounts_customer_idx on public.discounts (customer_id) where customer_id is not null;

create table if not exists public.referral_rewards (
  id          uuid primary key default gen_random_uuid(),
  referral_id uuid not null references public.referrals (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  role        text not null check (role in ('referrer', 'referred')),
  discount_id uuid not null unique references public.discounts (id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (referral_id, role)
);
create index if not exists referral_rewards_customer_idx on public.referral_rewards (customer_id, created_at desc);

alter table public.referral_codes   enable row level security;
alter table public.referrals        enable row level security;
alter table public.referral_rewards enable row level security;
revoke all on public.referral_codes, public.referrals, public.referral_rewards from anon, authenticated, kitsyuu_website, kitsyuu_admin;
-- The store: a customer gets their code and is attributed at sign-up; it reads its own referrals and rewards (the core
-- scopes every read to the signed-in customer). It can never reward anyone or change a referral.
grant select, insert on public.referral_codes, public.referrals to kitsyuu_website;
grant select on public.referral_rewards to kitsyuu_website;
-- The Admin/ERP: reads everything, rejects a referral, and issues the rewards (the scheduled job and staff).
grant select on public.referral_codes to kitsyuu_admin;
grant select, update (status, reject_reason, qualifying_order_id, rejected_by, rewarded_at, rejected_at) on public.referrals to kitsyuu_admin;
grant select, insert on public.referral_rewards to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['referral_codes', 'referrals', 'referral_rewards'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
    execute format('drop policy if exists "app website: rows" on public.%I', t);
    execute format('create policy "app website: rows" on public.%I for all to kitsyuu_website using (true) with check (true)', t);
  end loop;
end $$;
-- The store reads the referral settings (whether referrals are on; what the reward is, to show it).
drop policy if exists "app website: referral settings" on public.settings;
create policy "app website: referral settings" on public.settings for select to kitsyuu_website using (key like 'referrals.%');

-- The approved starting values (2026-10-12): ₹200 to each party, coupon valid 30 days, on orders from ₹1,000. Referrals
-- themselves stay OFF until the business switches them on in Configuration.
insert into public.settings (key, value, description, is_public) values
  ('referrals.reward_paise', '20000', 'Referral reward: the coupon amount each of the two customers receives', false),
  ('referrals.coupon_valid_days', '30', 'Referral reward: days the reward coupon can be used', false),
  ('referrals.min_order_paise', '100000', 'Referral reward: smallest order the reward coupon can be used on', false)
on conflict (key) do nothing;
