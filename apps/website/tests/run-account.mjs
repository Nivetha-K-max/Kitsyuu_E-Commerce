/* M6 customer account browser tests against a throwaway LOCAL database (never the live one).
   Needs database/.env.test.local (TEST_PG_ADMIN_URL) and a production build of the website (npm run build -w @kitsyuu/website).
   Steps: fresh local DB → website on :3011 as the kitsyuu_website role (console mailer → server log, Supabase password
   check off) → tests/account.mjs → stop → drop DB. The catalogue is still read from the public Supabase API (read-only).
   Usage (repo root): npm run test:account -w @kitsyuu/website */
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(WEB, '../..');
const OUT = path.join(WEB, 'tests/.output');
const ENV_TEST = path.join(REPO, 'database/.env.test.local');
const PORT = 3011, BASE = `http://localhost:${PORT}`;
fs.mkdirSync(OUT, {recursive: true});
if (!fs.existsSync(ENV_TEST)) { console.error('Missing database/.env.test.local (TEST_PG_ADMIN_URL).'); process.exit(1); }

const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const node = (args, env = {}) => spawnSync(process.execPath, args, {cwd: REPO, encoding: 'utf8', env: {...process.env, ...env}, timeout: 900000});
const step = (label, r) => { process.stdout.write(`\n== ${label}\n${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}\n`.replace(/\n+$/, '\n')); return r.status === 0; };

let server, failed = false;
try {
  if (!step('create local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--create']))) throw new Error('could not create the test database');
  const env = readEnv(path.join(REPO, 'apps/admin/tests/.output/test.env'));
  if (!/@localhost[:/].*kitsyuu_test/.test(env.WEBSITE_DATABASE_URL) || !/kitsyuu_website/.test(env.WEBSITE_DATABASE_URL)) throw new Error('refusing: not the local website role');
  const website = fs.existsSync(path.join(WEB, '.env.local')) ? readEnv(path.join(WEB, '.env.local')) : {};
  const log = path.join(OUT, 'account-server.log'); fs.writeFileSync(log, '');
  const logFd = fs.openSync(log, 'a');
  // Explicit values win over .env.local: every customer-data setting here is local; only the public catalogue settings are reused.
  server = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT)], {cwd: WEB, stdio: ['ignore', logFd, logFd],
    env: {...process.env, NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: website.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: website.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      WEBSITE_DATABASE_URL: env.WEBSITE_DATABASE_URL, SITE_URL: BASE, MAILER: 'console', LEGACY_SUPABASE_AUTH: 'off'}});
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/login')).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  if (!step('customer account browser tests', node([process.env.ACCOUNT_TEST || 'apps/website/tests/account.mjs'], {BASE, SERVER_LOG: log, KITSYUU_DB_URL: env.KITSYUU_DB_URL}))) failed = true;
} catch (e) {
  console.error('ERROR:', e.message); failed = true;
} finally {
  server?.kill();
  await new Promise(r => setTimeout(r, 500));
  step('drop local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--drop']));
}
process.exitCode = failed ? 1 : 0;
