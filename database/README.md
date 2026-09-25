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

Safe order for a new migration: `--dry-run --repeat` → `db:snapshot` → apply with `--no-seed` → `db:snapshot` + `--compare` → verify.

## Conventions

- Migrations are never edited after they have been applied; changes go in a new numbered file.
- Migrations are written to be safe to re-run (`if not exists`, `on conflict do nothing`, guarded `do` blocks).
- Every new table enables RLS and revokes `anon` / `authenticated` explicitly. Supabase's default privileges would
  otherwise grant the public API full access to new tables, views and functions.
- Money is integer paise. Existing catalogue ids (`ky-proto-001`, `tops.hoodies`) are stable; new tables use UUID or
  identity keys.
- Stock changes only through `public.adjust_stock()`. A trigger rejects direct changes to `product_variants.stock_qty`.
- `audit_logs` is append-only: no role has UPDATE/DELETE/TRUNCATE, and a trigger blocks them for everyone.
- App database roles `kitsyuu_website` and `kitsyuu_admin` exist as NOLOGIN. Login is enabled in M3 with a password from
  the environment, never from a migration.
