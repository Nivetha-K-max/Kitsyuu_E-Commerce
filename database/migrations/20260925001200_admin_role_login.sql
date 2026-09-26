-- KITSYUU platform M3: allow the Admin/ERP app's database role to log in (additive only).
-- No password is set here: a LOGIN role without a password cannot authenticate, so this migration alone grants no access.
-- The password is set by database/scripts/app-role.mjs from a value generated locally, sent to Postgres only as a
-- SCRAM-SHA-256 verifier, and written only to the app's git-ignored .env.local. It is never stored in a migration.
-- The connection limit keeps a misbehaving deployment from exhausting the database's connections.
-- kitsyuu_website stays NOLOGIN until the website moves to its own database role (M6).
-- Safe to re-run.

alter role kitsyuu_admin with login connection limit 20;
