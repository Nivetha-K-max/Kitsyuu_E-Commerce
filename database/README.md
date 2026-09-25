# KITSYUU database

Supabase Postgres (project in Seoul, `ap-northeast-2`). Supabase is used only for the database and Storage.

| Path | Contents |
|---|---|
| `migrations/` | Schema migrations, applied in file-name order and tracked in `app_private.applied_migrations` |
| `seed/catalogue.sql` | Prototype catalogue seed, generated from `apps/website/data/products.json` (idempotent) |
| `setup-all.sql` | All migrations + seed in one file, for a fresh project via the Supabase SQL Editor |
| `scripts/` | Database tooling, run from the repo root |

Scripts (repo root; they read `apps/website/.env.local`):

- `npm run db:seed-gen`: regenerate `seed/catalogue.sql` and `setup-all.sql` (writes SQL only, connects nowhere)
- `npm run db:apply`: apply pending migrations, then the seed (needs `SUPABASE_DB_URL`)
- `npm run db:upload-images`: upload the catalogue images from `dist/store/images/products/` to Storage
- `npm run db:verify`: check the catalogue as the public (anon) key sees it
- `npm run db:promote-admin`: current Supabase Auth admin promotion; retired in M6

Migrations are never edited after they have been applied; changes go in a new numbered file.
