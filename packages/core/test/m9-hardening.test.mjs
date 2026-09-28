/* M9 hardening: health check, checkout rate limit, System page status (system.read), sign-in history (audit.read), and
   migration 002000 (permission + setting). LOCAL test database only. Leaves the catalogue and stock untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError} from '@kitsyuu/contracts';
import {checkoutRateLimit, getSystemStatus, listSignIns, pingDatabase} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm9.test', requestId: 'test'};
const runtime = {app: 'admin', version: 'test', node: process.version, environment: 'test', config: {'Email (MAILER)': 'console'}};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm9 test passphrase ok', fullName: role}, ctx)).token);
}

let root, manager, support;

test('migration 002000: system.read for super_admin and admin only; checkout limit setting present', async () => {
  const holders = (await q(`select r.code from role_permissions rp join roles r on r.id = rp.role_id where rp.permission_code = 'system.read' order by 1`)).map(r => r.code);
  assert.deepEqual(holders, ['admin', 'super_admin']);
  assert.deepEqual(await q(`select value from settings where key = 'security.checkout_orders_per_hour'`), [{value: 10}]);
  root = await staff('m9.root@test.local', 'super_admin');
  manager = await staff('m9.manager@test.local', 'manager');     // audit.read, no system.read
  support = await staff('m9.support@test.local', 'support');     // neither
});

test('health check: database up with latency; a broken connection reports down without throwing', async () => {
  const up = await pingDatabase(db);
  assert.equal(up.ok, true); assert.ok(up.latencyMs >= 0); assert.ok(Date.parse(up.dbTime) > 0);
  const broken = createDb({connectionString: 'postgresql://nobody:wrong@127.0.0.1:1/none', max: 1});
  assert.deepEqual(await pingDatabase(broken), {ok: false, latencyMs: null, dbTime: null});
  await broken.destroy().catch(() => {});
});

test('checkout rate limit: counts only this customer\'s orders in the last hour, uses the setting', async () => {
  const [c1] = await q(`insert into customers (email, full_name, status) values ('m9.rate@test.local', 'Rate', 'active') returning id`);
  const [c2] = await q(`insert into customers (email, full_name, status) values ('m9.other@test.local', 'Other', 'active') returning id`);
  let batch = 0;
  const addOrders = (cid, n, age = '0 minutes') => q(`insert into orders (order_number, customer_id, status, subtotal_paise, total_paise, created_at)
    select 'KTS-M9-' || $1::text || '-' || g, $2, 'cancelled', 100, 100, now() - $3::interval from generate_series(1, $4) g`, [String(++batch), cid, age, n]);
  assert.deepEqual(await checkoutRateLimit(db, c1.id), {allowed: true, limit: 10});
  await addOrders(c1.id, 9, '10 minutes');
  await addOrders(c1.id, 5, '2 hours');                 // older than an hour: not counted
  await addOrders(c2.id, 10, '1 minute');               // another customer: not counted
  assert.equal((await checkoutRateLimit(db, c1.id)).allowed, true);
  await addOrders(c1.id, 1, '1 minute');
  assert.deepEqual(await checkoutRateLimit(db, c1.id), {allowed: false, limit: 10});
  await q(`update settings set value = '20' where key = 'security.checkout_orders_per_hour'`);
  assert.deepEqual(await checkoutRateLimit(db, c1.id), {allowed: true, limit: 20});
  await q(`update settings set value = '10' where key = 'security.checkout_orders_per_hour'`);
  await q(`delete from orders where order_number like 'KTS-M9-%'`);
  await q(`delete from customers where email like 'm9.%@test.local'`);
});

test('System status needs system.read; reports database, runtime and 24h sign-in counts without secrets', async () => {
  await assert.rejects(getSystemStatus(db, manager, runtime), ForbiddenError);
  await assert.rejects(getSystemStatus(db, support, runtime), ForbiddenError);
  await q(`insert into auth_attempts (realm, email, ip, succeeded, failure_reason) values
    ('staff', 'm9.root@test.local', '10.0.0.1', true, null), ('staff', 'm9.root@test.local', '10.0.0.1', false, 'bad_password'),
    ('staff', 'm9.root@test.local', '10.0.0.1', true, null)`);
  const s = await getSystemStatus(db, root, runtime);
  assert.equal(s.database.ok, true);
  assert.deepEqual(s.signins24h.staff, {ok: 2, failed: 1});
  assert.deepEqual(s.runtime, runtime);
  assert.ok(!JSON.stringify(s).match(/password|postgresql:\/\//i), 'no connection strings or secrets in the status');
});

test('sign-in history needs audit.read; filters by realm, failures and email', async () => {
  await assert.rejects(listSignIns(db, support, {page: 1}), ForbiddenError);
  await q(`insert into auth_attempts (realm, email, ip, succeeded, failure_reason) values
    ('customer', 'm9.cust@test.local', '10.0.0.9', false, 'bad_password'), ('customer', 'm9.cust@test.local', '10.0.0.9', true, null)`);
  const all = await listSignIns(db, manager, {page: 1});
  assert.equal(all.rows.length, 5);
  assert.ok(all.rows.every((r, i) => !i || all.rows[i - 1].at >= r.at), 'newest first');
  const failedCustomer = await listSignIns(db, manager, {page: 1, realm: 'customer', failedOnly: true});
  assert.deepEqual(failedCustomer.rows.map(r => [r.email, r.reason]), [['m9.cust@test.local', 'bad_password']]);
  const byEmail = await listSignIns(db, manager, {page: 1, email: ' M9.Cust@test.local '});
  assert.equal(byEmail.rows.length, 2);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
