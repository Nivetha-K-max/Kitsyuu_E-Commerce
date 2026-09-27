-- KITSYUU platform M7: the unpaid-order hold time, as decided by the business (2026-09-27): 10 days.
-- An unpaid order keeps its stock for this long; after it, the order is cancelled and its stock returned through the ledger
-- (by the daily expiry job and before each checkout). Data only: no schema change. If the row already exists (for example
-- changed later from the admin), it is left as it is.
insert into public.settings (key, value, description, is_public) values
  ('checkout.payment_window_minutes', '14400', 'How long an unpaid order holds its stock before it is cancelled (minutes; 14400 = 10 days)', false)
on conflict (key) do nothing;
