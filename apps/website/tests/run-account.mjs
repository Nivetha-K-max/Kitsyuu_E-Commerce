/* M6 customer account + M7 commerce browser tests against a throwaway LOCAL database (never the live one).
   Needs database/.env.test.local (TEST_PG_ADMIN_URL) and a production build of the website (npm run build -w @kitsyuu/website).
   Steps: fresh local DB → a local fake Razorpay → three website instances (next start) on the same local DB, all as the
   kitsyuu_website role, console mailer (emails → server log), Supabase password check off:
     :3011  PAYMENT_PROVIDER=test      (main store)
     :3013  PAYMENT_PROVIDER=razorpay  (the Razorpay adapter against the fake Razorpay: real widget flow, no network)
     :3014  database unreachable       (failure states)
     :3015  PAYMENT_PROVIDER=test WITHOUT PAYMENTS_ALLOW_TEST_PROVIDER (must be refused in production: payment off)
     :3016  PAYMENT_PROVIDER unset     (the default: payment off)
   → tests/account.mjs → tests/commerce.mjs → stop → drop DB. The catalogue is still read from the public Supabase API (read-only).
   Usage (repo root): npm run test:account -w @kitsyuu/website   (ONLY=account|commerce runs one file) */
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startFakeRazorpay, TEST_KEY_ID} from '../../../packages/core/test/fake-razorpay.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(WEB, '../..');
const OUT = path.join(WEB, 'tests/.output');
const ENV_TEST = path.join(REPO, 'database/.env.test.local');
const PORT = 3011, BASE = `http://localhost:${PORT}`, RZP_BASE = 'http://localhost:3013', DOWN_BASE = 'http://localhost:3014';
fs.mkdirSync(OUT, {recursive: true});
if (!fs.existsSync(ENV_TEST)) { console.error('Missing database/.env.test.local (TEST_PG_ADMIN_URL).'); process.exit(1); }

const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const node = (args, env = {}) => spawnSync(process.execPath, args, {cwd: REPO, encoding: 'utf8', env: {...process.env, ...env}, timeout: 900000});
/** Like node() but without blocking this process: the fake Razorpay runs here and must keep answering during the tests. */
const nodeAsync = (args, env = {}) => new Promise(resolve => {
  const c = spawn(process.execPath, args, {cwd: REPO, env: {...process.env, ...env}});
  let stdout = '', stderr = '';
  c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
  const t = setTimeout(() => c.kill(), 900000);
  c.on('close', status => { clearTimeout(t); resolve({status, stdout, stderr}); });
});
const step = (label, r) => { process.stdout.write(`\n== ${label}\n${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}\n`.replace(/\n+$/, '\n')); return r.status === 0; };

const servers = [];
let rzp, failed = false;
async function startServer(port, logName, env) {
  const log = path.join(OUT, logName); fs.writeFileSync(log, '');
  const fd = fs.openSync(log, 'a');
  servers.push(spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port)], {cwd: WEB, stdio: ['ignore', fd, fd], env}));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}/login`)).status < 500) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  return log;
}
try {
  if (!step('create local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--create']))) throw new Error('could not create the test database');
  const env = readEnv(path.join(REPO, 'apps/admin/tests/.output/test.env'));
  if (!/@localhost[:/].*kitsyuu_test/.test(env.WEBSITE_DATABASE_URL) || !/kitsyuu_website/.test(env.WEBSITE_DATABASE_URL)) throw new Error('refusing: not the local website role');
  const website = fs.existsSync(path.join(WEB, '.env.local')) ? readEnv(path.join(WEB, '.env.local')) : {};
  const keySecret = randomBytes(16).toString('hex'), webhookSecret = randomBytes(16).toString('hex');
  rzp = await startFakeRazorpay({keySecret, webhookSecret});
  // Explicit values win over .env.local: every customer-data and payment setting here is local; only the public catalogue settings are reused.
  const base = {...process.env, NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: website.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: website.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    WEBSITE_DATABASE_URL: env.WEBSITE_DATABASE_URL, MAILER: 'console', LEGACY_SUPABASE_AUTH: 'off',
    PAYMENT_PROVIDER: '', PAYMENTS_ALLOW_TEST_PROVIDER: '', PAYMENTS_TEST_SECRET: '',
    RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '', JOBS_SECRET: ''};
  const log = await startServer(PORT, 'account-server.log', {...base, SITE_URL: BASE,
    PAYMENT_PROVIDER: 'test', PAYMENTS_ALLOW_TEST_PROVIDER: 'on', PAYMENTS_TEST_SECRET: randomBytes(32).toString('hex')});
  const rzpLog = await startServer(3013, 'razorpay-server.log', {...base, SITE_URL: RZP_BASE, PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: keySecret, RAZORPAY_WEBHOOK_SECRET: webhookSecret,
    RAZORPAY_API_BASE: rzp.url, RAZORPAY_CHECKOUT_URL: `${rzp.url}/v1/checkout.js`});
  await startServer(3014, 'db-down-server.log', {...base, SITE_URL: DOWN_BASE, PAYMENT_PROVIDER: 'test', PAYMENTS_ALLOW_TEST_PROVIDER: 'on',
    WEBSITE_DATABASE_URL: env.WEBSITE_DATABASE_URL.replace(/@localhost:\d+\//, '@localhost:1/')});
  const refusedLog = await startServer(3015, 'test-refused-server.log', {...base, SITE_URL: 'http://localhost:3015', PAYMENT_PROVIDER: 'test'});
  await startServer(3016, 'no-provider-server.log', {...base, SITE_URL: 'http://localhost:3016'});
  const testEnv = {TEST_REFUSED_BASE: 'http://localhost:3015', NO_PROVIDER_BASE: 'http://localhost:3016', TEST_REFUSED_LOG: refusedLog,
    BASE, RZP_BASE, DOWN_BASE, FAKE_RZP_URL: rzp.url, RZP_WEBHOOK_SECRET: webhookSecret, SERVER_LOG: log, RZP_SERVER_LOG: rzpLog, KITSYUU_DB_URL: env.KITSYUU_DB_URL};
  for (const f of ['account', 'commerce']) {
    if (process.env.ONLY && process.env.ONLY !== f) continue;
    if (!step(`${f} browser tests`, await nodeAsync([`apps/website/tests/${f}.mjs`], testEnv))) failed = true;
  }
} catch (e) {
  console.error('ERROR:', e.message); failed = true;
} finally {
  for (const s of servers) s.kill();
  await rzp?.close();
  await new Promise(r => setTimeout(r, 500));
  step('drop local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--drop']));
}
process.exitCode = failed ? 1 : 0;
