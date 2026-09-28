/* M18: staff two-factor sign-in (RFC 6238 codes, encrypted secret, no replay, one-time recovery codes, wrong codes count
   toward the sign-in limit, fail closed without the key), staff reset by staff.manage, global search limited by
   permissions, security alerts. LOCAL test database only; the encryption key is a throwaway generated here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {
  acceptStaffInvite, base32Decode, confirmStaffMfa, currentStep, disableStaffMfa, issueStaffInvite, loginStaff, startStaffMfa, staffMfaStatus, totpAt,
  validateStaffSession,
} from '@kitsyuu/auth';
import {ForbiddenError} from '@kitsyuu/contracts';
import {globalSearch, resetStaffTwoFactor, securityAlerts} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '10.18.0.1', userAgent: 'm18.test', requestId: 'test'};
const PW = 'm18 test passphrase ok';

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: PW, fullName: role}, ctx)).token);
}
const failures = async email => (await q(`select count(*)::int n from auth_attempts where email = $1 and not succeeded`, [email]))[0].n;

let root, manager, support, secret, recovery;

test('RFC 6238 test vectors (SHA-1, last 6 digits)', () => {
  const k = Buffer.from('12345678901234567890');
  // T = 59, 1111111109, 1111111111, 1234567890, 2000000000 seconds → steps 1, 37037036, 37037037, 41152263, 66666666.
  assert.deepEqual([1, 37037036, 37037037, 41152263, 66666666].map(s => totpAt(k, s)), ['287082', '081804', '050471', '005924', '279037']);
});

test('without the key two-factor is unavailable (never stored unprotected)', async () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  root = await staff('m18.root@test.local', 'super_admin');
  assert.deepEqual(await startStaffMfa(db, root, root.email), {ok: false, error: 'unavailable'});
  assert.deepEqual(await q(`select count(*)::int n from staff_mfa`), [{n: 0}]);
});

test('enrolment: secret encrypted at rest, confirmed with a code, ten recovery codes stored as hashes', async () => {
  process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  manager = await staff('m18.manager@test.local', 'manager');
  support = await staff('m18.support@test.local', 'support');
  const s = await startStaffMfa(db, manager, manager.email);
  assert.equal(s.ok, true); assert.match(s.uri, /^otpauth:\/\/totp\/KITSYUU%20Admin%3Am18\.manager/);
  secret = base32Decode(s.secret);
  const stored = (await q(`select secret_enc, enabled_at from staff_mfa where staff_user_id = $1`, [manager.staffId]))[0];
  assert.equal(stored.enabled_at, null); assert.ok(!stored.secret_enc.includes(secret), 'the secret is not stored in the clear');
  assert.deepEqual(await confirmStaffMfa(db, manager, '000000', ctx), {ok: false, error: 'bad_code'});
  const c = await confirmStaffMfa(db, manager, totpAt(secret, currentStep()), ctx);
  assert.equal(c.ok, true); assert.equal(c.recoveryCodes.length, 10); recovery = c.recoveryCodes;
  const hashes = await q(`select code_hash from staff_mfa_recovery_codes where staff_user_id = $1`, [manager.staffId]);
  assert.ok(hashes.every(h => h.code_hash.length === 32) && !JSON.stringify(hashes).includes(recovery[0]));
  assert.deepEqual(await staffMfaStatus(db, manager.staffId), {available: true, enabled: true, pending: false, recoveryCodesLeft: 10});
});

test('sign-in: code asked only after the right password; wrong codes count as failures; no replay; recovery codes once', async () => {
  const e = manager.email;
  const f0 = await failures(e);
  assert.deepEqual(await loginStaff(db, {email: e, password: PW}, ctx), {ok: false, error: 'mfa_required'});
  assert.equal(await failures(e), f0, 'a missing code is not a failed attempt');
  assert.deepEqual(await loginStaff(db, {email: e, password: 'wrong password!!', code: totpAt(secret, currentStep() + 1)}, ctx), {ok: false, error: 'invalid'}, 'the password is checked first');
  assert.deepEqual(await loginStaff(db, {email: e, password: PW, code: '123456'}, ctx), {ok: false, error: 'mfa_invalid'});
  assert.equal(await failures(e), f0 + 2, 'wrong password and wrong code both count');
  const next = totpAt(secret, currentStep() + 1);        // the confirm step was used; the next one is fresh
  const ok = await loginStaff(db, {email: e, password: PW, code: next}, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(await loginStaff(db, {email: e, password: PW, code: next}, ctx), {ok: false, error: 'mfa_invalid'}, 'a code works once');
  assert.equal((await loginStaff(db, {email: e, password: PW, code: recovery[0].toUpperCase()}, ctx)).ok, true);
  assert.deepEqual(await loginStaff(db, {email: e, password: PW, code: recovery[0]}, ctx), {ok: false, error: 'mfa_invalid'}, 'a recovery code works once');
  assert.equal((await staffMfaStatus(db, manager.staffId)).recoveryCodesLeft, 9);
  // Without the key an enrolled person cannot pass with an app code (fail closed), but a recovery code still works.
  const key = process.env.MFA_ENCRYPTION_KEY; delete process.env.MFA_ENCRYPTION_KEY;
  assert.deepEqual(await loginStaff(db, {email: e, password: PW, code: totpAt(secret, currentStep() + 1)}, ctx), {ok: false, error: 'mfa_unavailable'});
  assert.equal((await loginStaff(db, {email: e, password: PW, code: recovery[1]}, ctx)).ok, true);
  process.env.MFA_ENCRYPTION_KEY = key;
  assert.deepEqual((await q(`select action from audit_logs where action like 'auth.mfa%' or action like 'staff.mfa%' order by id`)).map(a => a.action),
    ['staff.mfa_enable', 'auth.mfa_recovery_used', 'auth.mfa_recovery_used']);
});

test('switching off needs the password; staff.manage can reset someone else (with the rank guard)', async () => {
  assert.deepEqual(await disableStaffMfa(db, manager, 'not my password', ctx), {ok: false, error: 'wrong_password'});
  await assert.rejects(resetStaffTwoFactor(db, support, manager.staffId, ctx), ForbiddenError);
  await assert.rejects(resetStaffTwoFactor(db, manager, root.staffId, ctx), ForbiddenError, 'a manager cannot touch a super admin');
  assert.deepEqual(await resetStaffTwoFactor(db, root, manager.staffId, ctx), {removed: true});
  assert.equal((await loginStaff(db, {email: manager.email, password: PW}, ctx)).ok, true, 'password alone works again');
  assert.deepEqual(await q(`select count(*)::int n from staff_mfa_recovery_codes where staff_user_id = $1`, [manager.staffId]), [{n: 0}]);
});

test('global search: only areas the person may open; alerts from existing rules', async () => {
  const [p] = await q(`select sku, name from products order by sku limit 1`);
  const asRoot = await globalSearch(db, root, p.sku);
  assert.deepEqual(asRoot.map(g => g.key), ['products']);
  assert.equal(asRoot[0].hits[0].title, p.name);
  assert.deepEqual(await globalSearch(db, root, 'x'), [], 'at least 2 characters');
  assert.deepEqual((await globalSearch(db, root, 'm18.manager')).map(g => g.key), [], 'staff are not searchable');
  const sup = await globalSearch(db, support, p.sku);
  assert.deepEqual(sup.map(g => g.key), ['products'], 'support may read products');
  assert.deepEqual(await globalSearch(db, root, '%'), [], 'LIKE wildcards are matched literally');
  await assert.rejects(securityAlerts(db, manager), ForbiddenError);
  // Five recorded failures for one email (from different addresses, as real traffic would be; this test's own IP is
  // already at its limit, and throttled attempts are not recorded).
  for (let i = 0; i < 5; i++) await q(`insert into auth_attempts (realm, email, ip, succeeded, failure_reason) values ('staff', 'nobody.m18@test.local', $1, false, 'unknown_email')`, [`10.19.0.${i + 1}`]);
  const a = await securityAlerts(db, root);
  assert.ok(a.lockedAccounts.some(l => l.email === 'nobody.m18@test.local'));
  assert.deepEqual([a.staffActive, a.staffWithTwoFactor], [3, 0]);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
