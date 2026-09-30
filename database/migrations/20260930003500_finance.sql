-- KITSYUU ERP module 6: finance and accounting. Additive only; safe to re-run.
-- GST rules are the business's to decide: nothing here sets a rate. Staff enter tax rates (tax_rates, existing), map
-- products to a rate (products.tax_rate_code, empty = the default rate setting) and enter the company's GST state
-- (company.state) so invoices can split CGST/SGST from IGST. Existing checkout totals are unchanged while nothing is mapped.
-- * invoices (existing) gain shipping address, discount, shipping, place of supply and the tax split.
-- * finance_notes: credit and debit notes against an invoice.
-- * expense_categories + expenses: money spent (manually entered accounting data).
-- * vendor_payments: payments to vendors, optionally against a purchase order.

alter table public.products add column if not exists tax_rate_code text references public.tax_rates (code) on delete restrict;

alter table public.invoices add column if not exists shipping_address jsonb not null default '{}'::jsonb;
alter table public.invoices add column if not exists discount_paise   integer not null default 0 check (discount_paise >= 0);
alter table public.invoices add column if not exists shipping_paise   integer not null default 0 check (shipping_paise >= 0);
alter table public.invoices add column if not exists place_of_supply  text check (place_of_supply is null or length(place_of_supply) <= 60);
alter table public.invoices add column if not exists tax_split        jsonb not null default '{}'::jsonb;

create table if not exists public.finance_notes (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('credit', 'debit')),
  number      text unique,
  invoice_id  uuid references public.invoices (id) on delete restrict,
  order_id    uuid references public.orders (id) on delete restrict,
  refund_id   uuid references public.refunds (id) on delete set null,
  reason      text not null check (length(btrim(reason)) between 1 and 300),
  amount_paise integer not null check (amount_paise > 0),
  tax_paise   integer not null default 0 check (tax_paise >= 0),
  note_date   date not null default ((now() at time zone 'Asia/Kolkata')::date),
  status      text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  created_by  uuid references public.staff_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint finance_notes_issued_number check (status = 'draft' or number is not null)
);
drop trigger if exists finance_notes_updated_at on public.finance_notes;
create trigger finance_notes_updated_at before update on public.finance_notes for each row execute function public.set_updated_at();

create table if not exists public.expense_categories (
  code       text primary key check (code ~ '^[a-z][a-z_]{1,31}$'),
  label      text not null check (length(btrim(label)) between 1 and 60),
  sort_order integer not null default 0,
  is_active  boolean not null default true
);
insert into public.expense_categories (code, label, sort_order) values
  ('materials', 'Materials and fabric', 1), ('production', 'Production / tailoring', 2), ('packaging', 'Packaging', 3),
  ('shipping', 'Shipping and courier', 4), ('marketing', 'Marketing', 5), ('software', 'Software and subscriptions', 6),
  ('rent', 'Rent and utilities', 7), ('salaries', 'Salaries', 8), ('fees', 'Bank and payment fees', 9), ('other', 'Other', 10)
on conflict (code) do nothing;

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  category_code text not null references public.expense_categories (code),
  amount_paise  integer not null check (amount_paise > 0),
  tax_paise     integer not null default 0 check (tax_paise >= 0),
  vendor_id     uuid references public.vendors (id) on delete set null,
  expense_date  date not null,
  description   text not null check (length(btrim(description)) between 1 and 300),
  reference     text check (reference is null or length(reference) <= 120),
  voided_at     timestamptz,
  created_by    uuid references public.staff_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses (expense_date desc);
drop trigger if exists expenses_updated_at on public.expenses;
create trigger expenses_updated_at before update on public.expenses for each row execute function public.set_updated_at();

create table if not exists public.vendor_payments (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid not null references public.vendors (id) on delete restrict,
  purchase_order_id uuid references public.purchase_orders (id) on delete set null,
  amount_paise      integer not null check (amount_paise > 0),
  status            text not null default 'scheduled' check (status in ('scheduled', 'paid', 'void')),
  paid_on           date,
  method            text check (method is null or method in ('bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other')),
  reference         text check (reference is null or length(reference) <= 120),
  notes             text check (notes is null or length(notes) <= 500),
  created_by        uuid references public.staff_users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint vendor_payments_paid_date check (status <> 'paid' or paid_on is not null)
);
create index if not exists vendor_payments_vendor_idx on public.vendor_payments (vendor_id, created_at desc);
drop trigger if exists vendor_payments_updated_at on public.vendor_payments;
create trigger vendor_payments_updated_at before update on public.vendor_payments for each row execute function public.set_updated_at();

alter table public.finance_notes      enable row level security;
alter table public.expense_categories enable row level security;
alter table public.expenses           enable row level security;
alter table public.vendor_payments    enable row level security;
revoke all on public.finance_notes, public.expense_categories, public.expenses, public.vendor_payments from anon, authenticated, kitsyuu_website;
grant select, insert, update on public.finance_notes, public.expense_categories, public.expenses, public.vendor_payments to kitsyuu_admin;
grant select, insert, update on public.invoices, public.invoice_items, public.tax_rates to kitsyuu_admin;
grant update (tax_rate_code) on public.products to kitsyuu_admin;
do $$ declare t text; begin
  foreach t in array array['finance_notes', 'expense_categories', 'expenses', 'vendor_payments'] loop
    execute format('drop policy if exists "app admin: all rows" on public.%I', t);
    execute format('create policy "app admin: all rows" on public.%I for all to kitsyuu_admin using (true) with check (true)', t);
  end loop;
end $$;

insert into public.permissions (code, module, description) values
  ('finance.read', 'finance', 'View finance: sales, tax, invoices, notes, expenses, vendor payments and reconciliation'),
  ('finance.manage', 'finance', 'Issue invoices and notes, record expenses and vendor payments, manage tax rates')
on conflict (code) do nothing;
insert into public.role_permissions (role_id, permission_code)
select r.id, x.code from public.roles r join (values
  ('super_admin', 'finance.read'), ('super_admin', 'finance.manage'), ('admin', 'finance.read'), ('admin', 'finance.manage'),
  ('accountant', 'finance.read'), ('accountant', 'finance.manage'), ('manager', 'finance.read')
) x(role, code) on r.code = x.role
on conflict do nothing;
