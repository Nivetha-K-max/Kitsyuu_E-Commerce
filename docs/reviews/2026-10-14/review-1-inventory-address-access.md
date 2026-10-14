# Review 1 — inventory_manager access to customer delivery data (read-only, 2026-10-14)

## How permissions work
* Roles + permissions are DATA: `roles`, `permissions`, `role_permissions` seeded by SQL; `packages/auth/src/rbac.ts:14-31`
  (`can`, `requirePermission`, loaded per request). Editable in the ERP by `roles.manage` (`packages/core/src/roles.ts:46-69`).
* App DB role kitsyuu_admin sees all rows (`"app admin: all rows"`); there is no per-staff-role DB enforcement. Enforcement is
  only in core functions / page checks.

## inventory_manager permissions (seeded)
`20260925000400_staff_access.sql:154-155` dashboard.read, products.read, categories.read, inventory.read, inventory.adjust, reports.read;
`…002400_procurement.sql:164` procurement.read/receive; `…002500_production_qc.sql:84` production.read, qc.record;
`…002600_stock_counts_costs.sql:67` inventory.count; `…003100_shipping.sql:126` **shipping.read**; `…004000_third_pass.sql:244` inventory.transfer.
No orders.read, customers.read, billing.read.

## Paths that reach customer PII
| # | Path | Gate | PII exposed |
|---|---|---|---|
| 1 | `apps/admin/app/(erp)/shipping/shipments/[id]/page.tsx:17,28,32,49` → `getShipmentDetail` (`packages/core/src/shipping-admin.ts:149-158`, selects `o.shipping_address` at 152) | shipping.read (page comment line 20-21 says this page exists FOR the inventory manager) | full name, line1, line2, city, state, PIN (phone is in shipping_address JSON but not rendered) |
| 2 | `apps/admin/app/(erp)/shipping/page.tsx:46-52,103` — page queries `orders.contact` DIRECTLY with `db()` (bypasses core) | shipping.read | customer name, or email if no name |
| 3 | same page `:109` + `listShipments` (`shipping-admin.ts:134-139`) | shipping.read | city + state |
| 4 | Server action `updateShipmentAction` | shipping.manage (not held) | none |
| 5 | `alerts.ts:25` shipment.failed (shipping.read) | title = order number, body = staff-typed failure reason (free text may contain address details) | low |
| 6 | Packing slip `orders/[id]/packing-slip/page.tsx:19` | orders.read — NOT reachable | — |
| 7 | Order Fulfilment tab `orders/[id]/page.tsx:86,101`, search `search.ts:20`, dashboard recent orders, production calendar customer-order tasks (`production-calendar.ts:78-79,109,146`), reports customers (`reports.ts:64`) | orders.read / customers.read — NOT reachable | — |
| 8 | Order export, segment export, finance export routes | orders.read / marketing / finance — NOT reachable | — |
Test that locks in current behaviour: `apps/admin/tests/orders.mjs:269`.

## Options (least privilege first)
A. Remove `shipping.read` from inventory_manager (Roles page, no code; or a data migration
   `delete from role_permissions …` for reproducibility on fresh DBs). Loses the Shipping queue entirely. Business decision.
B. New permission `shipping.addresses` ("See delivery name and address on shipments") — migration inserts the permission
   and grants it to the roles that hold shipping.read today EXCEPT inventory_manager (super_admin, admin, manager, sales,
   support — mirrors current access, no new rule; admin must get it because verify-platform expects admin = all but roles.manage).
   Code: getShipmentDetail returns shipping_address only with the permission (enforce in core); move the page's direct
   `orders.contact` query (shipping/page.tsx:47-52) into core behind the same check; hide "Deliver to" (shipment page :49),
   name column (:103) and optionally city/state (:109). Update test orders.mjs:269 + add a negative test.
C. Masking (code only, no migration): show order number instead of name, city/PIN only. Still exposes partial location.
D. Label-only: if inventory staff physically pack and label parcels (business question — not decided in the repo), give them
   a shipping-scoped printable label/slip route gated by `shipping.addresses` (or `shipping.label.print`) that shows the
   address only on the print view and audits each print; keep list/detail masked.
Recommendation: B (+ D if the business confirms inventory staff label parcels). Needs a migration (permission rows are seeded in the DB) plus code.
