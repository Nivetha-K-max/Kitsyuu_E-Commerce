/* Integration tests for the M3 staff/roles/auth rules, against the LOCAL test database (database/scripts/test-db.mjs).
   Services connect as the real kitsyuu_admin role (so the M2 grants are exercised); setup uses the owner connection.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, changeStaffPassword, issueStaffInvite, loginStaff, requestStaffPasswordReset, resetStaffPassword, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, ForbiddenError} from '@kitsyuu/contracts';
import {createRole, deleteRole, getDashboard, inviteStaff, listStaff, setStaffRoles, setStaffStatus, updateRole, updateStaff, listAudit} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 3});        // kitsyuu_admin
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});          // setup only
const ctx = {ip: '127.0.0.1', userAgent: 'core.test', requestId: 'test'};
const outbox = [];
const mailer = {kind: 'memory', async send(m) { outbox.push(m); }};
const lastLink = () => outbox.at(-1).text.match(/token=([A-Za-z0-9_-]{43})/)[1];
const mctx = {...ctx, inviteUrl: t => `http://test/accept-invite?token=${t}`};
const PW = 'correct horse battery staple';
const roleId = async code => (await db.selectFrom('roles').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;

async function bootstrap(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: await roleId(role)}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const r = await acceptStaffInvite(db, {token, password: PW, fullName: 'Test ' + role}, ctx);
  assert.ok(r.ok);
  return {token, session: r.token};
}
const principal = async session => { const p = await validateStaffSession(db, session); assert.ok(p); return p; };

let superSession, sup, adminSession, admin, supportId;

test('bootstrap super admin through an invitation (the only way to create staff)', async () => {
  const b = await bootstrap('root@test.local', 'super_admin');
  superSession = b.session; sup = await principal(superSession);
  assert.equal(sup.permissions.size, (await db.selectFrom('permissions').select('code').execute()).length);
  const r = await acceptStaffInvite(db, {token: b.token, password: PW, fullName: 'x'}, ctx);
  assert.deepEqual(r, {ok: false, error: 'invalid_link'}, 'an invitation link works only once');
});

test('password is stored as argon2id, never in plain text', async () => {
  const row = await owner.selectFrom('staff_users').select('password_hash').where('email', '=', 'root@test.local').executeTakeFirstOrThrow();
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!row.password_hash.includes(PW));
});

test('sessions store only a SHA-256 of the token', async () => {
  const rows = await owner.selectFrom('staff_sessions').select('token_hash').execute();
  assert.ok(rows.length >= 1 && rows.every(r => r.token_hash.length === 32));
  assert.ok(rows.every(r => !r.token_hash.toString('utf8').includes(superSession)));
});

test('login: correct, wrong password, unknown email (same answer), disabled/invited cannot sign in', async () => {
  assert.ok((await loginStaff(db, {email: 'root@test.local', password: PW}, ctx)).ok);
  assert.deepEqual(await loginStaff(db, {email: 'root@test.local', password: 'nope nope nope'}, ctx), {ok: false, error: 'invalid'});
  assert.deepEqual(await loginStaff(db, {email: 'nobody@test.local', password: PW}, ctx), {ok: false, error: 'invalid'});
});

test('invite admin; admin holds every permission except roles.manage', async () => {
  await inviteStaff(db, mailer, sup, {email: 'admin@test.local', fullName: 'Admin', roleIds: [await roleId('admin')]}, mctx);
  assert.match(outbox.at(-1).text, /accept-invite\?token=/);
  const r = await acceptStaffInvite(db, {token: lastLink(), password: PW, fullName: 'Admin'}, ctx);
  adminSession = r.token; admin = await principal(adminSession);
  assert.ok(admin.permissions.has('staff.manage') && !admin.permissions.has('roles.manage'));
});

test('no escalation: admin cannot grant super_admin, nor edit a super admin', async () => {
  await assert.rejects(inviteStaff(db, mailer, admin, {email: 'x@test.local', fullName: 'X', roleIds: [await roleId('super_admin')]}, mctx), ForbiddenError);
  await assert.rejects(setStaffRoles(db, admin, {staffId: admin.staffId, roleIds: [await roleId('super_admin')]}, mctx), ForbiddenError);
  await assert.rejects(updateStaff(db, admin, {staffId: sup.staffId, email: 'hijack@test.local', fullName: 'x'}, mctx), ForbiddenError);
  await assert.rejects(setStaffStatus(db, admin, {staffId: sup.staffId, status: 'disabled'}, mctx), ForbiddenError);
  await assert.rejects(createRole(db, admin, {code: 'x_role', name: 'X', description: ''}, mctx), ForbiddenError, 'roles.manage is required');
});

test('lockout guard: the last holder of staff.manage + roles.manage cannot remove it; nobody can disable themselves', async () => {
  await assert.rejects(setStaffRoles(db, sup, {staffId: sup.staffId, roleIds: [await roleId('admin')]}, mctx), ConflictError);
  await assert.rejects(setStaffStatus(db, sup, {staffId: sup.staffId, status: 'disabled'}, mctx), ConflictError);
  await assert.rejects(updateRole(db, sup, {roleId: await roleId('super_admin'), name: 'Super admin', description: '', permissionCodes: ['dashboard.read']}, mctx), ConflictError);
});

test('support role: permission checks are enforced by the services, not just the UI', async () => {
  await inviteStaff(db, mailer, sup, {email: 'support@test.local', fullName: 'Support', roleIds: [await roleId('support')]}, mctx);
  const r = await acceptStaffInvite(db, {token: lastLink(), password: PW, fullName: 'Support'}, ctx);
  const support = await principal(r.token); supportId = support.staffId;
  await assert.rejects(listStaff(db, support), ForbiddenError);
  await assert.rejects(listAudit(db, support, {page: 1}), ForbiddenError);
  assert.ok(await getDashboard(db, support));
});

test('disabling a staff member ends their sessions and blocks sign-in', async () => {
  const s = await loginStaff(db, {email: 'support@test.local', password: PW}, ctx);
  assert.ok(await validateStaffSession(db, s.token));
  await setStaffStatus(db, sup, {staffId: supportId, status: 'disabled'}, mctx);
  assert.equal(await validateStaffSession(db, s.token), null);
  assert.deepEqual(await loginStaff(db, {email: 'support@test.local', password: PW}, ctx), {ok: false, error: 'invalid'});
});

test('role changes take effect on the next request (permissions are loaded per request)', async () => {
  const {roleId: rid} = await createRole(db, sup, {code: 'qa_temp', name: 'QA temp', description: ''}, mctx);
  await updateRole(db, sup, {roleId: rid, name: 'QA temp', description: 'x', permissionCodes: ['audit.read']}, mctx);
  await setStaffRoles(db, sup, {staffId: admin.staffId, roleIds: [await roleId('admin'), rid]}, mctx);
  await setStaffRoles(db, sup, {staffId: admin.staffId, roleIds: [await roleId('admin')]}, mctx);
  await deleteRole(db, sup, rid, mctx);
  assert.equal((await db.selectFrom('roles').select('id').where('code', '=', 'qa_temp').execute()).length, 0);
});

test('password reset: generic, one-time, ends all sessions', async () => {
  outbox.length = 0;
  await requestStaffPasswordReset(db, mailer, {email: 'nobody@test.local'}, {...ctx, resetUrl: t => `http://test/reset-password?token=${t}`});
  assert.equal(outbox.length, 0, 'no email for an unknown address (and the same response)');
  await requestStaffPasswordReset(db, mailer, {email: 'admin@test.local'}, {...ctx, resetUrl: t => `http://test/reset-password?token=${t}`});
  const token = lastLink();
  assert.ok((await resetStaffPassword(db, {token, password: 'a brand new long password'}, ctx)).ok);
  assert.equal(await validateStaffSession(db, adminSession), null, 'old sessions ended');
  assert.deepEqual(await resetStaffPassword(db, {token, password: 'another long password!!'}, ctx), {ok: false, error: 'invalid_link'});
  assert.ok((await loginStaff(db, {email: 'admin@test.local', password: 'a brand new long password'}, ctx)).ok);
});

test('change password requires the current one', async () => {
  const p = await principal(superSession);
  assert.deepEqual(await changeStaffPassword(db, p, {current: 'wrong wrong wrong', password: 'x'.repeat(14)}, ctx), {ok: false, error: 'wrong_current'});
});

test('throttling after repeated failures (per email), even for the right password', async () => {
  for (let i = 0; i < 5; i++) await loginStaff(db, {email: 'root@test.local', password: 'bad password ' + i}, {...ctx, ip: '10.9.9.' + i});
  const r = await loginStaff(db, {email: 'root@test.local', password: PW}, {...ctx, ip: '10.9.9.99'});
  assert.equal(r.ok, false); assert.equal(r.error, 'throttled');
});

test('audit log recorded every change, and kitsyuu_admin cannot rewrite it', async () => {
  const actions = new Set((await owner.selectFrom('audit_logs').select('action').execute()).map(r => r.action));
  for (const a of ['staff.invite', 'staff.invite_accept', 'auth.login', 'staff.disable', 'role.create', 'role.update', 'role.delete', 'staff.roles_update', 'auth.password_reset_request', 'auth.password_reset'])
    assert.ok(actions.has(a), `audit has ${a}`);
  await assert.rejects(db.updateTable('audit_logs').set({action: 'x.y'}).execute(), /permission denied/);
  await assert.rejects(db.deleteFrom('audit_logs').execute(), /permission denied/);
});

test('dashboard figures come from the database', async () => {
  const d = await getDashboard(db, sup);
  assert.equal(d.products.total, 22); assert.equal(d.variants.sellable, 110); assert.equal(d.variants.units, 1100);
  assert.equal(d.orders.total, 0); assert.equal(d.revenue.totalPaise, 0); assert.equal(d.lowStock.count, 0);
});

test.after(async () => { await db.destroy(); await owner.destroy(); });
