/* Sign-up account takeover ("pre-hijack") regression tests (2026-10-14), against the LOCAL test database. Services connect as
   the real kitsyuu_website role. The two attack paths found in docs/reviews/2026-10-14/review-2-pre-hijack.md:
     S1  the attacker registers the victim's address with their own password; the victim later signs up and confirms. Before
         the fix the victim's password was discarded and confirming activated the ATTACKER's password.
     S2  the attacker registers the victim's address, then tries to log in: the store emailed the victim a confirmation link,
         and a mail scanner opening it (a GET) confirmed the account with the attacker's password.
   Fixed: confirming sets the password (a separate step, never on opening the link), re-registration replaces the pending
   credentials, a login never sends a link, and confirming ends every other session and outstanding link.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/signup-takeover.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDb} from '@kitsyuu/db';
import {
  checkCustomerVerificationLink, createCustomerSession, loginCustomer, requestCustomerPasswordReset, resetCustomerPassword, signupCustomer,
  validateCustomerSession, verifyCustomerEmail,
} from '@kitsyuu/auth';
import {verifyEmailInput} from '@kitsyuu/contracts';

const {WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: WEBSITE_DATABASE_URL, max: 3});      // kitsyuu_website
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});          // checks only
const ctx = {ip: '127.0.0.1', userAgent: 'signup-takeover.test', requestId: 'test'};
const outbox = [];
const mailer = {kind: 'memory', async send(m) { outbox.push(m); }};
const links = {verifyUrl: t => `http://test/verify-email?token=${t}`, resetUrl: t => `http://test/reset-password?token=${t}`};
const linkIn = m => m.text.match(/token=([A-Za-z0-9_-]{43})/)[1];
const mailsTo = to => outbox.filter(m => m.to === to);
const ATTACKER = 'mallory chose this password', VICTIM = 'the real owner chose this one', VICTIM2 = 'a second long pass phrase';
const login = (email, password) => loginCustomer(db, mailer, {email, password}, {...ctx, ...links});
const account = email => owner.selectFrom('customers').select(['id', 'full_name', 'email_verified_at']).where('email', '=', email).executeTakeFirstOrThrow();
const openTokens = async id => (await owner.selectFrom('auth_tokens').select('purpose').where('customer_id', '=', id).where('used_at', 'is', null).execute()).length;
const liveSessions = async id => (await owner.selectFrom('customer_sessions').select('id').where('customer_id', '=', id).where('revoked_at', 'is', null).execute()).length;

test('S1: the attacker registers first, the owner signs up and confirms: the attacker’s password never works', async () => {
  const email = 's1.victim@test.local';
  await signupCustomer(db, mailer, {email, password: ATTACKER, fullName: 'Mallory'}, {...ctx, ...links});
  assert.equal((await account(email)).email_verified_at, null);
  // The owner signs up later with their own password and name: the pending credentials become theirs, the earlier link stops.
  await signupCustomer(db, mailer, {email, password: VICTIM, fullName: 'Vera Owner'}, {...ctx, ...links});
  const [first, second] = mailsTo(email).map(linkIn);
  assert.equal((await account(email)).full_name, 'Vera Owner', 'the latest registrant’s name');
  assert.equal(await checkCustomerVerificationLink(db, {token: first}), false, 'the earlier link was superseded');
  assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'invalid'}, 'the attacker’s pending password is gone');
  // Confirming sets the password; the account is then the owner's alone.
  const r = await verifyCustomerEmail(db, {token: second, password: VICTIM}, ctx);
  assert.ok(r.ok);
  assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'invalid'});
  assert.ok((await login(email, VICTIM)).ok);
  const actions = (await owner.selectFrom('audit_logs').select('action').where('customer_id', '=', r.customerId).orderBy('id').execute()).map(a => a.action);
  assert.ok(actions.includes('customer.signup_pending_replaced') && actions.includes('customer.email_verify'), actions.join(','));
});

test('S1 without a second sign-up: the owner confirms from the link the attacker caused, with a password of their own', async () => {
  const email = 's1b.victim@test.local';
  await signupCustomer(db, mailer, {email, password: ATTACKER, fullName: 'Mallory'}, {...ctx, ...links});
  const token = linkIn(mailsTo(email).at(-1));                 // arrives in the OWNER's inbox
  assert.ok((await verifyCustomerEmail(db, {token, password: VICTIM}, ctx)).ok);
  assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'invalid'}, 'the password chosen at sign-up was never activated');
  assert.ok((await login(email, VICTIM)).ok);
});

test('S2: the attacker’s login sends nothing; a mail scanner opening the link confirms nothing; confirming needs a password', async () => {
  const email = 's2.victim@test.local';
  await signupCustomer(db, mailer, {email, password: ATTACKER, fullName: 'Mallory'}, {...ctx, ...links});
  assert.equal(mailsTo(email).length, 1);
  for (let i = 0; i < 3; i++) assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'unverified'});
  assert.equal(mailsTo(email).length, 1, 'logging in never emails the owner a link');
  const token = linkIn(mailsTo(email)[0]);
  const {id} = await account(email);
  // A scanner (or anyone) opening the link: only a read, as often as it likes.
  for (let i = 0; i < 3; i++) assert.equal(await checkCustomerVerificationLink(db, {token}), true);
  assert.equal((await account(email)).email_verified_at, null, 'not confirmed');
  assert.equal(await openTokens(id), 1, 'the link is not used up');
  assert.equal(await liveSessions(id), 0, 'no session');
  // The confirmation form cannot be sent without a password (the server action validates it before anything else).
  assert.equal(verifyEmailInput.safeParse({token}).success, false);
  assert.equal(verifyEmailInput.safeParse({token, password: VICTIM, confirm: 'different'}).success, false);
  assert.equal(verifyEmailInput.safeParse({token, password: VICTIM, confirm: VICTIM}).success, true);
  // The owner confirms with their own password: the attacker's never works, before or after.
  assert.ok((await verifyCustomerEmail(db, {token, password: VICTIM}, ctx)).ok);
  assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'invalid'});
  assert.equal(await checkCustomerVerificationLink(db, {token}), false, 'used once');
});

test('confirming ends every other session and every outstanding link; re-registration after confirming changes nothing', async () => {
  const email = 'sessions.owner@test.local';
  await signupCustomer(db, mailer, {email, password: VICTIM, fullName: 'Sam Owner'}, {...ctx, ...links});
  const {id} = await account(email);
  const verifyToken = linkIn(mailsTo(email).at(-1));
  // A session that should not survive confirmation (e.g. one made through an older sign-in path), and a pending reset link.
  const stray = await createCustomerSession(owner, id, ctx);
  await requestCustomerPasswordReset(db, mailer, {email}, {...ctx, ...links});
  const resetToken = linkIn(mailsTo(email).at(-1));
  assert.ok(await validateCustomerSession(db, stray.token));
  const r = await verifyCustomerEmail(db, {token: verifyToken, password: VICTIM2}, ctx);
  assert.ok(r.ok);
  assert.equal(await validateCustomerSession(db, stray.token), null, 'the earlier session ended');
  assert.ok(await validateCustomerSession(db, r.token), 'the new session works');
  assert.equal(await liveSessions(id), 1);
  assert.deepEqual(await resetCustomerPassword(db, {token: resetToken, password: ATTACKER}, ctx), {ok: false, error: 'invalid_link'}, 'the reset link stopped working');
  assert.equal(await openTokens(id), 0);
  assert.ok((await login(email, VICTIM2)).ok, 'the password set when confirming');
  // Once confirmed, signing up again with the address changes nothing and sends nothing.
  const before = outbox.length;
  await signupCustomer(db, mailer, {email, password: ATTACKER, fullName: 'Mallory'}, {...ctx, ...links});
  assert.equal(outbox.length, before);
  assert.equal((await account(email)).full_name, 'Sam Owner');
  assert.deepEqual(await login(email, ATTACKER), {ok: false, error: 'invalid'});
  const [audit] = (await owner.selectFrom('audit_logs').select('metadata').where('customer_id', '=', id).where('action', '=', 'customer.email_verify').execute());
  assert.deepEqual([audit.metadata.password_set, audit.metadata.sessions_ended], [true, 1]);
});

test.after(async () => { await db.destroy(); await owner.destroy(); });
