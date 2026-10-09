/* Starts the store (:3001) and the admin (:3002) for LOCAL review (2026-10-08), entirely on this machine:
   the local test database for everything (customers, orders AND the public catalogue and content), product pictures from
   the repository's own files, emails written to a folder, no payment provider, no hosted project.
   Needs: the local test database (apps/admin/tests/.output/test.env), a local build of the store
   (node apps/website/tests/build-local.mjs) and a build of the admin (npm run build:admin).
   Usage (repo root): node apps/admin/tests/serve-local.mjs */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {REPO, NO_HOSTED_PROJECT, localStoreEnv, localTestDatabase} from '../../website/tests/local-store-env.mjs';

const env = localTestDatabase();                                   // refuses anything but the local kitsyuu_test database
const out = path.join(REPO, 'apps/admin/tests/.output');
const outbox = path.join(out, 'outbox'); fs.mkdirSync(outbox, {recursive: true});
const storage = path.join(out, 'storage-demo'); fs.mkdirSync(storage, {recursive: true});
// The catalogue's own pictures, for the admin's /media route (uploads made during the review go to the same folder).
fs.cpSync(path.join(REPO, 'dist/store/images/products'), path.join(storage, 'products'), {recursive: true, force: false});
// Everything that could reach a real service is set explicitly (an explicit value wins over a local env file).
const safe = {...process.env, ...NO_HOSTED_PROJECT, NODE_ENV: 'production', MAILER: 'file', MAIL_OUTBOX_DIR: outbox, RESEND_API_KEY: '', MAIL_FROM: '', PAYMENT_PROVIDER: '',
  RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '', CRON_SECRET: '', JOBS_SECRET: '', VERCEL: '', KITSYUU_DEPLOYMENT: ''};
const start = (app, port, extra) => {
  const log = fs.openSync(path.join(out, `server-${port}.log`), 'w');
  const p = spawn(process.execPath, [path.join(REPO, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port)], {cwd: path.join(REPO, 'apps', app), detached: true, stdio: ['ignore', log, log], env: {...safe, ...extra}});
  p.unref(); return p.pid;
};
const pids = {
  store: start('website', 3001, {...localStoreEnv(env), MAILER: 'file', SITE_URL: 'http://localhost:3001'}),
  admin: start('admin', 3002, {ADMIN_DATABASE_URL: env.ADMIN_DATABASE_URL, ADMIN_APP_URL: 'http://localhost:3002', STORE_URL: 'http://localhost:3001', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: storage, PRODUCT_IMAGE_BASE_URL: ''}),
};
const up = async url => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).status < 500) return true; } catch {} await new Promise(r => setTimeout(r, 300)); } return false; };
console.log(`store  http://localhost:3001  ${await up('http://localhost:3001/login') ? 'ready' : 'DID NOT START'} (pid ${pids.store})`);
console.log(`admin  http://localhost:3002  ${await up('http://localhost:3002/login') ? 'ready' : 'DID NOT START'} (pid ${pids.admin})`);
console.log(`database: local kitsyuu_test · catalogue and pictures: local · emails are written to ${outbox} (nothing is sent)`);
process.exit(0);
