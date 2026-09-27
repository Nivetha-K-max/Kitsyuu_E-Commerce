-- KITSYUU platform M6: allow the customer website's database role to log in (additive only).
-- No password is set here: a LOGIN role without a password cannot authenticate, so this migration alone grants no access.
-- The password is set by database/scripts/app-role.mjs from a value generated locally, sent to Postgres only as a
-- SCRAM-SHA-256 verifier, and written only to the website's git-ignored .env.local. It is never stored in a migration.
-- The connection limit keeps a misbehaving deployment from exhausting the database's connections.
-- Safe to re-run.

alter role kitsyuu_website with login connection limit 30;
