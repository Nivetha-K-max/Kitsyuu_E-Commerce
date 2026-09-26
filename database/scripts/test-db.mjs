/* Throwaway LOCAL test database for the automated admin tests, built from the same database/migrations as Supabase
   (plus database/test/supabase-shim.sql for the Supabase-provided objects) and the catalogue seed.
   Needs TEST_PG_ADMIN_URL (a superuser connection to the LOCAL PostgreSQL, e.g. in database/.env.test.local).
   Refuses anything that is not localhost. Never touches Supabase.
     node --env-file=database/.env.test.local database/scripts/test-db.mjs --create   → prints nothing secret; writes
                                                   apps/admin/tests/.output/test.env (git-ignored)
     node --env-file=database/.env.test.local database/scripts/test-db.mjs --drop */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');          // database/
const REPO = path.join(ROOT, '..');
const NAME = 'kitsyuu_test';
const OUT = path.join(REPO, 'apps/admin/tests/.output/test.env');

const adminUrl = process.env.TEST_PG_ADMIN_URL;
if (!adminUrl) { console.error('TEST_PG_ADMIN_URL is not set (see database/README.md → Test database).'); process.exit(1); }
const admin = new URL(adminUrl);
if (!['localhost', '127.0.0.1'].includes(admin.hostname)) { console.error('TEST_PG_ADMIN_URL must point at localhost.'); process.exit(1); }
const dbUrl = db => { const u = new URL(adminUrl); u.pathname = `/${db}`; return u.toString(); };

async function run(url, fn) { const c = new pg.Client({connectionString: url}); await c.connect(); try { return await fn(c); } finally { await c.end(); } }

async function drop() {
  await run(dbUrl('postgres'), c => c.query(`drop database if exists ${NAME} with (force)`));
  fs.rmSync(OUT, {force: true});
}

async function create() {
  await drop();
  await run(dbUrl('postgres'), c => c.query(`create database ${NAME}`));
  const migrations = fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  const adminPassword = crypto.randomBytes(24).toString('base64url');
  await run(dbUrl(NAME), async c => {
    await c.query(fs.readFileSync(path.join(ROOT, 'test/supabase-shim.sql'), 'utf8'));
    for (const f of migrations) {
      await c.query('begin');
      try { await c.query(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')); await c.query('commit'); }
      catch (e) { await c.query('rollback'); throw new Error(`${f}: ${e.message}`); }
    }
    await c.query(fs.readFileSync(path.join(ROOT, 'seed/catalogue.sql'), 'utf8'));
    // Local cluster only: the app role logs in with a random password for this test run.
    await c.query(`alter role kitsyuu_admin with login password ${c.escapeLiteral(adminPassword)}`);
    const counts = (await c.query(`select (select count(*)::int from public.products) products, (select count(*)::int from public.product_variants) variants,
      (select count(*)::int from public.roles) roles, (select count(*)::int from public.permissions) permissions`)).rows[0];
    console.log(`test database ${NAME}: ${migrations.length} migrations + seed → ${JSON.stringify(counts)}`);
  });
  const appUrl = new URL(dbUrl(NAME)); appUrl.username = 'kitsyuu_admin'; appUrl.password = adminPassword;
  fs.mkdirSync(path.dirname(OUT), {recursive: true});
  fs.writeFileSync(OUT, `ADMIN_DATABASE_URL=${appUrl}\nKITSYUU_DB_URL=${dbUrl(NAME)}\n`, {mode: 0o600});
}

try {
  if (process.argv.includes('--create')) await create();
  else if (process.argv.includes('--drop')) { await drop(); console.log(`test database ${NAME} dropped`); }
  else { console.error('Use --create or --drop'); process.exitCode = 1; }
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
