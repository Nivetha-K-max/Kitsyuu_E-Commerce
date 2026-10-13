-- POS phase 2 (2026-10-13, LOCAL ONLY until reviewed and approved for production):
--   store credit (a money balance the shop owes a customer), credit bills (money a customer owes the shop), split payments,
--   and exchanges for a different product with the difference settled.
-- Additive: new tables, new nullable columns, one check constraint WIDENED (more values allowed, none removed), new
-- permissions. No existing row is changed. Safe to run twice.
-- Roll back (only while the new tables are empty): drop table credit_repayments, credit_bills, credit_accounts,
--   store_credit_entries, store_credit_accounts; alter table return_requests drop column settlement, settlement_paise,
--   exchange_order_id, idempotency_key; alter table orders drop column exchange_return_id; delete the permissions below; put
--   orders_payment_method_check back to ('online','cod','cash','card','upi'). Once a sale has been saved as 'split',
--   'credit' or 'store_credit', or any ledger row exists, it cannot be rolled back without losing financial history.

-- ---------------------------------------------------------------- how an order was paid: more ways
-- 'split' = more than one tender (each is its own payments row); 'store_credit' = wholly from the customer's store credit;
-- 'credit' = a credit bill (nothing collected yet). COD rules are untouched (they compare with 'cod' only).
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('online', 'cod', 'cash', 'card', 'upi', 'split', 'store_credit', 'credit'));

-- ---------------------------------------------------------------- store credit: one balance per customer + its ledger
-- The balance row is what a sale locks (two tills cannot spend the same rupee); the ledger is the history. They are
-- written together in one transaction and must always agree: balance = sum(entries). No expiry column: credit never expires.
create table if not exists public.store_credit_accounts (
  customer_id   uuid primary key references public.customers (id) on delete restrict,
  balance_paise integer not null default 0 check (balance_paise >= 0),
  updated_at    timestamptz not null default now()
);
create table if not exists public.store_credit_entries (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers (id) on delete restrict,
  amount_paise    integer not null check (amount_paise <> 0),        -- + credit given to the customer, - credit spent / taken back
  balance_after   integer not null check (balance_after >= 0),
  kind            text not null check (kind in ('return', 'adjustment', 'redeem', 'reversal')),
  order_id        uuid references public.orders (id) on delete restrict,           -- the sale it was spent on / the order it came from
  return_id       uuid references public.return_requests (id) on delete restrict,  -- the return that issued it
  reverses_id     uuid references public.store_credit_entries (id) on delete restrict,
  staff_id        uuid references public.staff_users (id) on delete restrict,
  reason          text not null check (length(reason) between 3 and 300),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  created_at      timestamptz not null default now(),
  constraint store_credit_entries_sign check ((kind in ('return') and amount_paise > 0) or (kind = 'redeem' and amount_paise < 0) or kind in ('adjustment', 'reversal'))
);
create index if not exists store_credit_entries_customer on public.store_credit_entries (customer_id, created_at desc);
create index if not exists store_credit_entries_order on public.store_credit_entries (order_id) where order_id is not null;
create unique index if not exists store_credit_entries_one_reversal on public.store_credit_entries (reverses_id) where reverses_id is not null;

-- ---------------------------------------------------------------- credit accounts and credit bills (money owed TO the shop)
-- No customer has credit until an account is approved for them. outstanding_paise is the locked running total of the
-- customer's open bills (the limit is checked against it under the row lock).
create table if not exists public.credit_accounts (
  customer_id       uuid primary key references public.customers (id) on delete restrict,
  limit_paise       integer not null check (limit_paise > 0),
  due_days          integer not null check (due_days between 1 and 365),
  status            text not null default 'active' check (status in ('active', 'inactive')),
  outstanding_paise integer not null default 0 check (outstanding_paise >= 0),
  approved_by       uuid not null references public.staff_users (id) on delete restrict,
  approved_at       timestamptz not null default now(),
  note              text check (note is null or length(note) <= 500),
  updated_at        timestamptz not null default now()
);
create table if not exists public.credit_bills (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null unique references public.orders (id) on delete restrict,
  customer_id        uuid not null references public.customers (id) on delete restrict,
  amount_paise       integer not null check (amount_paise > 0),
  outstanding_paise  integer not null check (outstanding_paise >= 0),
  -- the terms as they were when the sale was made: later changes to the account never touch this bill
  limit_paise_at_sale integer not null, due_days_at_sale integer not null,
  due_on             date not null,
  status             text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  created_by         uuid not null references public.staff_users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  closed_at          timestamptz,
  constraint credit_bills_outstanding_within check (outstanding_paise <= amount_paise),
  constraint credit_bills_status_matches check ((status = 'open' and outstanding_paise > 0) or (status in ('paid', 'cancelled') and outstanding_paise = 0))
);
create index if not exists credit_bills_customer on public.credit_bills (customer_id, status);
create index if not exists credit_bills_due on public.credit_bills (due_on) where status = 'open';
create table if not exists public.credit_repayments (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid not null references public.credit_bills (id) on delete restrict,
  number          text not null unique,
  amount_paise    integer not null check (amount_paise > 0),
  method          text not null check (method in ('cash', 'card', 'upi')),
  reference       text check (reference is null or length(reference) <= 64),
  payment_id      uuid not null references public.payments (id) on delete restrict,
  pos_session_id  uuid references public.pos_sessions (id) on delete restrict,   -- the drawer cash went into, when taken at a till
  staff_id        uuid not null references public.staff_users (id) on delete restrict,
  outstanding_after integer not null check (outstanding_after >= 0),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  created_at      timestamptz not null default now()
);
create index if not exists credit_repayments_bill on public.credit_repayments (bill_id, created_at);
create index if not exists credit_repayments_session on public.credit_repayments (pos_session_id) where pos_session_id is not null;

-- ---------------------------------------------------------------- exchanges: how a return was settled, and its replacement bill
alter table public.return_requests add column if not exists settlement text;
alter table public.return_requests add column if not exists settlement_paise integer;
alter table public.return_requests add column if not exists exchange_order_id uuid references public.orders (id) on delete restrict;
-- a return settled at the counter in one step carries the request key, so the same request sent twice is one return
alter table public.return_requests add column if not exists idempotency_key text;
create unique index if not exists return_requests_idempotency_key on public.return_requests (idempotency_key) where idempotency_key is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'return_requests_settlement_check') then
    alter table public.return_requests add constraint return_requests_settlement_check
      check ((settlement is null and settlement_paise is null) or (settlement in ('collect', 'store_credit', 'refund', 'even') and settlement_paise >= 0));
  end if;
end $$;
create unique index if not exists return_requests_exchange_order_key on public.return_requests (exchange_order_id) where exchange_order_id is not null;
-- the replacement bill points back at the return it settles
alter table public.orders add column if not exists exchange_return_id uuid references public.return_requests (id) on delete restrict;
create unique index if not exists orders_exchange_return_key on public.orders (exchange_return_id) where exchange_return_id is not null;

-- ---------------------------------------------------------------- access: staff app only. The store role gets nothing here
-- (online redemption of store credit is a later step with its own review).
do $$ declare t text; begin
  foreach t in array array['store_credit_accounts', 'store_credit_entries', 'credit_accounts', 'credit_bills', 'credit_repayments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, kitsyuu_website', t);
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;
grant select, insert, update on public.store_credit_accounts, public.credit_accounts, public.credit_bills to kitsyuu_admin;
grant select, insert on public.store_credit_entries, public.credit_repayments to kitsyuu_admin;   -- ledgers: rows are never changed or deleted

-- ---------------------------------------------------------------- permissions (the repository's module.action naming)
-- Returns, exchanges and refunds keep their existing permissions (returns.manage, refunds.create); credit and store-credit
-- reports use pos.reports. Managers and cashiers get NO credit permission here: an administrator grants pos.credit_sell or
-- credit.repay to a role under Team & access when the business decides to.
insert into public.permissions (code, module, description) values
  ('pos.credit_sell', 'pos', 'Sell on credit at the counter, to a customer with an approved credit account and within its limit'),
  ('credit.manage', 'credit', 'Approve a customer credit account and change its limit, due period or status'),
  ('credit.repay', 'credit', 'Record a repayment against a credit bill'),
  ('credit.adjust', 'credit', 'Cancel a credit bill or correct a recorded repayment (with a reason)'),
  ('store_credit.redeem', 'store_credit', 'Take a customer''s store credit as payment at the counter'),
  ('store_credit.issue', 'store_credit', 'Give store credit for a return or exchange'),
  ('store_credit.adjust', 'store_credit', 'Add, remove or reverse store credit by hand (with a reason)')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code from public.roles r cross join (values ('pos.credit_sell'), ('credit.manage'), ('credit.repay'), ('credit.adjust'), ('store_credit.redeem'), ('store_credit.issue'), ('store_credit.adjust')) p(code)
where r.code in ('super_admin', 'admin')
on conflict do nothing;
-- Taking store credit as payment is part of ringing up a sale, and giving it for an exchange is part of handling a return:
-- the roles that already do those keep doing them.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'store_credit.redeem' from public.roles r where r.code in ('manager', 'sales') on conflict do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, 'store_credit.issue' from public.roles r where r.code in ('manager', 'sales') on conflict do nothing;
