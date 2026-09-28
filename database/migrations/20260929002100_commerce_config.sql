-- KITSYUU platform M10: commerce go-live configuration. Additive only.
-- products.hsn_code: the HSN code the business assigns per product (needed for GST invoices once tax rules are decided).
-- Nothing is pre-filled. Company details and the delivery charge are settings rows the admin writes when the business
-- enters them (core/settings.ts registry); they are not seeded here, so no value is invented.
-- Safe to re-run.

alter table public.products add column if not exists hsn_code text;
do $$ begin
  alter table public.products add constraint products_hsn_code_format check (hsn_code is null or hsn_code ~ '^[0-9]{4}([0-9]{2}([0-9]{2})?)?$');
exception when duplicate_object then null; end $$;
comment on column public.products.hsn_code is 'HSN code (4, 6 or 8 digits), set by the business. Used for GST invoices once tax rules are decided.';
