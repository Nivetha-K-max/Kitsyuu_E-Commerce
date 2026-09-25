-- KITSYUU platform M2: billing foundation (additive only). Tables start empty apart from the prototype tax rate.
-- Prototype prices are tax-inclusive with no GST line, so the one seeded rate is 0 % and inclusive.
-- No invoice numbers, invoices, payments or refunds are created here.
-- Safe to re-run: every statement is guarded.

-- ---------- types ----------
do $$ begin
  create type public.payment_record_status as enum ('created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.refund_status as enum ('requested', 'pending', 'processed', 'failed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.invoice_status as enum ('draft', 'issued', 'void');
exception when duplicate_object then null; end $$;

-- ---------- tax rates ----------
create table if not exists public.tax_rates (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[A-Z0-9_]+$'),
  label        text not null,
  rate_bp      integer not null check (rate_bp between 0 and 10000),   -- basis points: 1800 = 18 %
  is_inclusive boolean not null default true,                          -- rate is already inside the listed price
  is_active    boolean not null default true,
  valid_from   date not null,
  valid_to     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint tax_rates_valid_range check (valid_to is null or valid_to >= valid_from)
);
drop trigger if exists tax_rates_updated_at on public.tax_rates;
create trigger tax_rates_updated_at before update on public.tax_rates for each row execute function public.set_updated_at();
insert into public.tax_rates (code, label, rate_bp, is_inclusive, valid_from) values
  ('PROTOTYPE_INCLUSIVE', 'Prototype prices: tax-inclusive, no GST line', 0, true, date '2026-09-25')
on conflict (code) do nothing;

-- ---------- payments (one row per provider payment attempt) ----------
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete restrict,
  provider            text not null check (provider ~ '^[a-z][a-z0-9_]*$'),   -- e.g. 'razorpay'
  provider_order_id   text,
  provider_payment_id text,
  amount_paise        integer not null check (amount_paise >= 0),
  currency            text not null default 'INR',
  status              public.payment_record_status not null default 'created',
  method              text,
  failure_reason      text,
  raw                 jsonb not null default '{}'::jsonb,                    -- provider payload, for reconciliation
  captured_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_provider_payment_key unique (provider, provider_payment_id)
);
create index if not exists payments_order_idx on public.payments (order_id);
drop trigger if exists payments_updated_at on public.payments;
create trigger payments_updated_at before update on public.payments for each row execute function public.set_updated_at();

-- ---------- refunds ----------
create table if not exists public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments (id) on delete restrict,
  order_id           uuid not null references public.orders (id) on delete restrict,
  amount_paise       integer not null check (amount_paise > 0),
  reason             text not null default '',
  status             public.refund_status not null default 'requested',
  provider_refund_id text unique,
  requested_by       uuid references public.staff_users (id) on delete restrict,
  processed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists refunds_payment_idx on public.refunds (payment_id);
create index if not exists refunds_order_idx on public.refunds (order_id);
drop trigger if exists refunds_updated_at on public.refunds;
create trigger refunds_updated_at before update on public.refunds for each row execute function public.set_updated_at();

-- ---------- invoices ----------
-- A draft has no number. Issuing assigns one from next_document_number(), so issued numbers are gap-free.
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_number     text unique,
  status             public.invoice_status not null default 'draft',
  order_id           uuid references public.orders (id) on delete restrict,
  customer_id        uuid references public.customers (id) on delete restrict,
  financial_year     text check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),   -- Indian FY, e.g. '2026-27'
  issued_at          timestamptz,
  currency           text not null default 'INR',
  subtotal_paise     integer not null default 0 check (subtotal_paise >= 0),
  tax_paise          integer not null default 0 check (tax_paise >= 0),
  total_paise        integer not null default 0 check (total_paise >= 0),
  prices_include_tax boolean not null default true,
  billing_address    jsonb not null default '{}'::jsonb,
  seller_details     jsonb not null default '{}'::jsonb,                    -- snapshot of seller name/address/GSTIN at issue time
  notes              text,
  voided_at          timestamptz,
  void_reason        text,
  created_by         uuid references public.staff_users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint invoices_issued_has_number check (status = 'draft' or (invoice_number is not null and issued_at is not null and financial_year is not null))
);
create index if not exists invoices_order_idx on public.invoices (order_id);
create index if not exists invoices_customer_idx on public.invoices (customer_id);
drop trigger if exists invoices_updated_at on public.invoices;
create trigger invoices_updated_at before update on public.invoices for each row execute function public.set_updated_at();

create table if not exists public.invoice_items (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices (id) on delete cascade,
  order_item_id    uuid references public.order_items (id) on delete restrict,
  position         int not null default 0,
  description      text not null,
  sku              text,
  hsn_code         text,
  qty              int not null check (qty > 0),
  unit_price_paise integer not null check (unit_price_paise >= 0),
  tax_rate_id      uuid references public.tax_rates (id) on delete restrict,
  tax_rate_bp      integer not null default 0 check (tax_rate_bp between 0 and 10000),   -- snapshot of the rate used
  tax_paise        integer not null default 0 check (tax_paise >= 0),
  line_total_paise integer not null check (line_total_paise >= 0)
);
create index if not exists invoice_items_invoice_idx on public.invoice_items (invoice_id);

-- ---------- document numbering (per document type and Indian financial year, April → March) ----------
create table if not exists public.document_sequences (
  doc_type       text not null check (doc_type ~ '^[a-z][a-z_]*$'),       -- e.g. 'invoice', 'credit_note'
  financial_year text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix         text not null check (prefix ~ '^[A-Z0-9-]{1,6}$'),
  next_value     bigint not null default 1 check (next_value >= 1),
  updated_at     timestamptz not null default now(),
  primary key (doc_type, financial_year)
);

create or replace function public.financial_year_of(p_date date) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from p_date) >= 4
    then extract(year from p_date)::int::text || '-' || lpad(((extract(year from p_date)::int + 1) % 100)::text, 2, '0')
    else (extract(year from p_date)::int - 1)::text || '-' || lpad((extract(year from p_date)::int % 100)::text, 2, '0')
  end
$$;

-- Returns e.g. 'KTS/26-27/00001' (15 characters: within the 16-character limit for GST invoice numbers).
-- The row lock taken by UPDATE is held until the caller's transaction ends, and a rolled-back transaction does not
-- consume its number, so issued numbers have no gaps. The prefix is supplied by the caller (from settings).
create or replace function public.next_document_number(p_doc_type text, p_prefix text, p_date date default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_fy     text := public.financial_year_of(coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date));
  v_n      bigint;
  v_prefix text;
begin
  insert into public.document_sequences (doc_type, financial_year, prefix) values (p_doc_type, v_fy, p_prefix)
  on conflict (doc_type, financial_year) do nothing;
  update public.document_sequences set next_value = next_value + 1, updated_at = now()
  where doc_type = p_doc_type and financial_year = v_fy
  returning next_value - 1, prefix into v_n, v_prefix;
  return v_prefix || '/' || substr(v_fy, 3) || '/' || lpad(v_n::text, 5, '0');
end $$;

-- ---------- lock down ----------
alter table public.tax_rates          enable row level security;
alter table public.payments           enable row level security;
alter table public.refunds            enable row level security;
alter table public.invoices           enable row level security;
alter table public.invoice_items      enable row level security;
alter table public.document_sequences enable row level security;
revoke all on public.tax_rates, public.payments, public.refunds, public.invoices, public.invoice_items, public.document_sequences
  from anon, authenticated;
revoke all on function public.financial_year_of(date) from public, anon, authenticated;
revoke all on function public.next_document_number(text, text, date) from public, anon, authenticated;
