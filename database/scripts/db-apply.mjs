/* Applies database/migrations/*.sql (once each, tracked in app_private.applied_migrations) and then the catalogue seed.
   Server-side script: reads SUPABASE_DB_URL from apps/website/.env.local. Nothing is printed except file names and counts.
   Usage (repo root): npm run db:apply [-- <options>]
     --status              list applied / pending migrations and exit (read-only)
     --dry-run             run every pending migration inside ONE transaction, then roll it all back (nothing is kept)
     --repeat              with --dry-run: run each pending migration twice, to prove it is safe to re-run
     --no-seed             do not run seed/catalogue.sql after the migrations
     --mark-applied=a,b    record already-applied files (e.g. ones run in the SQL Editor) without running them;
                           refused unless the file's objects are verified to exist in the database
   On IPv4-only networks set SUPABASE_DB_POOLER_HOST (see lib/connection.mjs); the direct host is IPv6-only. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from './lib/connection.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // database/
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const markArg = args.find(a => a.startsWith('--mark-applied='));
const dir = path.join(ROOT, 'migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

// Objects each hand-applied migration must have created before it may be recorded as applied.
const EVIDENCE = {
  '20260925000100_schema.sql': `select to_regclass('public.products') is not null and to_regclass('public.payment_events') is not null
    and exists (select 1 from pg_type where typname = 'order_status')`,
  '20260925000200_auth_roles_rls.sql': `select exists (select 1 from pg_proc where proname = 'is_admin')
    and exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')
    and exists (select 1 from pg_policies where policyname = 'products: public read active')`,
  '20260925000300_storage.sql': `select exists (select 1 from storage.buckets where id = 'product-images')
    and exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'product-images: public read')`
};

let client;
try {
  client = await connect();
} catch (e) { console.error(e.message); process.exit(1); }

try {
  await client.query('create schema if not exists app_private; create table if not exists app_private.applied_migrations (name text primary key, applied_at timestamptz not null default now()); revoke all on schema app_private from public, anon, authenticated;');
  const done = new Set((await client.query('select name from app_private.applied_migrations')).rows.map(r => r.name));

  if (markArg) {
    for (const f of markArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (!files.includes(f)) throw new Error(`--mark-applied: ${f} is not in database/migrations`);
      if (done.has(f)) { console.log(`skip   ${f} (already recorded)`); continue; }
      if (!EVIDENCE[f]) throw new Error(`--mark-applied: no verification query for ${f}; apply it normally instead`);
      const ok = Object.values((await client.query(EVIDENCE[f])).rows[0])[0];
      if (!ok) throw new Error(`--mark-applied: ${f} is NOT present in the database; refusing to record it`);
      await client.query('insert into app_private.applied_migrations (name) values ($1)', [f]);
      done.add(f); console.log(`mark   ${f} (verified present, recorded as applied)`);
    }
  }

  const pending = files.filter(f => !done.has(f));
  if (flag('--status')) {
    for (const f of files) console.log(`${done.has(f) ? 'applied' : 'PENDING'}  ${f}`);
  } else if (flag('--dry-run')) {
    const times = flag('--repeat') ? 2 : 1;
    await client.query('begin');
    try {
      for (const f of pending) for (let i = 1; i <= times; i++) {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        console.log(`ok     ${f}${times > 1 ? ` (run ${i}/${times})` : ''}`);
      }
    } finally { await client.query('rollback'); }
    console.log(`dry run: ${pending.length} pending migration(s) ran without error; everything was rolled back`);
  } else {
    for (const f of pending) {
      await client.query('begin');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('insert into app_private.applied_migrations (name) values ($1)', [f]);
        await client.query('commit'); console.log(`apply  ${f}`);
      } catch (e) { await client.query('rollback'); throw new Error(`${f}: ${e.message}`); }
    }
    if (!pending.length) console.log('nothing to apply');
    if (!flag('--no-seed')) {
      await client.query(fs.readFileSync(path.join(ROOT, 'seed/catalogue.sql'), 'utf8')); // idempotent, own transaction
      const count = async t => Number((await client.query(`select count(*) from ${t}`)).rows[0].count);
      console.log(`seed   catalogue.sql → products ${await count('public.products')}, variants ${await count('public.product_variants')}, images ${await count('public.product_images')}, categories ${await count('public.categories')}`);
    }
  }
} catch (e) {
  console.error('FAILED:', e.message); process.exitCode = 1;
} finally { await client.end(); }
