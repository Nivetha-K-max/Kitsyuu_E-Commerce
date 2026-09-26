/* Runs every admin test against throwaway LOCAL databases; Supabase is never touched.
   Needs database/.env.test.local with TEST_PG_ADMIN_URL (local PostgreSQL superuser) and a production build
   (npm run build -w @kitsyuu/admin).
   Steps: for each core test file: fresh DB → baseline check → tests → baseline check.
          Then: fresh DB → baseline check → admin server on :3003 → bootstrap staff with the create-staff script →
          staff/roles/auth browser tests → product/price/stock browser tests → baseline check → stop server → drop DB.
   Usage (repo root): npm run test:admin */
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const ADMIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ADMIN, '../..');
const OUT = path.join(ADMIN, 'tests/.output');
const ENV_TEST = path.join(REPO, 'database/.env.test.local');
const PORT = 3003, BASE = `http://localhost:${PORT}`;
fs.mkdirSync(OUT, {recursive: true});
if (!fs.existsSync(ENV_TEST)) { console.error('Missing database/.env.test.local (TEST_PG_ADMIN_URL). See database/README.md → Test database.'); process.exit(1); }

const node = (args, env = {}) => spawnSync(process.execPath, args, {cwd: REPO, encoding: 'utf8', env: {...process.env, ...env}, timeout: 900000});
const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const step = (label, r) => { process.stdout.write(`\n== ${label}\n${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}\n`.replace(/\n+$/, '\n')); return r.status === 0; };
const createDb = () => step('create local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--create']));
const dropDb = () => step('drop local test database', node(['--env-file=' + ENV_TEST, 'database/scripts/test-db.mjs', '--drop']));

/** Database safety check (owner connection to the LOCAL test DB): catalogue intact, no unexpected rows, and stock
    always equals the sum of its ledger rows. Defaults are the untouched baseline; order suites pass their fixture counts. */
async function dbCheck(label, env, {staff, orders = 0, customers = 0, units = 1100, everySizeTen = units === 1100, products = 22, variants = 110, images = 22} = {}) {
  const c = new pg.Client({connectionString: env.KITSYUU_DB_URL}); await c.connect();
  try {
    const r = (await c.query(`select (select count(*)::int from products) products, (select count(*)::int from product_variants) variants,
      (select count(*)::int from product_images) images, (select coalesce(sum(stock_qty),0)::int from product_variants) units,
      (select count(*)::int from product_variants where stock_qty <> 10) not_ten, (select count(*)::int from products where status <> 'active') inactive,
      (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)) ledger_mismatch,
      (select count(*)::int from orders) orders, (select count(*)::int from customers) customers, (select count(*)::int from staff_users) staff`)).rows[0];
    const ok = r.products === products && r.variants === variants && r.images === images && r.units === units && (!everySizeTen || r.not_ten === 0) && r.inactive === 0
      && r.ledger_mismatch === 0 && r.orders === orders && r.customers === customers && (staff === undefined || r.staff === staff);
    console.log(`\n== database check (${label}): ${ok ? 'OK' : 'UNEXPECTED'} ${JSON.stringify(r)}`);
    return ok;
  } finally { await c.end(); }
}

let failed = false, server;
try {
  // ---------- core integration tests: one fresh database per file (no shared state between files) ----------
  const coreDir = path.join(REPO, 'packages/core/test');
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.test.mjs')).sort();
  if (!coreFiles.length) throw new Error('no core test files found');
  for (const f of coreFiles) {
    if (!createDb()) throw new Error('could not create the test database');
    const env = readEnv(path.join(OUT, 'test.env'));
    if (!(await dbCheck(`before ${f}`, env, {staff: 0}))) failed = true;
    // Explicit file path: `node --test <directory>` is not supported by this Node version.
    const r = node(['--test', '--test-concurrency=1', '--test-reporter=spec', path.join('packages/core/test', f)], env);
    if (!step(`core integration tests: ${f}`, r)) failed = true;
    // orders.test.mjs loads 8 fixture orders (2 customers, 11 units taken) and then cancels two unpaid ones (+3 back).
    // orders.test.mjs: 8 fixture orders (2 customers, 11 units taken), then two unpaid ones cancelled (+3 back).
    // m4-catalogue.test.mjs: creates 1 product with 2 sizes (+5 units restocked) and keeps 2 of its 3 uploaded images.
    const expect = f === 'orders.test.mjs' ? {orders: 8, customers: 2, units: 1100 - 11 + 3}
      : f === 'm4-catalogue.test.mjs' ? {products: 23, variants: 112, images: 24, units: 1105} : {};
    if (!(await dbCheck(`after ${f}`, env, expect))) failed = true;
  }

  // ---------- browser tests against one server ----------
  if (!createDb()) throw new Error('could not recreate the test database');
  const env = readEnv(path.join(OUT, 'test.env'));
  if (!(await dbCheck('before browser tests', env, {staff: 0}))) failed = true;
  const website = fs.existsSync(path.join(REPO, 'apps/website/.env.local')) ? readEnv(path.join(REPO, 'apps/website/.env.local')) : {};
  // Product images are read from the existing PUBLIC product-images bucket (the same public URLs the store uses).
  const imageBase = website.NEXT_PUBLIC_SUPABASE_URL ? `${website.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-images` : '';
  const log = path.join(OUT, 'server.log'); fs.writeFileSync(log, '');
  const storageDir = path.join(OUT, 'storage'); fs.rmSync(storageDir, {recursive: true, force: true}); fs.mkdirSync(storageDir, {recursive: true});
  const logFd = fs.openSync(log, 'a');
  server = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT)],
    {cwd: ADMIN, env: {...process.env, ADMIN_DATABASE_URL: env.ADMIN_DATABASE_URL, ADMIN_APP_URL: BASE, MAILER: 'console', NODE_ENV: 'production', PRODUCT_IMAGE_BASE_URL: imageBase,
        STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: storageDir},   // uploads go to a local folder, never the live bucket
      stdio: ['ignore', logFd, logFd]});
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/login')).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }

  const invitesDir = path.join(REPO, 'database/.local/invites');
  const invite = (email, role) => {
    const before = new Set(fs.existsSync(invitesDir) ? fs.readdirSync(invitesDir) : []);
    const r = node(['database/scripts/create-staff.mjs', `--email=${email}`, `--role=${role}`], {KITSYUU_DB_URL: env.KITSYUU_DB_URL, ADMIN_APP_URL: BASE});
    if (!step(`bootstrap ${role} (create-staff script, local test DB)`, r)) throw new Error('create-staff failed');
    return path.join(invitesDir, fs.readdirSync(invitesDir).find(f => !before.has(f)));
  };
  const invites = [];
  try {
    invites.push(invite('root.e2e@test.local', 'super_admin'));
    const e2e = node(['apps/admin/tests/admin.mjs'], {BASE, SERVER_LOG: log, INVITE_FILE: invites[0], KITSYUU_DB_URL: env.KITSYUU_DB_URL, ADMIN_DATABASE_URL: env.ADMIN_DATABASE_URL});
    if (!step('admin browser tests (staff, roles, auth, audit)', e2e)) failed = true;

    const accounts = {root: ['prod.root@test.local', 'super_admin'], inventory: ['prod.inventory@test.local', 'inventory_manager'],
      support: ['prod.support@test.local', 'support'], accountant: ['prod.accounts@test.local', 'accountant']};
    const files = Object.fromEntries(Object.entries(accounts).map(([k, [email, role]]) => { const f = invite(email, role); invites.push(f); return [k, f]; }));
    const prod = node(['apps/admin/tests/products.mjs'], {BASE, KITSYUU_DB_URL: env.KITSYUU_DB_URL, ADMIN_DATABASE_URL: env.ADMIN_DATABASE_URL, INVITES: JSON.stringify(files)});
    if (!step('product / price / stock browser tests', prod)) failed = true;
    // Staff so far: root + support invited through the UI (admin.mjs) + the 4 product-test accounts.
    if (!(await dbCheck('after product browser tests', env, {staff: 6}))) failed = true;

    // ---------- orders: fixtures (local only), then browser tests ----------
    if (!step('load order fixtures (local test DB)', node(['database/test/order-fixtures.mjs'], {KITSYUU_DB_URL: env.KITSYUU_DB_URL}))) throw new Error('order fixtures failed');
    const orderAccounts = {sales: ['ord.sales@test.local', 'sales'], support: ['ord.support@test.local', 'support'],
      accountant: ['ord.accounts@test.local', 'accountant'], inventory: ['ord.inventory@test.local', 'inventory_manager']};
    const orderFiles = Object.fromEntries(Object.entries(orderAccounts).map(([k, [email, role]]) => { const f = invite(email, role); invites.push(f); return [k, f]; }));
    const ord = node(['apps/admin/tests/orders.mjs'], {BASE, KITSYUU_DB_URL: env.KITSYUU_DB_URL, INVITES: JSON.stringify(orderFiles)});
    if (!step('order browser tests', ord)) failed = true;

    // ---------- M4: product creation, sizes, images, categories, New Arrivals ----------
    const m4Accounts = {root: ['m4.root@test.local', 'super_admin'], support: ['m4.support@test.local', 'support'], inventory: ['m4.inventory@test.local', 'inventory_manager']};
    const m4Files = Object.fromEntries(Object.entries(m4Accounts).map(([k, [email, role]]) => { const f = invite(email, role); invites.push(f); return [k, f]; }));
    const m4 = node(['apps/admin/tests/catalogue.mjs'], {BASE, KITSYUU_DB_URL: env.KITSYUU_DB_URL, INVITES: JSON.stringify(m4Files), STORAGE_DIR: storageDir, OUT_DIR: OUT});
    if (!step('M4 catalogue browser tests', m4)) failed = true;
  } finally { for (const f of invites) fs.rmSync(f, {force: true}); }
  // Order browser tests cancel two unpaid orders (+3 units back) on top of the fixtures (11 units taken);
  // M4 browser tests create 1 product with 1 size (+6 restocked) and keep 1 of its 2 uploaded images.
  if (!(await dbCheck('after all browser tests', env, {orders: 8, customers: 2, units: 1100 - 11 + 3 + 6, products: 23, variants: 111, images: 23}))) failed = true;
} catch (e) {
  console.error('ERROR:', e.message); failed = true;
} finally {
  server?.kill();
  await new Promise(r => setTimeout(r, 500));
  dropDb();
}
process.exitCode = failed ? 1 : 0;
