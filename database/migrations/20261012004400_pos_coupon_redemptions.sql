-- KITSYUU unified billing (2026-10-12): coupons at the POS counter. Grants only; no table, column, policy or data change.
-- LOCAL ONLY so far: prepared and tested on throwaway local test databases. It must be reviewed and go through the
-- live-migration procedure (database/README.md) before any production use.
--
-- A coupon used on a counter sale is recorded like a coupon used at the store checkout: one row in discount_redemptions,
-- written in the same transaction as the sale, with the coupon's usage limits re-checked under a lock
-- (packages/core/src/discounts.ts → recordDiscountRedemptions). Until now only the store's role wrote these rows, so the
-- Admin/ERP role could read them (migration 20260930003000) but not add one. The row-level policy for kitsyuu_admin
-- on this table already exists ("app admin: all rows"); what was missing is the table privilege.
-- The admin role still cannot update or delete a redemption: history stays append-only for it.
-- Safe to re-run: grants are idempotent.

grant insert on public.discount_redemptions to kitsyuu_admin;
grant usage on sequence public.discount_redemptions_id_seq to kitsyuu_admin;
