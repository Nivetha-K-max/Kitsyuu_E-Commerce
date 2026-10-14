# Reviews, 2026-10-14

Read-only reviews made while hardening access control. **Nothing in this folder has been run against any database.**
The SQL files are review material, kept outside `database/migrations/` on purpose so no migration tool picks them up.

| File | What it is |
|---|---|
| `review-1-inventory-address-access.md` | Where the inventory manager reaches customer names and delivery addresses, and the options. Option B (a separate address permission) is being built; see the migration list below. |
| `review-2-pre-hijack.md` | Sign-up account-takeover ("pre-hijack") paths S1 and S2, and the proposed design. |
| `legacy-auth-plan.md` | Inventory of the Supabase-Auth-era RLS policies, functions, trigger and grants; preconditions, ordered steps, test steps. |
| `legacy-auth-policies.draft.sql` | DRAFT migration retiring them. Not applied anywhere and not rehearsed yet. |
| `legacy-auth-preflight.sql` | Read-only validation checks (Q1–Q8), wrapped in a read-only transaction. Run before and after. |
| `legacy-auth-rollback.sql` | Undo script restoring the original policies, functions, trigger and grants. |
| `production-rollout-005000-005100.md` | Rollout review for migrations 005000 and 005100: exact SQL, ledger options, order of operations, rollback limits, impact on staff roles, role-permission matrix. |
| `production-preflight-005000-005100.sql` | Read-only production checks for that rollout (validated on a throwaway local database). |

Any production use needs the owner's explicit approval.
