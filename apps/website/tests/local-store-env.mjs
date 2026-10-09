/* The environment of a LOCAL / TEST store (2026-10-08): the public catalogue and content come from the local test database
   and product pictures from the repository's own files, so no build, test run or load run contacts the hosted project.
   Every hosted-project variable is blanked explicitly: an explicit (even empty) value wins over anything in a local env
   file, so nothing can leak in from apps/website/.env.local. Used by build-local.mjs and by every runner that starts the store. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.join(WEB, '../..');
export const TEST_ENV_FILE = path.join(REPO, 'apps/admin/tests/.output/test.env');
const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));

/** Hosted-project variables, all blank. */
export const NO_HOSTED_PROJECT = {NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_DB_URL: ''};

/** The local test database URLs written by database/scripts/test-db.mjs; refuses anything that is not local kitsyuu_test. */
export function localTestDatabase() {
  if (!fs.existsSync(TEST_ENV_FILE)) throw new Error('apps/admin/tests/.output/test.env is missing: create the local test database first (database/scripts/test-db.mjs --create).');
  const env = readEnv(TEST_ENV_FILE);
  for (const [name, role] of [['WEBSITE_DATABASE_URL', 'kitsyuu_website'], ['ADMIN_DATABASE_URL', 'kitsyuu_admin'], ['KITSYUU_DB_URL', null]]) {
    let u; try { u = new URL(env[name] ?? ''); } catch { throw new Error(`refusing: ${name} is missing or not a database URL`); }
    if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.pathname !== '/kitsyuu_test') throw new Error(`refusing: ${name} is not the local test database`);
    if (role && decodeURIComponent(u.username) !== role) throw new Error(`refusing: ${name} does not use the ${role} role`);
  }
  return env;
}

/** Environment for building or starting the store locally. `env` = localTestDatabase(). */
export function localStoreEnv(env) {
  return {...NO_HOSTED_PROJECT, CATALOGUE_SOURCE: 'database', WEBSITE_DATABASE_URL: env.WEBSITE_DATABASE_URL, LEGACY_SUPABASE_AUTH: 'off', MAILER: 'console',
    RESEND_API_KEY: '', VERCEL: '', KITSYUU_DEPLOYMENT: ''};
}
