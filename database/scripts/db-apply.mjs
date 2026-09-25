/* Applies database/migrations/*.sql (once each, tracked in app_private.applied_migrations) and then the catalogue seed.
   Server-side script: reads SUPABASE_DB_URL from apps/website/.env.local. Nothing is printed except file names and counts.
   Usage (repo root): npm run db:apply   (equivalent: node --env-file=apps/website/.env.local database/scripts/db-apply.mjs)
   Use the Session pooler connection string if your network has no IPv6 route to db.<ref>.supabase.co. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // database/
const url = process.env.SUPABASE_DB_URL;
if (!url || /REPLACE_WITH|\[YOUR-PASSWORD\]/.test(url)) { console.error('SUPABASE_DB_URL is not set in .env.local'); process.exit(1); }

const client = new pg.Client({connectionString: url, ssl: {rejectUnauthorized: false}, connectionTimeoutMillis: 15000});
try {
  await client.connect();
} catch (e) {
  console.error(`Could not connect to the database (${e.code || e.message}).`);
  if (['ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code)) console.error('Tip: use the Session pooler connection string (Supabase → Connect → Session pooler); the direct host is IPv6-only.');
  process.exit(1);
}
try {
  await client.query('create schema if not exists app_private; create table if not exists app_private.applied_migrations (name text primary key, applied_at timestamptz not null default now()); revoke all on schema app_private from public;');
  const done = new Set((await client.query('select name from app_private.applied_migrations')).rows.map(r => r.name));
  const dir = path.join(ROOT, 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) { console.log(`skip   ${f} (already applied)`); continue; }
    await client.query('begin');
    try {
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('insert into app_private.applied_migrations (name) values ($1)', [f]);
      await client.query('commit'); console.log(`apply  ${f}`);
    } catch (e) { await client.query('rollback'); throw new Error(`${f}: ${e.message}`); }
  }
  await client.query(fs.readFileSync(path.join(ROOT, 'seed/catalogue.sql'), 'utf8')); // idempotent, own transaction
  const count = async t => Number((await client.query(`select count(*) from ${t}`)).rows[0].count);
  console.log(`seed   catalogue.sql → products ${await count('public.products')}, variants ${await count('public.product_variants')}, images ${await count('public.product_images')}, categories ${await count('public.categories')}`);
} catch (e) {
  console.error('FAILED:', e.message); process.exitCode = 1;
} finally { await client.end(); }
