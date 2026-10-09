/* Builds the store for LOCAL use and tests (2026-10-08): `next build` with the local catalogue source, so the pages
   prerendered at build time are made from the local test database and the hosted project is never contacted.
   A normal `npm run build:website` is the production build (hosted public API) and is unchanged; a store built that way
   refuses to start with CATALOGUE_SOURCE=database.
   Needs the local test database (database/scripts/test-db.mjs --create). Usage (repo root): node apps/website/tests/build-local.mjs */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REPO, localStoreEnv, localTestDatabase} from './local-store-env.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {...process.env, ...localStoreEnv(localTestDatabase()), NODE_ENV: 'production', SITE_URL: 'http://localhost:3001',
  PAYMENT_PROVIDER: '', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '', JOBS_SECRET: '', CRON_SECRET: ''};
const run = args => spawnSync(process.execPath, args, {cwd: WEB, stdio: 'inherit', env});
let r = run([path.join(WEB, 'scripts/copy-landing.mjs')]);
if (r.status === 0) r = run([path.join(REPO, 'node_modules/next/dist/bin/next'), 'build']);
if (r.status === 0) console.log('\nlocal store build ready: catalogue and content from the local test database, pictures from dist/store/images/products.');
process.exit(r.status ?? 1);
