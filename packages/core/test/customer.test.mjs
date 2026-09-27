/* Integration tests for M6 customer authentication and the customer account, against the LOCAL test database
   (database/scripts/test-db.mjs). Services connect as the real kitsyuu_website role (so its M2/M6 grants and policies are
   exercised); setup and checks use the owner connection. Never touches Supabase: the legacy (Supabase) password check is
   a stand-in function.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/customer.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDb} from '@kitsyuu/db';
import {
  changeCustomerPassword, endCustomerSession, listCustomerSessions, loginCustomer, logoutCustomer, logoutCustomerEverywhere,
  requestCustomerPasswordReset, resendCustomerVerification, resetCustomerPassword, signupCustomer, validateCustomerSession, verifyCustomerEmail,
} from '@kitsyuu/auth';
import {addressInput, ConflictError, customerProfileInput, NotFoundError, signupInput} from '@kitsyuu/contracts';
import {
  deleteCustomerAddress, getCustomerAddress, getCustomerOrder, getCustomerProfile, listCustomerAddresses, listCustomerOrders,
  saveCustomerAddress, setDefaultCustomerAddress, updateCustomerProfile,
} from '@kitsyuu/core';

const {WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');
assert.ok(/kitsyuu_website/.test(WEBSITE_DATABASE_URL), 'services must run as the website role');

const db = createDb({connectionString: WEBSITE_DATABASE_URL, max: 3});      // kitsyuu_website
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});          // setup and checks only
const ctx = {ip: '127.0.0.1', userAgent: 'customer.test', requestId: 'test'};
const outbox = [];
const mailer = {kind: 'memory', async send(m) { outbox.push(m); }};
const links = {verifyUrl: t => `http://test/verify-email?token=${t}`, resetUrl: t => `http://test/reset-password?token=${t}`};
const linkIn = m => m.text.match(/token=([A-Za-z0-9_-]{43})/)[1];
const mailsTo = to => outbox.filter(m => m.to === to);
const PW = 'correct horse battery staple', PW2 = 'another long pass phrase';
const principal = async token => { const p = await validateCustomerSession(db, token); assert.ok(p, 'session should be valid'); return p; };
const auditActions = async id => (await owner.selectFrom('audit_logs').select('action').where('customer_id', '=', id).orderBy('id').execute()).map(r => r.action);
const idOf = async email => (await owner.selectFrom('customers').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;

// shared across tests
let asha, ashaSession, ravi, raviSession;

async function signupAndVerify(email, name) {
  await signupCustomer(db, mailer, {email, password: PW, fullName: name}, {...ctx, ...links});
  const r = await verifyCustomerEmail(db, {token: linkIn(mailsTo(email).at(-1))}, ctx);
  assert.ok(r.ok);
  return r.token;
}

test('signup creates an unconfirmed account and emails a confirmation link; no session yet', async () => {
  await signupCustomer(db, mailer, {email: 'asha@test.local', password: PW, fullName: 'Asha Rao'}, {...ctx, ...links});
  const c = await owner.selectFrom('customers').selectAll().where('email', '=', 'asha@test.local').executeTakeFirstOrThrow();
  assert.equal(c.email_verified_at, null);
  assert.match(c.password_hash, /^\$argon2id\$/);
  assert.equal(c.legacy_auth_user_id, null);
  assert.equal(mailsTo('asha@test.local').length, 1);
  assert.match(mailsTo('asha@test.local')[0].subject, /Confirm/);
  assert.equal((await owner.selectFrom('customer_sessions').select('id').where('customer_id', '=', c.id).execute()).length, 0);
});

test('login before confirming: correct password → "unverified" and a new link; wrong password → "invalid"', async () => {
  const before = mailsTo('asha@test.local').length;
  assert.deepEqual(await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links}), {ok: false, error: 'unverified'});
  assert.equal(mailsTo('asha@test.local').length, before + 1);
  assert.deepEqual(await loginCustomer(db, mailer, {email: 'asha@test.local', password: 'wrong password here'}, {...ctx, ...links}), {ok: false, error: 'invalid'});
  assert.equal(mailsTo('asha@test.local').length, before + 1);   // no link for a wrong password
});

test('confirmation link signs in once; the earlier (superseded) link and a reused link are refused', async () => {
  const [first, latest] = mailsTo('asha@test.local').slice(-2).map(linkIn);
  assert.deepEqual(await verifyCustomerEmail(db, {token: first}, ctx), {ok: false, error: 'invalid_link'});
  const r = await verifyCustomerEmail(db, {token: latest}, ctx);
  assert.ok(r.ok);
  ashaSession = r.token; asha = await principal(ashaSession);
  assert.equal(asha.emailVerified, true);
  assert.deepEqual(await verifyCustomerEmail(db, {token: latest}, ctx), {ok: false, error: 'invalid_link'});
  assert.deepEqual(await auditActions(asha.customerId), ['customer.signup', 'auth.email_verification_request', 'auth.email_verification_request', 'customer.email_verify']);
});

test('no enumeration: signing up with an existing confirmed email changes nothing and sends nothing', async () => {
  const before = outbox.length, hash = (await owner.selectFrom('customers').select('password_hash').where('id', '=', asha.customerId).executeTakeFirstOrThrow()).password_hash;
  await signupCustomer(db, mailer, {email: 'asha@test.local', password: 'attacker chosen password', fullName: 'Mallory'}, {...ctx, ...links});
  const after = await owner.selectFrom('customers').select(['password_hash', 'full_name']).where('id', '=', asha.customerId).executeTakeFirstOrThrow();
  assert.equal(after.password_hash, hash);
  assert.equal(after.full_name, 'Asha Rao');
  assert.equal(outbox.length, before);
  // unknown emails: reset / resend quietly do nothing
  await requestCustomerPasswordReset(db, mailer, {email: 'nobody@test.local'}, {...ctx, ...links});
  await resendCustomerVerification(db, mailer, {email: 'nobody@test.local'}, {...ctx, ...links});
  assert.equal(outbox.length, before);
});

test('login: success creates a session; unknown email and wrong password give the same answer', async () => {
  const ok = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links});
  assert.ok(ok.ok);
  const p = await principal(ok.token);
  assert.equal(p.customerId, asha.customerId);
  assert.notEqual(p.sessionId, asha.sessionId);
  assert.deepEqual(await loginCustomer(db, mailer, {email: 'ghost@test.local', password: PW}, {...ctx, ...links}), {ok: false, error: 'invalid'});
  await logoutCustomer(db, ok.token, ctx);
  assert.equal(await validateCustomerSession(db, ok.token), null);
  assert.equal(await validateCustomerSession(db, 'not-a-token'), null);
});

test('login throttling: after 5 failures the account is throttled, even with the right password', async () => {
  await signupAndVerify('throttle@test.local', 'Throttle Test');
  for (let i = 0; i < 5; i++) assert.equal((await loginCustomer(db, mailer, {email: 'throttle@test.local', password: 'wrong password ' + i}, {...ctx, ip: '10.0.0.' + i, ...links})).error, 'invalid');
  const r = await loginCustomer(db, mailer, {email: 'throttle@test.local', password: PW}, {...ctx, ip: '10.9.9.9', ...links});
  assert.equal(r.ok, false); assert.equal(r.error, 'throttled');
});

test('login throttling per IP is higher for customers (shared IPs): other accounts on the same IP still sign in', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await loginCustomer(db, mailer, {email: `stranger${i}@test.local`, password: 'wrong'}, {...ctx, ip: '10.1.1.1', ...links})).error, 'invalid');
  await signupAndVerify('shared-ip@test.local', 'Shared IP');
  assert.ok((await loginCustomer(db, mailer, {email: 'shared-ip@test.local', password: PW}, {...ctx, ip: '10.1.1.1', ...links})).ok);
  const limit = Number((await owner.selectFrom('settings').select('value').where('key', '=', 'auth.customer_login_max_failures_per_ip').executeTakeFirstOrThrow()).value);
  assert.equal(limit, 50);
});

test('legacy Supabase account: first login checks the password once with Supabase, then stores Argon2id', async () => {
  // A mirrored Supabase account (as the M2/M6 migrations create it): same UUID, no password_hash yet.
  const {id} = await owner.insertInto('customers').values({email: 'legacy@test.local', full_name: 'Legacy User', email_verified_at: new Date(), legacy_auth_user_id: null})
    .returning('id').executeTakeFirstOrThrow();
  await owner.updateTable('customers').set({legacy_auth_user_id: id}).where('id', '=', id).execute();
  const calls = [];
  const supabase = async (email, password) => { calls.push(email); return email === 'legacy@test.local' && password === 'old supabase pw'; };
  assert.equal((await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'wrong'}, {...ctx, ...links}, supabase)).error, 'invalid');
  assert.equal((await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'x'}, {...ctx, ...links}, async () => { throw new Error('supabase down'); })).error, 'invalid');
  const r = await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'old supabase pw'}, {...ctx, ...links}, supabase);
  assert.ok(r.ok);
  assert.match((await owner.selectFrom('customers').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash, /^\$argon2id\$/);
  assert.ok((await auditActions(id)).includes('auth.legacy_password_migrated'));
  // From now on Supabase is not asked any more.
  const n = calls.length;
  assert.ok((await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'old supabase pw'}, {...ctx, ...links}, supabase)).ok);
  assert.equal(calls.length, n);
  assert.ok((await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'old supabase pw'}, {...ctx, ...links})).ok);
});

test('password reset: link works once, confirms the email, and ends every session', async () => {
  const other = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links});
  assert.ok(other.ok);
  await requestCustomerPasswordReset(db, mailer, {email: 'asha@test.local'}, {...ctx, ...links});
  const token = linkIn(mailsTo('asha@test.local').at(-1));
  assert.deepEqual(await resetCustomerPassword(db, {token, password: PW2}, ctx), {ok: true});
  assert.deepEqual(await resetCustomerPassword(db, {token, password: PW}, ctx), {ok: false, error: 'invalid_link'});
  assert.equal(await validateCustomerSession(db, ashaSession), null);
  assert.equal(await validateCustomerSession(db, other.token), null);
  assert.equal((await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links})).error, 'invalid');
  const r = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW2}, {...ctx, ...links});
  assert.ok(r.ok);
  ashaSession = r.token; asha = await principal(ashaSession);
});

test('change password: needs the current password; other sessions end, this one stays', async () => {
  const other = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW2}, {...ctx, ...links});
  assert.deepEqual(await changeCustomerPassword(db, asha, {current: 'wrong', password: PW}, ctx), {ok: false, error: 'wrong_current'});
  assert.deepEqual(await changeCustomerPassword(db, asha, {current: PW2, password: PW}, ctx), {ok: true});
  assert.ok(await validateCustomerSession(db, ashaSession));
  assert.equal(await validateCustomerSession(db, other.token), null);
  assert.ok((await owner.selectFrom('customers').select('password_changed_at').where('id', '=', asha.customerId).executeTakeFirstOrThrow()).password_changed_at);
});

test('sessions: list and end only your own; sign out everywhere', async () => {
  raviSession = await signupAndVerify('ravi@test.local', 'Ravi Kumar'); ravi = await principal(raviSession);
  const second = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, userAgent: 'second device', ...links});
  const mine = await listCustomerSessions(db, asha);
  assert.ok(mine.length >= 2 && mine.every(s => typeof s.id === 'string'));
  assert.equal(mine.filter(s => s.current).length, 1);
  assert.ok(!mine.some(s => s.id === ravi.sessionId));
  assert.equal(await endCustomerSession(db, asha, ravi.sessionId, ctx), false);        // someone else's session
  assert.ok(await validateCustomerSession(db, raviSession));
  const secondId = (await principal(second.token)).sessionId;
  assert.equal(await endCustomerSession(db, asha, secondId, ctx), true);
  assert.equal(await validateCustomerSession(db, second.token), null);
  const third = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links});
  assert.ok(await logoutCustomerEverywhere(db, asha, ctx) >= 2);
  assert.equal(await validateCustomerSession(db, ashaSession), null);
  assert.equal(await validateCustomerSession(db, third.token), null);
  assert.ok(await validateCustomerSession(db, raviSession));                            // other customers unaffected
  const r = await loginCustomer(db, mailer, {email: 'asha@test.local', password: PW}, {...ctx, ...links});
  ashaSession = r.token; asha = await principal(ashaSession);
});

test('session expiry: idle and absolute limits, and disabled accounts', async () => {
  const s = await loginCustomer(db, mailer, {email: 'ravi@test.local', password: PW}, {...ctx, ...links});
  const id = (await principal(s.token)).sessionId;
  await owner.updateTable('customer_sessions').set({idle_expires_at: new Date(Date.now() - 1000)}).where('id', '=', id).execute();
  assert.equal(await validateCustomerSession(db, s.token), null);
  const t = await loginCustomer(db, mailer, {email: 'ravi@test.local', password: PW}, {...ctx, ...links});
  const tid = (await principal(t.token)).sessionId;
  await owner.updateTable('customer_sessions').set({expires_at: new Date(Date.now() - 1000)}).where('id', '=', tid).execute();
  assert.equal(await validateCustomerSession(db, t.token), null);
  const cfg = await owner.selectFrom('customer_sessions').select(['created_at', 'idle_expires_at', 'expires_at']).where('id', '=', ravi.sessionId).executeTakeFirstOrThrow();
  const days = (a, b) => Math.round((b - a) / 86_400_000);
  assert.equal(days(cfg.created_at, cfg.expires_at), 90);
  assert.equal(days(cfg.created_at, cfg.idle_expires_at), 30);
  await owner.updateTable('customers').set({status: 'disabled'}).where('id', '=', ravi.customerId).execute();
  assert.equal(await validateCustomerSession(db, raviSession), null);
  assert.equal((await loginCustomer(db, mailer, {email: 'ravi@test.local', password: PW}, {...ctx, ...links})).error, 'invalid');
  await owner.updateTable('customers').set({status: 'active'}).where('id', '=', ravi.customerId).execute();
  assert.ok(await validateCustomerSession(db, raviSession));
});

test('profile: read and update (audited); validation rejects bad input', async () => {
  await updateCustomerProfile(db, asha, customerProfileInput.parse({fullName: 'Asha R', phone: '+91 98765 43210'}), ctx);
  const p = await getCustomerProfile(db, asha);
  assert.equal(p.fullName, 'Asha R'); assert.equal(p.phone, '9876543210'); assert.equal(p.email, 'asha@test.local'); assert.ok(p.emailVerified);
  assert.equal(customerProfileInput.parse({fullName: 'A', phone: ''}).phone, null);
  assert.equal(customerProfileInput.safeParse({fullName: 'A', phone: '12345'}).success, false);
  assert.equal(customerProfileInput.safeParse({fullName: '', phone: ''}).success, false);
  assert.equal(signupInput.safeParse({fullName: 'A', email: 'a@b.co', password: 'short', confirm: 'short'}).success, false);
  assert.ok((await auditActions(asha.customerId)).includes('customer.profile_update'));
});

const addr = (over = {}) => addressInput.parse({fullName: 'Asha Rao', phone: '9876543210', line1: '12 MG Road', line2: '', city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', ...over});

test('addresses: first is default, one default at a time, edit, delete promotes, validation', async () => {
  const a1 = await saveCustomerAddress(db, asha, addr(), ctx);
  assert.equal((await getCustomerAddress(db, asha, a1)).isDefault, true);
  const a2 = await saveCustomerAddress(db, asha, addr({line1: '5 Beach Road', city: 'Chennai', isDefault: 'on'}), ctx);
  let list = await listCustomerAddresses(db, asha);
  assert.deepEqual(list.map(a => [a.id, a.isDefault]), [[a2, true], [a1, false]]);
  await setDefaultCustomerAddress(db, asha, a1, ctx);
  list = await listCustomerAddresses(db, asha);
  assert.equal(list.filter(a => a.isDefault).length, 1); assert.equal(list[0].id, a1);
  await saveCustomerAddress(db, asha, addr({addressId: a2, line1: '6 Beach Road', city: 'Chennai'}), ctx);
  assert.equal((await getCustomerAddress(db, asha, a2)).line1, '6 Beach Road');
  await deleteCustomerAddress(db, asha, a1, ctx);
  list = await listCustomerAddresses(db, asha);
  assert.deepEqual(list.map(a => [a.id, a.isDefault]), [[a2, true]]);
  for (const bad of [{pin: '041001'}, {pin: '6410'}, {phone: '12345'}, {state: 'Narnia'}, {line1: ''}])
    assert.equal(addressInput.safeParse({fullName: 'A', phone: '9876543210', line1: '12 MG Road', city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', ...bad}).success, false, JSON.stringify(bad));
  const actions = await auditActions(asha.customerId);
  for (const a of ['customer.address_create', 'customer.address_update', 'customer.address_default', 'customer.address_delete']) assert.ok(actions.includes(a), a);
});

test('addresses: another customer can neither read nor change them (not found, nothing changed)', async () => {
  const [mine] = await listCustomerAddresses(db, asha);
  await assert.rejects(getCustomerAddress(db, ravi, mine.id), NotFoundError);
  await assert.rejects(saveCustomerAddress(db, ravi, addr({addressId: mine.id, line1: 'Hijacked'}), ctx), NotFoundError);
  await assert.rejects(setDefaultCustomerAddress(db, ravi, mine.id, ctx), NotFoundError);
  await assert.rejects(deleteCustomerAddress(db, ravi, mine.id, ctx), NotFoundError);
  assert.equal((await getCustomerAddress(db, asha, mine.id)).line1, '6 Beach Road');
  assert.deepEqual(await listCustomerAddresses(db, ravi), []);
});

test('addresses: at most 20 per customer', async () => {
  for (let i = (await listCustomerAddresses(db, asha)).length; i < 20; i++) await saveCustomerAddress(db, asha, addr({line1: `${i} Test Street`}), ctx);
  await assert.rejects(saveCustomerAddress(db, asha, addr({line1: 'One too many'}), ctx), ConflictError);
});

test('orders: a customer sees their own orders (including legacy Supabase-keyed ones) and nobody else sees them', async () => {
  const legacyId = await idOf('legacy@test.local');
  const legacy = await principal((await loginCustomer(db, mailer, {email: 'legacy@test.local', password: 'old supabase pw'}, {...ctx, ...links})).token);
  const [variant] = await owner.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
    .select(['v.id', 'v.sku', 'v.size', 'p.id as pid', 'p.name', 'p.price_paise']).limit(1).execute();
  // Orders need a Supabase user until M7 relaxes orders.user_id; the legacy account IS one (same UUID).
  await owner.insertInto('auth.users').values({id: legacyId, email: 'legacy@test.local', email_confirmed_at: new Date()}).execute();
  const {id: fixtureUser} = await owner.insertInto('auth.users').values({email: 'fixture-owner@test.local'}).returning('id').executeTakeFirstOrThrow();
  const mk = async (number, userId, customerId) => {
    const o = await owner.insertInto('orders').values({order_number: number, user_id: userId, customer_id: customerId, status: 'paid', payment_status: 'paid',
      subtotal_paise: variant.price_paise * 2, total_paise: variant.price_paise * 2, contact: JSON.stringify({name: 'x'}),
      shipping_address: JSON.stringify({name: 'Asha', line1: '6 Beach Road', city: 'Chennai', state: 'Tamil Nadu', pin: '600001', country: 'India'}), paid_at: new Date()})
      .returning('id').executeTakeFirstOrThrow();
    await owner.insertInto('order_items').values({order_id: o.id, product_id: variant.pid, variant_id: variant.id, sku: variant.sku, name: variant.name, size: variant.size,
      unit_price_paise: variant.price_paise, qty: 2, line_total_paise: variant.price_paise * 2}).execute();
    await owner.insertInto('order_status_history').values({order_id: o.id, to_status: 'paid'}).execute();
  };
  await mk('KTS-M6-ASHA-1', fixtureUser, asha.customerId);          // platform customer (customer_id)
  await mk('KTS-M6-LEGACY-1', legacyId, null);                       // pre-M6 order keyed only by the Supabase user
  const ashaOrders = await listCustomerOrders(db, asha);
  assert.deepEqual(ashaOrders.map(o => o.orderNumber), ['KTS-M6-ASHA-1']);
  assert.equal(ashaOrders[0].units, 2);
  assert.deepEqual((await listCustomerOrders(db, legacy)).map(o => o.orderNumber), ['KTS-M6-LEGACY-1']);
  assert.deepEqual(await listCustomerOrders(db, ravi), []);
  const d = await getCustomerOrder(db, asha, 'KTS-M6-ASHA-1');
  assert.equal(d.items.length, 1); assert.equal(d.subtotalPaise, variant.price_paise * 2); assert.equal(d.shipping.city, 'Chennai');
  assert.deepEqual(d.history.map(h => h.status), ['paid']);
  await assert.rejects(getCustomerOrder(db, ravi, 'KTS-M6-ASHA-1'), NotFoundError);
  await assert.rejects(getCustomerOrder(db, asha, 'KTS-M6-LEGACY-1'), NotFoundError);
  await assert.rejects(getCustomerOrder(db, legacy, 'KTS-M6-ASHA-1'), NotFoundError);
});

test('audit: customer events are recorded as the customer; the website role cannot read or change the audit log', async () => {
  const actions = await auditActions(asha.customerId);
  for (const a of ['auth.login', 'auth.logout_everywhere', 'auth.password_reset', 'auth.password_change', 'auth.session_revoke']) assert.ok(actions.includes(a), a);
  await assert.rejects(db.selectFrom('audit_logs').select('id').limit(1).execute(), /permission denied/);
  await assert.rejects(db.updateTable('audit_logs').set({action: 'x.y'}).execute(), /permission denied/);
  await assert.rejects(db.selectFrom('staff_users').select('id').limit(1).execute(), /permission denied/);
});

test.after(async () => { await db.destroy(); await owner.destroy(); });
