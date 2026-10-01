# KITSYUU — client change request: implementation tracking

Source: the client's meeting notes (handwritten), mapped to the existing store and ERP. Updated 2026-09-30.
Status values: **EXISTING / VERIFIED** · **MODIFIED** · **NEWLY IMPLEMENTED** · **CONFIGURATION REQUIRED** · **CLIENT INPUT REQUIRED** · **BLOCKED**.
"Local only" = built and tested locally; not committed, pushed, deployed or migrated on the live database.

Rule followed throughout: no business value is invented. Where the client has not given a number or policy, it is a setting that
starts empty or off, so the live store behaves exactly as before until the business sets it.

## Phases

| Pass | Scope | State |
|---|---|---|
| First | Bulk editor, sale price, abandoned checkout, delivery options, newsletter, billing address, size charts, production ↔ purchasing, brand wording, reviews, cart refresh | Local only, tested |
| Second | Loyalty points, COD, pre-shipment order editing | Local only, core-tested (all switches off) |
| Third | Colour variants, inventory locations, stock transfers, online vs retail channel, location reports | Local only, tested (not migrated live) |

---

## First pass (local only)

| ID | Requirement (client note) | Before | What was done | Main files | Database | Permissions | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| FP-1 | Bulk editor (products: status, category, collection, attributes, sale, draft/publish, completeness) | Only bulk status (publish/draft/archive) on the Products list | New Products → **Bulk edit** page: filter, tick products (select-all), choose ONE change, confirm. Each product goes through the same service as a single edit, so publishing still requires active categories, an offered size and a primary image; a sale still respects the maximum discount. Failures are listed per product with the reason; one summary audit record per operation plus the normal per-product audit records | `core/src/bulk-products.ts`, `core/src/products.ts` (`setProductCategory`), `admin/app/(erp)/products/bulk/*`, `admin/components/SelectAll.tsx`, `contracts/src/erp.ts` (`bulkEditInput`) | — | Existing: `products.write` (status, category, attributes), `categories.write` (collections), `pricing.manage` (sale) | core `client-first-pass` (bulk), admin browser `erp.mjs` | NEWLY IMPLEMENTED |
| FP-2 | Separate sale price; base price kept; maximum discount; role-based pricing | Only a compare-at ("was") price; a sale meant changing the price | `sale_price_paise` on products (with optional start / end) and on sizes that have their own price. The base price is never changed by a sale. Customers pay the sale price while it runs, worked out **on the server** (cart, checkout, order). The store shows the sale price with the price as the "was" price. Setting **Maximum sale discount (%)**: staff cannot go deeper unless they hold the new `pricing.sale_override`. Every change is audited and appears in price history ("sale") | `core/src/sale.ts`, `core/src/cart.ts`, `core/src/pricing-admin.ts`, `admin/app/(erp)/pricing/[id]`, `website/lib/catalogue.ts` | `products.sale_*`, `product_variants.sale_price_paise`, price-history trigger also records sale changes | New `pricing.sale_override` (super admin, admin). Existing `pricing.manage` | core (sale: limit, override, dates, server price, history) | NEWLY IMPLEMENTED · limit value = CONFIGURATION REQUIRED |
| FP-3 | Abandoned checkout ("pay cart") → notification after 24 h | Unpaid orders existed but were not flagged | An order still unpaid (awaiting payment / payment failed) after **Abandoned checkout after** (24 h, as the client asked, until changed) is listed under Carts → **Abandoned checkouts**. One reminder email per order at most (claimed before sending, so never twice), never after the order is paid or cancelled, never to an address that unsubscribed, and only when **Abandoned-checkout reminder email** is on AND a real email provider is configured. With the local console mailer nothing is sent. Job endpoint `/api/jobs/abandoned-checkouts` (secret) and a "Send due reminders" button | `core/src/checkout-reminders.ts`, `admin/app/(erp)/carts/checkouts`, `admin/app/api/jobs/abandoned-checkouts` | `checkout_reminders` | Existing `carts.read` / `carts.manage` | core (delay, switch, provider, dedupe, unsubscribed, paid) | NEWLY IMPLEMENTED · email = CONFIGURATION REQUIRED (Resend) |
| FP-4 | Multiple delivery options (Standard / Express), customer chooses | Zone rates existed; checkout picked one automatically | Checkout lists every rate that applies to the delivery address and order value (e.g. Standard, Express) with its charge and estimate; the customer chooses; the server re-checks the choice when the order is placed (an option that does not apply falls back to an offered one). Prices, estimates and which options exist are entered by staff under Shipping → Zones & rates | `core/src/shipping.ts`, `core/src/pricing.ts`, `core/src/checkout.ts`, `website/components/CheckoutForm.tsx`, `website/app/checkout/page.tsx` | — | Existing `shipping.manage` | core (options, choice, fallback, order total) | NEWLY IMPLEMENTED · rates = CONFIGURATION REQUIRED |
| FP-5 | Email subscribers (home page + backend) | Placeholder form that stored nothing | Real sign-up with a consent checkbox (the wording is stored with the time and where), one entry per address (signing up again is harmless; an unsubscribed address can re-subscribe with new consent), unsubscribe link page `/newsletter/unsubscribe?token=…` (token hash only). Admin: Marketing → **Newsletter subscribers** (search, status, unsubscribe, CSV export with consent). No newsletter is sent (no provider) | `core/src/newsletter.ts`, `website/components/Newsletter.tsx`, `website/app/newsletter-actions.ts`, `website/app/newsletter/unsubscribe`, `admin/app/(erp)/marketing/subscribers/*` | `newsletter_subscribers` | Existing `marketing.read` / `marketing.manage`; export also needs `customers.read` | core (consent, duplicates, token, resubscribe, export permission) | NEWLY IMPLEMENTED · sending = CONFIGURATION REQUIRED |
| FP-6 | Billing address: "same as shipping" or separate | Only the delivery address was stored | Checkout: "Billing address is the same as the delivery address" (ticked by default); untick to choose another saved address. Stored as a snapshot on the order (empty = same as delivery, as for every existing order). Shown on the customer's and the admin's order pages and used on GST invoices | `core/src/checkout.ts`, `contracts/src/index.ts` (`placeOrderInput`), `website/components/CheckoutForm.tsx`, `core/src/orders.ts`, `core/src/customer-account.ts`, `core/src/finance.ts` | `orders.billing_address` | — | core (separate, same, someone else's address refused) | NEWLY IMPLEMENTED |
| FP-7 | Size charts | None | Catalogue → **Size charts**: a chart is a pasted table (Size, then measurements), unit, note, active; assigned to categories and/or single products. A product shows its own chart, else its subcategory's, else its category's. Product pages show a "Size chart" panel. Only active charts are public | `core/src/size-charts.ts`, `admin/app/(erp)/size-charts/*`, `website/lib/catalogue.ts`, `website/app/product/[slug]/page.tsx` | `size_charts`, `products.size_chart_id`, `categories.size_chart_id` | Existing `products.read` / `products.write` | core (table validation, category chart, product override, inactive not public), admin browser | NEWLY IMPLEMENTED · chart data = CONFIGURATION REQUIRED |
| FP-8 | Purchase order ↔ production (link both), multiple selection | Production used materials; POs bought materials; no link | Production order page → **Materials to buy**: still needed, in stock, on order, short. Staff choose a vendor and quantities (prefilled with the shortfall, several materials at once) and raise a **draft** PO linked to the production order. It then follows the normal vendor workflow (place order → receive in parts or in full → material ledger). Linked POs are listed on the production order, and the production order on the PO. No cost is filled in | `core/src/production-purchasing.ts`, `admin/app/(erp)/production/[id]`, `admin/app/(erp)/purchase-orders/[id]` | `production_purchase_orders` | Existing `procurement.manage` + `production.read` | core (shortfall, on-order, link, partial receipt through the ledger) | NEWLY IMPLEMENTED |
| FP-9 | "Japan → India: No" | Wording fixed in code | Every storefront line that states the Japan → India origin is now editable under Store content → **Brand wording**, with today's text as the default (nothing changes until staff publish new wording). Occurrences made editable: site title and description (all pages), hero top line "JAPAN → INDIA", hero eyebrow "KITSYUU — FROM JAPAN TO INDIA", hero tagline "Japanese streetwear. Unconventional shapes. Made personal.", home section eyebrow "KITSYUU STORE / JAPAN → INDIA", home section text "Japanese streetwear, brought to India…", footer "JAPANESE STREETWEAR. / INDIAN STREETS.", Our story description. **Not changed:** image descriptions ("…Japanese alley") because they describe the photos; "India only / Indian mobile number" because they are delivery facts; the Our story film page (`lib/landing.generated.ts`, 7 mentions), which is generated from the original landing site | `core/src/site-copy.ts`, `admin/app/(erp)/content`, `website/lib/content.ts`, `website/app/layout.tsx`, `website/components/BrandHero.tsx`, `StoreHome.tsx`, `Footer.tsx`, `website/app/our-story/page.tsx` | — (uses `site_content`) | Existing `content.manage` | core (defaults, publish, public read), admin browser | MODIFIED · new wording = CLIENT INPUT REQUIRED |
| FP-10 | Reviews only for purchased items | Already enforced: a review is written for one purchased order line, once, checked on the server; staff moderate | Verified. The setting's choices were relabelled to say so explicitly ("Customers who bought it, after payment / after delivery"); "Closed" keeps reviews off | `core/src/settings.ts` | — | Existing | existing core `m12-reviews` | EXISTING / VERIFIED · switching on = CONFIGURATION REQUIRED |
| FP-11 | Cart: "10 items → 30 minutes → refresh" | Max 10 per line (existing) | **Clarified by the client (2026-09-30): no cart item limit; a cart with items refreshes automatically every 30 minutes.** While the cart has items, the store re-syncs it with the server every **Cart refresh interval** (30 minutes, as the client asked, until changed): a signed-in cart is re-loaded (current prices, sale prices, stock); a guest cart is re-checked against a freshly loaded catalogue. Also on returning to the tab after that time. A refresh never empties the cart, reserves stock or signs anyone out. The existing per-line maximum (10 of one size) is unchanged | `core/src/cart.ts` (`cartRefreshMinutes`), `website/app/api/store/route.ts`, `website/components/StoreProvider.tsx` | — | — | core (default 30, setting, no cart-wide limit) | NEWLY IMPLEMENTED |

### New settings (all empty / off until set; Settings page)

| Key | Group | Default behaviour |
|---|---|---|
| `pricing.max_sale_discount_percent` | Discounts | No limit |
| `checkout.abandoned_after_hours` | Checkout | 24 hours (client's request) |
| `checkout.cart_refresh_minutes` | Checkout | 30 minutes (client's request) |
| `notifications.abandoned_checkout` | Customer emails | Off |

### New permission
`pricing.sale_override` — set a sale deeper than the maximum sale discount (super admin, admin).

### Migration
`database/migrations/20261001003700_client_first_pass.sql` — additive only; no existing row is changed (existing orders keep an empty billing address, meaning "same as delivery"; no product gets a sale price or size chart).

---

## Second pass (local only)

Nothing is switched on. COD, loyalty earning and loyalty redemption stay off until the business sets the values below; no value was invented.

| # | Requirement | Before | What was built | Files | Settings / permissions | Tests | State |
|---|---|---|---|---|---|---|---|
| SP-1 | Cash on delivery ("COD → discount → notification", "COD / paid") | Rates could record "COD allowed" and a COD fee; not offered at checkout | A payment method of its own (`orders.payment_method`, `cod_status` to collect → collected / refused, `cod_fee_paise`). Offered only when switched on AND the chosen delivery rate allows COD; fee = that rate's COD fee; optional COD discount and order value range. A COD order goes straight to packing (stock taken as usual, no online payment, no expiry). Customer gets the order confirmation email at once ("pay ₹X in cash when it is delivered"); staff get the new-order alert "cash on delivery: ready to pack". Staff record the cash collected (amount must equal the total; recorded as a `cod` payment, order becomes paid), cancel before dispatch (stock back), or record a refused parcel (order cancelled, shipment failed, stock back only if staff tick it). Invoices show the COD fee. | `core/src/cod.ts`, `pricing.ts`, `checkout.ts`, `order-state.ts`, `notifications.ts`, `contracts` (COD_TRANSITIONS), admin order page + actions, store checkout | `payments.cod_enabled` (off), `payments.cod_discount`, `payments.cod_min_order`, `payments.cod_max_order` (empty); per-rate COD allowed + fee (Shipping → Zones); permission `orders.cod` | core (2 tests), store browser | NEWLY IMPLEMENTED · values = CLIENT INPUT |
| SP-2 | Loyalty points ("customers → loyalty points, file option") | None | Ledger (`loyalty_transactions`) + balance (`loyalty_accounts`), all changes on the server in the order's transaction. Earned per ₹100 of items paid for (after discounts, not delivery/fees), once per order, when paid or when delivered (setting). Redeemed at checkout ("use my points", server-priced, min/max per order, never more than the items). Cancelled order: points used come back, points earned are taken back (as many as are left). Expiry: unused points expire N months after they were added (job route). Staff: add/remove points with a reason (customer page), import opening balances from a CSV file (all or nothing: every email must be a customer), Loyalty page (balances, latest changes, rules in force). Customer: Account → Points (balance, history, expiring soon), points used shown on orders. | `core/src/loyalty.ts`, `pricing.ts`, `checkout.ts`, `orders.ts`, `cod.ts`, admin `/loyalty`, customer page, `api/jobs/loyalty-expiry`, store `/account/points`, checkout | `loyalty.enabled` (off), `loyalty.earn_points_per_100`, `loyalty.earn_when`, `loyalty.point_value_paise`, `loyalty.min_redeem_points`, `loyalty.max_redeem_points`, `loyalty.expiry_months` (all empty); permissions `loyalty.read`, `loyalty.adjust` | core (2 tests), admin + store browser | NEWLY IMPLEMENTED · values = CLIENT INPUT |
| SP-3 | Order editing before shipment ("order → before shipment, editing") | None (amounts were a fixed snapshot) | Staff edit (Orders → order → Edit order): sizes (same product, same price only), quantities (0 removes; one line must stay), delivery address. Allowed for a paid online order (paid/processing) or a COD order still to collect; not once shipped, with an issued invoice (void first) or with a non-edit refund. Server recalculates: lines keep the price paid; coupon/automatic discounts scaled pro rata (never up); COD discount and points kept; delivery re-quoted only for a new address (refused where there is no delivery / no COD); tax at the order's recorded rate. Stock through the ledger in the same transaction. A lower total on an online order leaves a refund due, made from the order page (provider or recorded with reference); a higher total is refused (no way to collect extra). COD: new total collected on delivery. Every edit keeps before/after, reason, staff (`order_edits`) and an audit record. | `core/src/order-edit.ts`, `returns.ts` (refund helpers exported), admin order page + actions | permission `orders.edit` (super admin, admin) | core (2 tests) | NEWLY IMPLEMENTED |

### Migration
`database/migrations/20261002003800_client_second_pass.sql`: additive only. New order columns default to what every existing order is (paid online, no COD fee, no points); new tables start empty; permissions for super admin and admin only.

### Decisions made where the notes were silent (please confirm)
- Points are earned on items paid for after discounts (not delivery or fees); cancelled orders reverse points; refunds/returns do **not** change points automatically (staff adjust with a reason).
- COD availability follows the delivery rate's "COD allowed" flag; with no zone rates COD is not offered. COD order value range is checked on items after discounts.
- Order edits: staff only (customers cannot edit); no new products added to an order; the customer is not emailed about an edit; discount redemption records keep their amount at placement.

---

## Collections (Men / Women / Sale) and attributes as tags (local only)

### Collection structure
- **Men, Women, Sale** are collection **groups** (table `collection_groups`, more can be added from the Collections page) and three collections of the same names, created **hidden and empty** by the migration. No product was guessed into Men or Women: staff add products, then show each collection.
- One model, reused: `collections` + `collection_products` (many-to-many). A product keeps its **category / subcategory**; collections are separate. The **Sale collection** is merchandising chosen by staff; the **sale price** (Pricing) is separate and never adds a product to Sale automatically.
- Existing collections (New Arrivals) and every product membership are unchanged; New Arrivals is shown under "Other" and stays first in the store menu.
- Admin → Collections: tabs All / Men / Women / Sale / Other; a card per collection with Products / Active / Draft counts, **View products** (the product list filtered by that collection) and **Edit collection** (name, group, search-engine title and description, store visibility, products and their order). New collections and groups need only a name (the link id is made from it).
- Product page: **Collections** tag picker (Men, Women, Sale, …). Products list: **Collection** and **Availability** filters that combine with search, category (incl. subcategory), status and price. Bulk edit: add to / remove from **several collections at once**.
- Store: an active collection appears in the menu and at `/shop?collection=men` (existing route, no new route); its search-engine title/description are used when set.

### Attribute UX (tags)
- Admin → Attributes: each attribute shows its values as **chips**; **+ Add value** adds one (stored in the database); a chip opens to **rename**, **deactivate / reactivate**, reorder, or delete (only while no product uses it). Search attributes/values; filter active / deactivated values. No ids, JSON or UUIDs shown; names only.
- **Duplicates**: names are unique per attribute ignoring letter case (Black / black / BLACK = one value); the case staff typed is kept.
- **One or several values** per product (single / multi) per attribute; switching to "one value" is refused while products have several.
- **Deactivate, never destroy**: a deactivated value stays on the products that have it, is not offered for new tagging and is not a store filter option.
- Product page and Bulk edit use the same **searchable tag picker** (type to filter; Enter adds the first match). Bulk: several values at once; adding a value of a one-value attribute replaces the product's current one.
- Store filters are unchanged in design and read the same tables (inactive values left out).

### Colour: one source of truth
- **Colour is an ordinary attribute** (id `colour`, now allowed) with optional swatches. When the business creates and shows it, the store's colour filter uses it instead of reading each product's colour name; until then the old behaviour continues (no automatic rewrite of products).
- **Colour variants (third pass)** will reference these same Colour values (`attribute_values` with attribute `colour`), so there will not be two unrelated colour lists. The product's free-text colour name stays as its display text.

### Permissions (reused, none added)
`categories.read` / `categories.write` for collections, groups and attribute definitions (as before); `products.write` for tagging products; bulk collection changes need `categories.write`. All enforced in core services.

### Audit
collection.create / update / status_update / reorder / add / remove, collection_group.create, attribute.create / update / value_add / value_rename / value_status_update / value_delete, product.attributes_update, product.bulk_edit (one summary per bulk change, plus each product's change).

### Migration
`database/migrations/20261003003900_collections_attributes.sql`: additive (collection_groups; collections.group_id / seo_title / seo_description; attributes.selection; attribute_values.is_active / swatch; the three hidden collections). Nothing deleted or rewritten.

### Client input required
- Which products go into Men, Women and Sale (not guessed).
- Whether the store menu should show Men / Women / Sale before or after New Arrivals, and when to show them.
- The Colour values (names and swatches) and whether each product's colour name should be converted into Colour tags (a one-off, reviewed step; not done automatically).

---

## Purchase + production + orders workflow (local only)

No new tables or migration: the existing purchase order, production and order models already support what was asked.

### Purchase + production
- **One vendor, several materials, one PO**: Supply → Purchase orders → New purchase order: vendor, expected date, a searchable list of all active materials with quantity and unit price per row, notes/terms → one draft PO with every line (existing `purchase_orders` + `purchase_order_lines`). Line totals, subtotal and grand total are shown. Purchase orders record **no tax or discount** (not in the model; not invented).
- **Production → PO for the shortfall**: the production order's "Materials to buy" shows planned, used, in stock, on order and short per material, and raises ONE draft PO to a chosen vendor for the short items only (existing from the first pass). It now also shows the **procurement status** (not ordered / partially ordered / ordered / received / covered by stock) and each linked PO with its vendor, status, ordered, received and remaining quantities. One production order can have several POs (`production_purchase_orders`, many-to-many).
- **Print PO**: Purchase order → Print PO (A4, the browser's print dialog; no PDF service): company details (Settings → Company), vendor details, PO number, date, expected delivery, created by, items (#, item, code, qty, unit, unit price, total), subtotal, grand total, notes/terms. Prices only for staff with `costs.read`.

### Invoice printing
- Order → **Print invoice** opens the issued invoice (Finance), which is built from the order's own data: seller details from Settings → Company (omitted when empty), bill-to and ship-to, items with size, qty, rate, tax, amounts, subtotal, discount (including loyalty points), delivery, COD fee, tax / GST split when configured, total, payment method, payment status, order status. Printable on A4.
- Without an invoice, staff with `finance.manage` can **Issue invoice** from the order (numbering and GST are the Finance module's rules).

### Orders: All / Active / Draft / Abandoned
- One order list with views (no copies of orders): **Active** = paid, being packed or shipped; **Draft** = placed but not paid, newer than the abandoned-checkout time; **Abandoned** = still unpaid after that time (Settings → Checkout, 24 h until set), with last activity and reminder status; reminders stay under Carts → Abandoned checkouts.

### Order editing
- Existing (second pass): staff edit before shipment (Edit order button on eligible orders): **size** (another size of the same product at the same price, with stock shown), **quantity**, **delivery address**; refused once shipped. Stock is checked and moved in the same transaction; a sold-out size is refused with "Size L is currently unavailable". Paid online: lower total → refund due; higher total → refused. COD: new amount to collect. Edit history (who, what, before → after, when) and audit.
- **Colour change**: available with the third pass for products that come in colours (another colour and / or size of the same product, same price, stock checked).

### Permissions (reused, none added)
`procurement.read / manage / receive`, `costs.read`, `production.read`, `orders.read / edit / cod`, `finance.read / manage`, `refunds.create`.

### Client input required
- Tax / discount lines on purchase orders (not recorded today), and vendor payment terms text for the printed PO.
- Invoice numbering format (today: the Finance module's numbering) and GST rules (Settings / Finance → Tax).
- Whether a draft (unpaid) order may be completed manually by staff (today: the customer pays, or it expires / is cancelled).
- Whether an order may be edited after packing but before shipment (today: allowed until shipped).
- Customer email when staff edit an order (none is sent today).

---

## Third pass: locations, transfers, channels, colour variants (local only)

Migration `20261004004000_third_pass.sql`. Nothing is hard-coded: locations are rows staff add. The migration creates ONE location,
"Chennai Warehouse" (code CHN-WH), and only when no location exists yet. It is the **online location**: its stock is exactly the
store's existing stock (`product_variants.stock_qty`), so the cart, checkout and orders work as before. Existing catalogue data is **not
converted**: products keep their sizes without a colour until staff give them one.

### Inventory locations
- Catalogue → **Locations**: list (units and sizes in stock per location), add / edit (name, code, kind: warehouse / retail branch /
  other, address, active). Retail Branch 1 and 2 are added here by staff; they are not created by the migration.
- Rules: exactly one online location; it cannot be deactivated. A location with stock or an open transfer cannot be deactivated.
  Codes and names are unique.
- Location page: stock per size (search, include empty sizes), **Change stock here** (the usual reasons; **Retail sale** only at retail
  locations), recent movements with their transfer.
- Every change is a stock-ledger row with its location (`inventory_movements.location_id`). The online location's stock equals
  `stock_qty` at all times (enforced by the database functions and checked in the tests).
- Stock counts are per location: choose the location when opening a count; one open count per location.

### Stock transfers
- Catalogue → **Transfers**: New transfer (from, to, a quantity per size from what the sender holds) → **draft** → **Send**
  (stock leaves the sender: *Transfer out*) → **Mark as received** (stock arrives: *Transfer in*). Cancelling a sent transfer returns
  the stock to the sender; cancelling a draft moves nothing. A transfer can't be sent without enough stock at the sender.
- Numbering TR-…; who created / sent / received and when; audited.

### Online vs retail channel
- `orders.channel` (online / retail), separate from location. Every store order is **online**.
- In-store sales are recorded as **Retail sale** stock movements at a retail location. No retail orders, prices or takings are
  invented: a full till / POS is **CLIENT INPUT REQUIRED**.

### Location report
- Locations → **Report** (date range, India time): per location, stock now, sold online (net of cancellations), retail sales,
  transfers in / out, other changes. By channel: online orders, units and takings (paid → delivered); retail units (no takings until a POS).

### Colour variants (option 1: one product, colour variants with their own sizes, stock and images)
- A size can have a colour (`product_variants.colour_slug`, a value of the Colour attribute). A product is either without colours
  (as today) or every size has a colour. Sizes are unique per product + colour.
- Product page (admin): **Colour** per size (the SKU never changes), **Add size** asks for the colour on a coloured product
  (SKU `<PRODUCT>-<COLOUR>-<SIZE>`), **Shows colour** per photo, stock per location per size.
- Store: the product page shows colour swatches first; the sizes and photos follow the chosen colour; the cart, checkout, order,
  confirmation email, invoice, packing slip and returns show the colour. Products without colours look exactly as before.
- Order editing (staff, before shipment) can now move a line to another colour and / or size of the same product.
- Converting existing products into colour variants is a reviewed, manual step (Sizes → Colour); nothing is migrated automatically.

### Permissions
New: `locations.manage` (super admin, admin), `inventory.transfer` (super admin, admin, manager, inventory manager).
Reused: `inventory.read`, `inventory.adjust`, `inventory.count`, `products.write`.

### Client input required
- A retail till / POS: will branches sell through this system (prices, payments, receipts), or only hold stock?
- Which location ships online orders (today: Chennai Warehouse, the online location). Should online orders ever ship from a branch?
- The addresses and codes of Retail Branch 1 and 2 (staff add them under Locations).
- Which existing products come in several colours, and their colour values (the conversion is manual).

---

## Full client list — mapping and status

| # | Client note | Status | Notes |
|---|---|---|---|
| 1 | Multi-location inventory (Chennai warehouse, retail branches) | NEWLY IMPLEMENTED (third pass) | Database-driven locations, per-location stock on the existing ledger, transfers, counts per location. |
| 2 | Online vs retail sales channel | NEWLY IMPLEMENTED (third pass) · CLIENT INPUT REQUIRED | `orders.channel`, separate from location; retail sales recorded as stock movements. Full retail POS = CLIENT INPUT REQUIRED. |
| 3 | Full bulk product editor | NEWLY IMPLEMENTED (FP-1) | |
| 4 | New product defaults to Draft | EXISTING / VERIFIED | `createProduct` has always created drafts; re-tested. |
| 5 | Product approval / publish workflow | EXISTING / VERIFIED + FP-1 | Publishing checks completeness (single and bulk). A separate approver role = CLIENT INPUT REQUIRED. |
| 6 | Abandoned cart email | EXISTING (ERP module 7) | Staff-sent reminder; automatic sending needs the email provider. |
| 7 | Abandoned checkout after 24 h | NEWLY IMPLEMENTED (FP-3) | |
| 8 | COD | NEWLY IMPLEMENTED (SP-1) | Off until switched on; follows the delivery rates. |
| 9 | COD fee / discount / notification | NEWLY IMPLEMENTED (SP-1) · CLIENT INPUT REQUIRED | Fee per rate and a discount are both possible, both empty; confirmation email and staff alert on placement. |
| 10 | Express delivery | NEWLY IMPLEMENTED (FP-4) | Charges entered by staff. |
| 11 | Loyalty points | NEWLY IMPLEMENTED (SP-2) · CLIENT INPUT REQUIRED | All rules are settings, empty; "file option" = CSV import of opening balances. |
| 12 | Newsletter subscribers | NEWLY IMPLEMENTED (FP-5) | |
| 13 | Verified-purchaser reviews | EXISTING / VERIFIED (FP-10) | |
| 14 | PO → goods received → inventory | EXISTING / VERIFIED | Partial receiving through the material ledger (re-tested in FP-8). |
| 15 | PO ↔ production link | NEWLY IMPLEMENTED (FP-8) | |
| 16 | Multiple selection / bulk operations | NEWLY IMPLEMENTED (FP-1, FP-8) | |
| 17 | Attributes → customer filters | EXISTING / VERIFIED | Shop filters by attribute, price, size, colour, availability. |
| 18 | Colour variants and size-chart behaviour | Size charts: NEWLY IMPLEMENTED (FP-7) · Colour variants: NEWLY IMPLEMENTED (third pass) | Client chose one product → colour variants with their own sizes, stock and images. Existing catalogue data is not migrated automatically. |
| 19 | Product SEO structure | EXISTING / VERIFIED | Slugs, SEO title and description. |
| 20 | Branch / location reporting | NEWLY IMPLEMENTED (third pass) | Locations → Report: per location and per channel. |
| — | Image click → product page | EXISTING / VERIFIED | The whole card is a link (store test `check`). |
| — | Price fixed / sale option with role | NEWLY IMPLEMENTED (FP-2) | |
| — | Size options per product type | EXISTING / VERIFIED | Sizes are per product. |
| — | Automatically show available sizes | EXISTING / VERIFIED | Sold-out sizes disabled; server re-checks stock. |
| — | Collections men / women / sale | EXISTING / VERIFIED | Collections are data; staff create them. |
| — | Customer database | EXISTING / VERIFIED | |
| — | Materials remove | EXISTING / VERIFIED | Deactivate (never delete; history kept). |
| — | Supplier dropdown on PO | EXISTING / VERIFIED | |
| — | Cart "10 items → 30 minutes → refresh" | NEWLY IMPLEMENTED (FP-11) | Clarified: no limit; 30-minute refresh. |
| — | "Product select → generate PO for customer" | CLIENT INPUT REQUIRED | Vendor PO or customer quotation? Not built; the vendor PO workflow is unchanged. |
| — | Order edit before shipment | NEWLY IMPLEMENTED (SP-3) | Staff edit; refund due for a lower total. |
| — | Exchange / returns | EXISTING (ERP module 3) | Built and off by default; policy is the business's. |
| — | "Checkout →" | EXISTING / VERIFIED | Covered by FP-4 and FP-6; online payment still depends on Razorpay keys. |

## CLIENT INPUT REQUIRED (open questions)

1. Replacement brand wording for the Japan / India lines (FP-9): what should each line say?
2. Maximum sale discount % for staff (FP-2), if any.
3. Delivery options: names, charges, delivery estimates per zone (FP-4).
4. COD: switch on? fee (per delivery rate) and/or discount, amounts, minimum / maximum order value, which zones allow it; may customers cancel a COD order themselves?
5. Loyalty: points per ₹100, when earned (paid or delivered), value of a point, minimum / maximum per order, expiry; should returns/refunds take points back automatically; what "file option" means (we built a CSV import of opening balances).
5a. Order editing: may customers edit their own orders; may staff add new products; should the customer be emailed about an edit; how to collect a higher total on an order paid online.
6. "Product select → generate PO for customer": vendor purchase order or customer quotation?
7. Retail branches: will branches sell through this ERP (a POS screen) or only hold stock? Which location ships online orders?
7a. Colour variants: which existing products come in several colours (converted manually, not automatically)?
8. Product approval: should publishing need a second person (approver role)?
