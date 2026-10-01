/* Starts the production build of the store on :3021 against a throwaway LOCAL database (the same settings as
   tests/run-account.mjs: customer data, carts and payments local; the public catalogue read from the Supabase API,
   read-only), runs tests/perf.mjs and stops. Usage (repo root): node apps/website/tests/run-perf.mjs <label> */
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(WEB, '../..');
const OUT = path.join(WEB, 'tests/.output');
const ENV_TEST = path.join(REPO, 'database/.env.test.local');
const PORT = 3021, BASE = `http://localhost:${PORT}`;
const label = process.argv[2] || 'run';
const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const node = args => spawnSync(process.execPath, args, {cwd: REPO, encoding: 'utf8', timeout: 900000});

let server, code = 1;
try {
  const c = node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--create']);
  if (c.status !== 0) throw new Error('could not create the test database: ' + c.stdout + c.stderr);
  const env = readEnv(path.join(REPO, 'apps/admin/tests/.output/test.env'));
  if (!/@localhost[:/].*kitsyuu_test/.test(env.WEBSITE_DATABASE_URL)) throw new Error('refusing: not the local test database');
  const website = readEnv(path.join(WEB, '.env.local'));
  const log = fs.openSync(path.join(OUT, `perf-server-${label}.log`), 'w');
  server = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT)], {cwd: WEB, stdio: ['ignore', log, log], env: {
    ...process.env, NODE_ENV: 'production', SITE_URL: BASE,
    NEXT_PUBLIC_SUPABASE_URL: website.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: website.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    WEBSITE_DATABASE_URL: env.WEBSITE_DATABASE_URL, MAILER: 'console', LEGACY_SUPABASE_AUTH: 'off',
    PAYMENT_PROVIDER: 'test', PAYMENTS_ALLOW_TEST_PROVIDER: 'on', PAYMENTS_TEST_SECRET: randomBytes(32).toString('hex'),
    RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '', JOBS_SECRET: '', CRON_SECRET: '', RESEND_API_KEY: '', SUPABASE_SERVICE_ROLE_KEY: ''}});
  for (let i = 0; i < 150; i++) { try { if ((await fetch(BASE + '/')).status < 500) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  // Warm the server once (first requests compile caches); measurements are browser-cold, not server-cold.
  for (const p of ['/', '/search?q=shirt', '/cart', '/checkout']) await fetch(BASE + p).catch(() => {});
  const r = await new Promise(res => { const p = spawn(process.execPath, [path.join(WEB, 'tests/perf.mjs'), label], {cwd: REPO, stdio: 'inherit', env: {...process.env, BASE}}); p.on('close', res); });
  code = r;
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  server?.kill();
  await new Promise(r => setTimeout(r, 500));
  node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--drop']);
  process.exitCode = code;
}
