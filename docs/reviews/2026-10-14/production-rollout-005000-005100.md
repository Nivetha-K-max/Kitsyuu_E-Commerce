# Production rollout review: migrations 005000, 005100 (and the legacy Auth retirement)

Prepared 2026-10-14 for the owner's decision. **Nothing here has been run on production.** The code is in commit `24790ae`
on `m9-integration` (not pushed, not deployed).

## 1. The exact SQL
| Migration | File | What it does |
|---|---|---|
| 005000 staff branch scope | `database/migrations/20261014005000_staff_branch_scope.sql` | Creates `public.staff_locations` (staff ↔ location, primary key on both), an index, RLS on, everything revoked from `anon`, `authenticated`, `kitsyuu_website`; policy "app admin: all rows" and `select, insert, delete` for `kitsyuu_admin`. **No existing row changes; no new permission.** |
| 005100 shipping address permission | `database/migrations/20261014005100_shipping_address_permission.sql` | Inserts permission `shipping.addresses` and grants it to `super_admin`, `admin`, `manager`, `sales`, `support`, and **provisionally** `inventory_manager`. **No existing row changes.** |
| Legacy Supabase Auth retirement | `docs/reviews/2026-10-14/legacy-auth-policies.draft.sql` (draft, proposed number 005200) | Not ready: needs its own local rehearsal and the preconditions in `legacy-auth-plan.md`. Not proposed for this rollout. |

Both 005000 and 005100 are idempotent (`if not exists`, `on conflict do nothing`) and were applied from scratch in every
isolated test database of the 2026-10-14 runs (52 migrations, all suites green).

## 2. Production checks to run first (read only)
`docs/reviews/2026-10-14/production-preflight-005000-005100.sql`: one `READ ONLY` transaction, rolled back. Validated
locally on a throwaway database (every query runs). It answers:
- **P1/P2 ledger.** `app_private.applied_migrations` on production does not list 4400–4900 (they were run in the SQL
  Editor). P2 proves their objects exist.
- **P3** that 005000/005100 have not run.
- **P4** every role, including roles made on the Roles page, with active staff counts.
- **P5 (the key one)** roles that have `shipping.read` but are not in the 005100 grant list. Their staff would stop seeing
  customer names and addresses on Shipping pages.
- **P6** the live role matrix, **P7** the locations, **P8** the privileges of the role running it.

## 3. The ledger
`db-apply` decides what is pending from the ledger. Production's ledger lacks 4400–4900, so a plain `db:apply` would try to
run them again. Options (owner's choice):
1. **Apply 005000 and 005100 alone:** `db-apply --target=production --only=20261014005000_staff_branch_scope.sql,20261014005100_shipping_address_permission.sql`
   (after `--dry-run --repeat` with the same `--only`), with `db:snapshot` before and after. They are recorded; 4400–4900
   stay unrecorded.
2. **Reconcile the ledger first:** add verification queries for 4400–4900 to `EVIDENCE` in `database/scripts/db-apply.mjs`
   (P2 is a ready basis), then `--mark-applied=…`. This is a small code change plus a ledger write, which needs approval.
3. Run them in the SQL Editor as before. The ledger falls further behind (not recommended).

The local network (phone hotspot / campus Wi-Fi) blocks the database ports; check TCP 5432/6543 before any `db-apply`.

## 4. Order of operations (important)
- **005100 must be applied before (or together with) the deploy of `24790ae`.** The new code shows addresses on Shipping
  pages only with `shipping.addresses`. If the code went live first, every role would lose addresses on those pages until
  the migration ran (orders and the order page are not affected).
- **005000 may go before or after.** Until the table exists, the code treats everyone as unrestricted (`loadLocationScope`
  ignores a missing table). But the staff page's Branches section reads the table and would fail on that page alone, so
  apply it before the deploy too.

## 5. Rollback limitations
| | How | Limits |
|---|---|---|
| 005000 | `drop table public.staff_locations;` | All branch assignments are lost. With `24790ae` still deployed, the staff page's Branches section errors; roll the code back first, or keep the table (an empty table changes nothing). |
| 005100 | `delete from role_permissions where permission_code = 'shipping.addresses'; delete from permissions where code = 'shipping.addresses';` | With `24790ae` deployed, every role then loses addresses on Shipping pages. Roll the code back first. Custom roles given the permission by hand lose it too. |
| Legacy Auth draft | `legacy-auth-rollback.sql` | Restores policies, functions and trigger. Supabase's exact original grant set may differ from "ALL"; use the preflight Q3 output to restore it exactly. If the trigger could not be dropped (not owner of `auth.users`), it was neutralised, and the rollback recreates the original function. |

## 6. Impact on existing staff roles
- **005000:** none on the day. Nobody is limited until someone with `staff.manage` assigns branches on a staff page.
  `staff.manage` holders (super admin, admin) are never limited.
- **005100:** none for the seven built-in roles; every built-in role that has `shipping.read` is granted it (matrix below).
  **Custom roles** (P4 `is_system = false`) with `shipping.read` would lose addresses on Shipping pages. P5 lists them.
- **Inventory manager** keeps addresses (provisional) until the role-matrix decision.
- **Code-only changes in `24790ae`** that need no migration but do change access on deploy:
  - Price changes need `pricing.manage`. Built-in: super admin, admin, manager, who already hold both permissions.
  - Unit costs need `costs.read`. Built-in: super admin, admin, accountant. **Managers stop seeing unit cost** in a
    location's stock history and can no longer enter one on a stock adjustment.

### Role-permission matrix (built-in roles, all migrations applied, from an isolated test database)
| Permission | accountant | admin | inventory_manager | manager | sales | super_admin | support |
|---|---|---|---|---|---|---|---|
| `shipping.read` | — | yes | yes | yes | yes | yes | yes |
| `shipping.manage` | — | yes | — | yes | yes | yes | — |
| `shipping.addresses` (005100) | — | yes | yes (provisional) | yes | yes | yes | yes |
| `orders.read` | yes | yes | — | yes | yes | yes | yes |
| `customers.read` | yes | yes | — | yes | yes | yes | yes |
| `staff.manage` | — | yes | — | — | — | yes | — |
| `inventory.transfer` | — | yes | yes | yes | — | yes | — |
| `pricing.manage` | — | yes | — | yes | — | yes | — |
| `costs.read` | yes | yes | — | — | — | yes | — |

Inventory manager is the only role that sees customer addresses **only** through Shipping: it has no `orders.read` or
`customers.read`. Taking `shipping.addresses` from it is one row (see the 005100 header).
