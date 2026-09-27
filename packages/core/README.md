# @kitsyuu/core

Server-only business services shared by the website and the Admin/ERP. Apps validate input, check the session and call these services; they never query the database for a business operation themselves. Importing this package in browser code throws.

| Module | What it does |
|---|---|
| `staff.ts`, `roles.ts`, `guards.ts` | Staff accounts, invitations, roles and permissions, no privilege escalation, lock-out guard (M3) |
| `audit.ts`, `dashboard.ts` | Reading the audit log; admin dashboard figures |
| `products.ts`, `variants.ts`, `categories.ts`, `images.ts`, `storage.ts` | Catalogue management and product images behind the `ObjectStorage` interface (M4) |
| `inventory.ts` | Stock list and adjustments through `adjust_stock()` (ledger + audit in one transaction) |
| `orders.ts` | Admin order list, detail and status changes (staff side of the workflow) |
| `customer-account.ts` | Customer profile, addresses and order history (M6) |
| `order-state.ts` | **M7.** `applyOrderTransition()`: the only way an order's status changes (checked against `ORDER_TRANSITIONS_BY_ACTOR`, written to the status history) |
| `pricing.ts` | **M7.** `priceOrder()`: subtotal, discounts (`DiscountRule[]`), shipping (`ShippingProvider`), tax (`tax_rates`), total, plus a snapshot of how they were worked out |
| `cart.ts`, `wishlist.ts` | **M7.** The customer's database cart and wishlist, with guest (browser) merge after login |
| `checkout.ts` | **M7.** Order creation (transactional, idempotent, stock reserved through the ledger), payment sessions, verified payment results, webhooks, customer cancellation, optional unpaid-order expiry |
| `payments/provider.ts` | **M7.** The `PaymentProvider` interface |
| `payments/test-provider.ts` | Development provider (server-signed simulated results; refused in production) |
| `payments/razorpay.ts` | Razorpay adapter (test mode only; signature + API read-back; signed webhooks). Not enabled. |

Tests: `test/*.test.mjs` run against a throwaway local database as the real app roles (`npm run test:admin`). `test/fake-razorpay.mjs` is a local stand-in for Razorpay's API and Checkout, used by the commerce tests.
