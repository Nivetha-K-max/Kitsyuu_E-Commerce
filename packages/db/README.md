# @kitsyuu/db

Server-only database access for the KITSYUU apps: Kysely over node-postgres, the typed schema (`src/schema.ts`) and the audit writer (`recordAudit`, always called inside the transaction of the change it records).

Each app connects with its own database role (`kitsyuu_website`, `kitsyuu_admin`) through the Supabase pooler; local test databases connect without TLS. Browser code must never import this package (it throws if it is loaded in a browser).
