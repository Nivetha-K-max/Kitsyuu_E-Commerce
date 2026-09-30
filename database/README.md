# KITSYUU database

Supabase Postgres (project in Seoul, `ap-northeast-2`). Supabase is used only for the database and Storage.

| Path | Contents |
|---|---|
| `migrations/` | Schema migrations, applied in file-name order and tracked in `app_private.applied_migrations` |
| `seed/catalogue.sql` | Prototype catalogue seed, generated from `apps/website/data/products.json` (idempotent) |
| `setup-all.sql` | All migrations + seed in one file, for a fresh project via the Supabase SQL Editor |
| `scripts/` | Database tooling, run from the repo root |

## Connecting

Scripts read `apps/website/.env.local`. `SUPABASE_DB_URL` is the direct connection string, whose host is IPv6-only.
On an IPv4 network, also set `SUPABASE_DB_POOLER_HOST` to the **Session pooler** host (Supabase → Connect → Session pooler,
e.g. `aws-0-<region>.pooler.supabase.com`). The same credentials are then sent through the pooler. Either put it in
`.env.local` or pass it for one command:

```bash
SUPABASE_DB_POOLER_HOST=<session pooler host> npm run db:apply -- --status
```

## Commands (repo root)

| Command | What it does |
|---|---|
| `npm run db:apply -- --status` | List applied / pending migrations |
| `npm run db:apply -- --dry-run --repeat` | Run pending migrations twice in one transaction, then roll everything back |
| `npm run db:apply -- --no-seed` | Apply pending migrations (each in its own transaction) without re-running the seed |
| `npm run db:apply -- --mark-applied=<file>,…` | Record migrations that were run by hand (SQL Editor); refused unless their objects exist |
| `npm run db:snapshot -- <out.json>` | Read-only fingerprint of existing data, auth accounts, Storage, RLS and grants |
| `npm run db:snapshot -- --compare <a> <b>` | Compare two fingerprints |
| `npm run db:verify` | Catalogue check as the public (anon) key sees it |
| `npm run db:verify-platform` | Platform checks: structure, seeds, security, stock ledger, numbering, views, public-API exposure (rolls back its own test writes) |
| `npm run db:seed-gen` | Regenerate `seed/catalogue.sql` and `setup-all.sql` (writes SQL only, connects nowhere) |
| `npm run db:upload-images` | Upload the catalogue images from `dist/store/images/products/` to Storage |
| `npm run db:promote-admin` | Current Supabase Auth admin promotion; retired in M6 |

## Changing the live database

Every live migration follows these steps. Nothing is dropped, reset or truncated.

1. **Read-only preflight** of the live database: migration log, the structure the migration touches (columns, constraints,
   indexes, RLS policies, grants, functions) and counts of the data it could affect, inside a `READ ONLY` transaction.
   Note: `db:apply -- --status` first runs `create schema/table if not exists` for its migration log; for a strictly
   read-only check, query `app_private.applied_migrations` in a read-only transaction instead.
2. **Rehearsal** on a throwaway local database built to the live state (the migrations already applied on live, the seed,
   the migration log, and rows of every kind the migration converts). Compare its structure with the live preflight, then
   run the migration in a transaction and roll back, twice (the second run proves it is safe to re-run), fingerprinting
   every existing row before and after.
3. `db:snapshot` → apply with `db:apply -- --no-seed` → `db:snapshot` + `--compare` → verify the new objects and
   permissions (on Supabase, also that new functions are not executable by `anon` / `authenticated`).

The live database is reachable only from networks that allow outbound 5432/6543 (use the session pooler on IPv4).

## Migrations

| File | Milestone | What it adds |
|---|---|---|
| `…0100`–`…0300` | Phase 4.2 | Catalogue, orders, auth roles and RLS, Storage |
| `…0400`–`…1100` | M2 | Staff access, customers, stock ledger, carts/wishlists, billing, platform settings + audit, reporting views, app roles |
| `…1200` | M3 | `kitsyuu_admin` login |
| `…1300` | M4 | Category active flag |
| `…1400`–`…1500` | M6 | Customer accounts on the platform, addresses per customer, website audit; `kitsyuu_website` login |
| `…1600` | M7 | Orders, cart and wishlist lines owned by platform customers; pricing, idempotency and payment-hold columns; provider-neutral payment events; `reserve_order_stock` / `release_order_stock` for the website role |
| `…1700` | M7 | Unpaid-order hold time: `checkout.payment_window_minutes` = 14400 (10 days) |
| `20260928001800` | Filters | Product attributes for the store filters: `attributes`, `attribute_values`, `product_attribute_values`; public read of active attributes only. **Applied live 2026-09-28** on its own (`db:apply -- --no-seed --only=…`) |
| `20260929001800` | M8 (**local only**) | Security: the `kitsyuu_admin` role loses table-wide SELECT on `customers` and `customer_sessions` and gets column lists without `password_hash` / `token_hash` (plus UPDATE of `revoked_at` only, to end sessions); its `auth_tokens` policy is limited to staff tokens, so customers' one-time link tokens are invisible to it |
| `20260929001900` | M8 (**local only**) | Fulfilment: `packing_state` enum and `shipments` (one per order: carrier code, optional tracking number, packing state, shipped/delivered times). No status column: the order status stays the status. RLS on, admin role only |
| `20260929002000` | M9 (**local only**) | Operations: permission `system.read` (super_admin, admin), setting `security.checkout_orders_per_hour` = 10, index on `auth_attempts(attempted_at)` |
| `20260929002100` | M10 (**local only**) | `products.hsn_code` (4/6/8 digits, nullable; set by the business). Company details and the delivery charge are settings rows written from the admin, not seeded |
| `20260929002200` | M11 (**local only**) | `products.seo_title` / `seo_description`; `collections.is_active` + `sort_order` (existing collections stay active); the store sees only active collections and their product lists |
| `20260929002300` | M12 (**local only**) | Reviews: `reviews` (one per order line, pending → approved/rejected), `review_photos` (WebP, stored in the database), permissions `reviews.read` / `reviews.moderate`, public view `v_product_ratings` (approved totals only) |
| `20260929002400` | M13 (**local only**) | Purchasing: `vendors`, `materials` (+ `material_movements` ledger, `adjust_material_stock()` and a stock guard trigger), `purchase_orders` / `purchase_order_lines` (PO numbers from `next_document_number`), `goods_receipts` / lines; permissions `procurement.read/manage/receive`, `costs.read` |
| `20260929002500` | M14 (**local only**) | Production: `production_orders` (planned → in progress → completed / cancelled; numbers PR/yy-yy/nnnnn), `production_inputs` (materials planned/used), `qc_results` (passed/rejected, once per order); system reason `production_in`; permissions `production.read/manage`, `qc.record` |
| `20260929002600` | M15 (**local only**) | Stock counts (`stock_counts`, `stock_count_lines`, one open at a time; system reason `count_adjust`), `variant_costs` (unit cost per size, admin only, never visible to the website role); permissions `inventory.count`, `costs.manage` |
| `20260929002700` | M17 (**local only**) | `notification_log` (every customer email attempt), `customer_notes` (internal); the store may read PUBLISHED `site_content` with the public key (drafts stay private); permissions `content.manage`, `customers.note` |
| `20260929002800` | M18 (**local only**) | Optional staff two-factor sign-in: `staff_mfa` (TOTP secret AES-256-GCM encrypted with the admin's `MFA_ENCRYPTION_KEY`, last used step against replay), `staff_mfa_recovery_codes` (SHA-256 hashes, one use each) |
| `20260930002900` | ERP 8 (**local only**) | Staff notification centre: `staff_notifications` (kind, severity, link, the permission that sees it, dedupe key), `staff_notification_reads` (read state per staff member); the store raises alerts only through `raise_staff_notification()`; website reads `alerts.*` settings |
| `20260930003000` | ERP 1 (**local only**) | Pricing: `compare_at_paise` on products and sizes, `price_history` (written by a trigger for every price change), `price_changes` (scheduled), `discounts` (percent/fixed, scope, dates, limits; none exist, `discounts.enabled` off), `discount_redemptions`, `carts.coupon_code`; permissions `pricing.read/manage` |
| `20260930003100` | ERP 2 (**local only**) | Shipping: `shipping_zones`, `shipping_rates` (used only when `shipping.method = zones`), `couriers` (no credentials stored), shipment delivery `status` (existing rows backfilled) + `shipment_events`; permissions `shipping.read/manage` |
| `20260930003200` | ERP 3 (**local only**) | Returns: `return_reasons` (7 seeded), `return_requests`, `return_items`, `return_events`; refunds gain `return_id`, `method` (provider/manual), `reference`, `failure_reason`; system stock reason `exchange`; OFF until `returns.enabled` + `returns.window_days` are set; permissions `returns.read/manage` |
| `20260930003300` | ERP 4 (**local only**) | Marketing: `campaigns` (+ `discounts.campaign_id`), `banners` (public read only while published and in date), `customer_segments`; permissions `marketing.read/manage` |
| `20260930003400` | ERP 5 (**local only**) | Support: `support_categories` (7 seeded), `support_tickets`, `support_messages` (internal notes never visible to the store role); permissions `support.read/manage` |
| `20260930003500` | ERP 6 (**local only**) | Finance: `products.tax_rate_code`, invoice columns (shipping address, discount, shipping, place of supply, GST split), `finance_notes` (credit/debit), `expense_categories` (10 seeded), `expenses`, `vendor_payments`; permissions `finance.read/manage` |
| `20260930003600` | ERP 7 (**local only**) | Carts: `cart_recovery` (abandoned-cart recovery status); staff read carts and wishlists but can never write them; permissions `carts.read/manage` |
| `20261001003700` | Client change request, first pass (**local only**) | Sale price on products and sizes (base price kept; price-history trigger records sale changes; permission `pricing.sale_override`), `checkout_reminders` (one abandoned-checkout reminder per order), `newsletter_subscribers` (consent, unsubscribe token hash), `orders.billing_address` (empty = same as delivery), `size_charts` + `products/categories.size_chart_id`, `production_purchase_orders` (PO ↔ production link) |
| `20261002003800` | Client change request, second pass (**local only**) | Cash on delivery (`orders.payment_method`, `cod_status`, `cod_fee_paise`; permission `orders.cod`), loyalty points (`loyalty_accounts`, `loyalty_transactions` ledger, `orders.loyalty_points_used/_discount_paise`, website read of `loyalty.%` settings; permissions `loyalty.read`, `loyalty.adjust`), order editing (`order_edits`, admin update/delete on `order_items`; permission `orders.edit`) |
| `20261003003900` | Collections grouped + attributes as tags (**local only**) | `collection_groups` (Men, Women, Sale), `collections.group_id / seo_title / seo_description`, hidden empty Men / Women / Sale collections, `attributes.selection` (single / multi), `attribute_values.is_active / swatch` |

> **M8 is local only.** Migrations 1800 and 1900 have been applied only to throwaway local test databases. They must go through the live-migration procedure above (preflight, rehearsal, snapshot, apply, verify) before any deployment. Do not add `grant select on all tables … to kitsyuu_admin` in later migrations: it would undo 1800.

## Conventions

- Migrations are never edited after they have been applied; changes go in a new numbered file.
- Migrations are written to be safe to re-run (`if not exists`, `on conflict do nothing`, guarded `do` blocks).
- Every new table enables RLS and revokes `anon` / `authenticated` explicitly. Supabase's default privileges would
  otherwise grant the public API full access to new tables, views and functions.
- Money is integer paise. Existing catalogue ids (`ky-proto-001`, `tops.hoodies`) are stable; new tables use UUID or
  identity keys.
- Stock changes only through `public.adjust_stock()`. A trigger rejects direct changes to `product_variants.stock_qty`.
- `audit_logs` is append-only: no role has UPDATE/DELETE/TRUNCATE, and a trigger blocks them for everyone.
- App database roles `kitsyuu_admin` (login since M3, migration 1200) and `kitsyuu_website` (login since M6, migration 1500)
  get their passwords from `npm run db:app-role`, never from a migration. Each app keeps its URL only in its own environment.
- Business values nobody has decided (shipping, discounts, tax rules) are not seeded: they stay
  absent from `settings` until decided.
