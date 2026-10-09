/* Phase 6 (2026-10-08): the transactional email service, against the LOCAL test database. Nothing is ever sent to a real
   address: the "providers" here are in-memory mailers and a fake Resend API on 127.0.0.1.
   Covers: the cash-on-delivery confirmation (payment state, wording, amount payable, never "paid"), sent once (repeat,
   concurrent), provider failure (the order stands, the failure is logged), the quick second try, the later retry with
   its limits, a confirmation that was never attempted, status and tracking emails behind their switches, what a customer
   can and cannot see in an email, and the Resend adapter (HTML part, idempotency key, transient vs. refused).
   Adds 2 customers and 5 cash-on-delivery orders (6 units held through the ledger; run-e2e.mjs expects them).
   node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/transactional-email.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {MailError, acceptStaffInvite, consoleMailer, createMailer, emailHtml, fileMailer, issueStaffInvite, resendMailer, validateStaffSession} from '@kitsyuu/auth';
import {paiseToRupees, placeOrderInput, settingUpdateInput, shippingRateInput, shippingZoneInput} from '@kitsyuu/contracts';
import {
  EMAIL_EVENTS, EMAIL_RETRY_MINUTES, addCartLine, databaseDiscounts, defaultCommerceConfig, emailIdempotencyKey, getCustomerCart, notifyOrderStatus, notifyOrderTracking,
  orderEmails, orderPlacedMessage, placeOrder, removeCartLine, retryOrderEmails, saveCustomerAddress, saveShippingRate, saveShippingZone, sendOrderPlacedEmail,
  sendTransactionalEmail, settingsShipping, updateOrderStatus, updateSetting, updateShipmentTracking,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 6});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 8});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'email.test', requestId: 'test'};
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const SHIP_TO = {state: 'Tamil Nadu', pin: '600001', country: 'IN'};
const P = (id, email, name) => ({customerId: id, email, fullName: name, emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const STORE = 'https://store.test';
const orderUrl = n => `${STORE}/account/orders/${n}`;

// ---- "providers": nothing leaves this process
const memory = () => { const sent = []; return {kind: 'memory', sent, async send(m) { sent.push(m); }}; };
const refusing = () => { const m = {kind: 'refusing', calls: 0, async send() { m.calls++; throw new MailError('Email could not be sent (provider answered 422: invalid address).', false); }}; return m; };
const down = () => { const m = {kind: 'down', calls: 0, async send() { m.calls++; throw new MailError('Email could not be sent (provider unreachable: TimeoutError).', true); }}; return m; };
/** Unavailable for the first `n` calls, then delivers. */
const flaky = n => { const m = {kind: 'flaky', calls: 0, sent: [], async send(x) { if (++m.calls <= n) throw new MailError('Email could not be sent (provider answered 503).', true); m.sent.push(x); }}; return m; };
const FAST = [0, 5, 5];   // the quick second and third try without the real pauses

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'email test passphrase', fullName: role}, ctx)).token);
}
const set = (key, value) => updateSetting(admin, root, settingUpdateInput.parse({key, value}), ctx);
const orderRow = n => owner.selectFrom('orders').selectAll().where('order_number', '=', n).executeTakeFirstOrThrow();
const log = orderId => q(`select event, recipient, subject, status, error from notification_log where order_id = $1 order by id`, [orderId]);
const ledger = async () => (await q(`select (select count(*)::int from inventory_movements) rows, (select coalesce(sum(delta),0)::int from inventory_movements) delta, (select coalesce(sum(stock_qty),0)::int from product_variants) units`))[0];

/** Places a cash-on-delivery order the way the checkout does. No email is sent here (the checkout action does that next). */
async function codOrder(p, addressId, qty = 1) {
  for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l);
  await addCartLine(web, p, {productId: prod.id, size: size.size, qty});
  const cart = await getCustomerCart(web, p, config(), SHIP_TO, {method: 'cod', usePoints: false});
  const placed = await placeOrder(web, p, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId, expectedTotalPaise: String(cart.totals.totalPaise), paymentMethod: 'cod'}), ctx, config());
  return {placed, o: await orderRow(placed.orderNumber)};
}
const confirm = (mailer, n) => sendOrderPlacedEmail(web, mailer, n, {orderUrl: orderUrl(n), policy: 'Returns are accepted within 7 days.'});

let root, asha, ravi, ashaAddr, raviAddr, prod, size;
before(async () => {
  root = await staff('mail.root@test.local', 'super_admin');
  const mk = async (email, name) => (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  asha = P(await mk('asha.mail@test.local', 'Asha Mail'), 'asha.mail@test.local', 'Asha Mail');
  ravi = P(await mk('ravi.mail@test.local', 'Ravi Mail'), 'ravi.mail@test.local', 'Ravi Mail');
  const addr = {phone: '9876543210', line2: null, state: 'Tamil Nadu', isDefault: true};
  ashaAddr = await saveCustomerAddress(web, asha, {...addr, fullName: 'Asha Mail', line1: '12 Lotus Street', city: 'Chennai', pin: '600001'}, ctx);
  raviAddr = await saveCustomerAddress(web, ravi, {...addr, fullName: 'Ravi Mail', line1: '7 Banyan Road', city: 'Coimbatore', pin: '641001'}, ctx);
  [prod] = await owner.selectFrom('products').select(['id', 'name', 'price_paise']).where('status', '=', 'active').orderBy('id').limit(1).execute();
  [size] = await owner.selectFrom('product_variants').select(['id', 'size']).where('product_id', '=', prod.id).where('is_active', '=', true).orderBy('sort_order').limit(1).execute();
  // Cash on delivery: switched on, allowed by the delivery rate (the existing rules; nothing is changed for the emails).
  const z = await saveShippingZone(admin, root, shippingZoneInput.parse({name: 'Mail South', states: ['Tamil Nadu'], pinPrefixes: '', active: 'on'}), ctx);
  await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Standard', amount: '50', estMin: '3', estMax: '5', active: 'on', codAllowed: 'on', codFee: '40'}), ctx);
  await set('shipping.method', 'zones');
  await set('payments.cod_enabled', 'on');
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

let A, B, C, D;   // orders used across the tests

// ---------------------------------------------------------------- cash on delivery: the first end-to-end flow
test('COD: order placed → COD payment state → one confirmation email that says cash on delivery and the amount payable, never "paid"', async () => {
  const before = await ledger();
  const {placed, o} = await codOrder(asha, ashaAddr, 2);
  A = o;
  assert.equal(placed.cod, true);
  assert.deepEqual([o.status, o.payment_method, o.cod_status, o.payment_status], ['processing', 'cod', 'to_collect', 'unpaid'], 'the COD payment state, as the checkout records it');
  const afterOrder = await ledger();
  assert.deepEqual([afterOrder.rows - before.rows, afterOrder.units - before.units], [1, -2], 'the order took its stock through the ledger');

  const mailer = memory();
  assert.deepEqual(await confirm(mailer, o.order_number), {sent: true});
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0], total = `₹${paiseToRupees(o.total_paise)}`;
  assert.equal(m.to, 'asha.mail@test.local');
  assert.equal(m.subject, `Your KITSYUU order ${o.order_number} is confirmed`);
  for (const [what, has] of [['order number', o.order_number], ['customer name', 'Hello Asha Mail,'], ['product', prod.name], ['quantity', '× 2'], ['delivery address', '12 Lotus Street'],
    ['city and PIN', 'Chennai, Tamil Nadu, 600001'], ['order total', `Order total: ${total}`], ['payment method', 'Payment method: Cash on Delivery'],
    ['amount payable', `Amount payable on delivery: ${total}`], ['COD fee', 'Cash on delivery fee: ₹40'], ['status', 'Order status: Being prepared'], ['order link', `Your order: ${orderUrl(o.order_number)}`]])
    assert.ok(m.text.includes(has), `the email shows the ${what}: ${has}`);
  assert.ok(!/payment (was |is )?successful|payment received|total paid|paid online|is paid|has been paid/i.test(m.text), 'a COD order is never described as paid');
  assert.ok(!/payment (was |is )?successful|total paid|paid online/i.test(emailHtml(m.subject, m.text)), 'nor in the HTML part');
  assert.equal(m.idempotencyKey, emailIdempotencyKey('order.placed', o.id, m), 'the provider gets a stable key for this email');

  assert.deepEqual(await log(o.id), [{event: 'order.placed', recipient: 'asha.mail@test.local', subject: m.subject, status: 'sent', error: null}]);
  assert.deepEqual((await orderEmails(admin, o.id)).map(e => [e.event, e.status]), [['order.placed', 'sent']], 'staff see it on the order (Order → Activity)');
  assert.deepEqual(await ledger(), afterOrder, 'sending an email moves no stock');
  const still = await orderRow(o.order_number);
  assert.deepEqual([still.status, still.cod_status, still.payment_status], ['processing', 'to_collect', 'unpaid'], 'and changes nothing on the order');
});

test('the HTML part: the same facts in the KITSYUU layout, escaped, a link to the order, nothing promotional', () => {
  const text = ['Hello <Asha> & Co,', '', 'Thank you. Your order KTS-1 is confirmed.', '', 'Items', '- Shirt, size M × 2: ₹1,998.00', '', 'Subtotal: ₹1,998.00', 'Order total: ₹2,088.00', '',
    'Payment method: Cash on Delivery', 'Amount payable on delivery: ₹2,088.00', '', 'Deliver to', 'Asha', '12 Lotus Street', '', 'Your order: https://store.test/account/orders/KTS-1'].join('\n');
  const html = emailHtml('Your KITSYUU order KTS-1 is confirmed', text);
  assert.ok(html.startsWith('<!doctype html>') && html.includes('name="viewport"') && html.includes('max-width:560px'), 'one fluid column that reads on a phone');
  assert.ok(html.includes('Hello &lt;Asha&gt; &amp; Co,') && !html.includes('<Asha>'), 'everything from the message is escaped');
  assert.ok(html.includes('>Shirt, size M × 2</td>') && html.includes('>₹1,998.00</td>'), 'items with their amounts');
  assert.ok(/Amount payable on delivery<\/td><td[^>]*font:700[^>]*>₹2,088\.00/.test(html), 'the amount payable is emphasised');
  assert.ok(html.includes('<a href="https://store.test/account/orders/KTS-1"') && html.includes('>Your order</a>'), 'a button to the order');
  assert.ok(!/<script|<img|<link|unsubscribe|% off|sale|offer/i.test(html), 'no scripts, remote images, tracking or marketing');
  assert.ok(html.includes('not a marketing message'));
});

// ---------------------------------------------------------------- sent once
test('duplicates: a second call, a refresh, a repeated webhook and five servers at once still send one confirmation', async () => {
  const again = memory();
  assert.deepEqual(await confirm(again, A.order_number), {sent: false, reason: 'duplicate'});
  assert.equal(again.sent.length, 0, 'nothing reached the provider');
  assert.equal((await log(A.id)).length, 1, 'and nothing was added to the log');

  const {o} = await codOrder(ravi, raviAddr, 1);
  B = o;
  const shared = memory();
  const results = await Promise.all(Array.from({length: 5}, () => confirm(shared, o.order_number)));
  assert.equal(results.filter(r => r.sent).length, 1, 'exactly one of five simultaneous sends goes out');
  assert.equal(results.filter(r => !r.sent && r.reason === 'duplicate').length, 4);
  assert.equal(shared.sent.length, 1);
  assert.deepEqual((await log(o.id)).map(l => l.status), ['sent']);
});

// ---------------------------------------------------------------- provider failure: the order stands
test('provider down at checkout: the order is still placed; the failure is logged; a quick second try covers a short outage', async () => {
  const {placed, o} = await codOrder(asha, ashaAddr, 1);
  C = o;
  const off = down();
  // exactly what the checkout action does: place the order, then send; the result of the send is not part of the order
  assert.deepEqual(await sendTransactionalEmail(web, off, 'order.placed', x => orderPlacedMessage(x, o.order_number, {orderUrl: orderUrl(o.order_number)}), {quickTries: FAST}), {sent: false, reason: 'failed'});
  assert.equal(off.calls, 3, 'an unreachable provider is tried three times in one go');
  const kept = await orderRow(placed.orderNumber);
  assert.deepEqual([kept.status, kept.payment_method, kept.cod_status], ['processing', 'cod', 'to_collect'], 'the order is placed all the same');
  const rows = await log(o.id);
  assert.deepEqual(rows.map(r => [r.event, r.status]), [['order.placed', 'failed']], 'one log line per send, not per try');
  assert.match(rows[0].error, /provider unreachable/);

  // a provider that refuses the message itself is not hammered
  const no = refusing();
  assert.deepEqual(await sendTransactionalEmail(web, no, 'order.placed', x => orderPlacedMessage(x, o.order_number, {orderUrl: orderUrl(o.order_number)}), {quickTries: FAST}), {sent: false, reason: 'failed'});
  assert.equal(no.calls, 1, 'a refused message is not tried again at once');

  // a provider that hangs before failing uses up the time a checkout may wait: one try only, the later retry takes over
  const slow = {kind: 'slow', calls: 0, async send() { slow.calls++; await new Promise(r => setTimeout(r, 60)); throw new MailError('Email could not be sent (provider unreachable: TimeoutError).', true); }};
  assert.deepEqual(await sendTransactionalEmail(web, slow, 'order.placed', x => orderPlacedMessage(x, o.order_number, {orderUrl: orderUrl(o.order_number)}), {quickTries: FAST, quickBudgetMs: 50}), {sent: false, reason: 'failed'});
  assert.equal(slow.calls, 1, 'a slow failure is not tried again while the customer waits');

  // a short outage: unavailable twice, then fine → the customer gets the email from the same send
  const blip = flaky(2);
  assert.deepEqual(await sendTransactionalEmail(web, blip, 'order.placed', x => orderPlacedMessage(x, o.order_number, {orderUrl: orderUrl(o.order_number)}), {quickTries: FAST}), {sent: true});
  assert.deepEqual([blip.calls, blip.sent.length], [3, 1]);
  assert.deepEqual((await log(o.id)).map(r => r.status), ['failed', 'failed', 'failed', 'sent']);
  assert.deepEqual(await confirm(memory(), o.order_number), {sent: false, reason: 'duplicate'}, 'and it is not sent again afterwards');
});

// ---------------------------------------------------------------- the later retry
test('retry: a failed confirmation is sent again later, further apart each time, at most five attempts, once', async () => {
  const {o} = await codOrder(ravi, raviAddr, 1);
  D = o;
  const t0 = Date.now(), at = min => new Date(t0 + min * 60_000);
  assert.deepEqual(await sendTransactionalEmail(web, down(), 'order.placed', x => orderPlacedMessage(x, o.order_number, {orderUrl: orderUrl(o.order_number)}), {quickTries: [0]}), {sent: false, reason: 'failed'});

  const console_ = await retryOrderEmails(admin, consoleMailer(() => {}), {storeUrl: STORE, now: at(30)});
  assert.equal(console_.noProvider, true, 'without a real provider there is nothing to send again');

  const early = await retryOrderEmails(admin, memory(), {storeUrl: STORE, now: at(1)});
  assert.equal(early.waiting, 1, `the first retry waits ${EMAIL_RETRY_MINUTES[0]} minutes`); assert.equal(early.sent, 0);

  // still down on every retry: attempts 2, 3, 4 and 5 each wait longer; then it is left as failed
  const still = down();
  const waits = [3, 3 + 11, 3 + 11 + 61, 3 + 11 + 61 + 361];
  for (const [i, min] of waits.entries()) {
    const r = await retryOrderEmails(admin, still, {storeUrl: STORE, now: at(min), quickTries: [0]});
    assert.equal(r.failed, 1, `attempt ${i + 2} is made and fails`);
    if (i < waits.length - 1) assert.equal((await retryOrderEmails(admin, still, {storeUrl: STORE, now: at(min + 1), quickTries: [0]})).waiting, 1, 'and the next one is not due yet');
  }
  assert.equal(still.calls, 4);
  assert.deepEqual((await log(o.id)).map(r => r.status), ['failed', 'failed', 'failed', 'failed', 'failed']);
  const done = await retryOrderEmails(admin, memory(), {storeUrl: STORE, now: at(2000), quickTries: [0]});
  assert.deepEqual([done.gaveUp, done.sent], [1, 0], 'after five attempts it is left as failed (staff see it on the order)');

  // the usual case: the provider is back by the first retry
  const {o: o2} = await codOrder(asha, ashaAddr, 1);
  const t1 = Date.now();
  await sendTransactionalEmail(web, down(), 'order.placed', x => orderPlacedMessage(x, o2.order_number, {orderUrl: orderUrl(o2.order_number)}), {quickTries: [0]});
  const back = memory();
  const r = await retryOrderEmails(admin, back, {storeUrl: STORE, now: new Date(t1 + 3 * 60_000)});
  assert.equal(r.sent, 1);
  assert.equal(back.sent.length, 1);
  assert.equal(back.sent[0].to, 'asha.mail@test.local');
  assert.ok(back.sent[0].text.includes('Payment method: Cash on Delivery') && back.sent[0].text.includes(`Your order: ${orderUrl(o2.order_number)}`), 'the retried email is the same email');
  assert.deepEqual((await log(o2.id)).map(l => l.status), ['failed', 'sent']);
  const again = memory();
  const r2 = await retryOrderEmails(admin, again, {storeUrl: STORE, now: new Date(t1 + 60 * 60_000)});
  assert.deepEqual([r2.sent, again.sent.length], [0, 0], 'a retried email is not retried again');
});

test('retry: a confirmed order whose confirmation was never attempted (the server stopped in between) gets it', async () => {
  // Staged with the owner connection (the apps can only add to the log): order B, placed ten minutes ago, with no attempt on record.
  const [{n: before}] = await q(`select count(*)::int n from notification_log where event = 'order.placed' and status = 'sent'`);
  await q(`update orders set created_at = now() - interval '10 minutes' where id = $1`, [B.id]);
  await q(`delete from notification_log where order_id = $1`, [B.id]);
  const m = memory();
  const r = await retryOrderEmails(admin, m, {storeUrl: STORE});
  assert.equal(r.missing, 1); assert.equal(r.sent, 1);
  assert.deepEqual(m.sent.map(x => x.to), ['ravi.mail@test.local']);
  assert.deepEqual((await log(B.id)).map(l => [l.event, l.status]), [['order.placed', 'sent']]);
  assert.equal((await q(`select count(*)::int n from notification_log where event = 'order.placed' and status = 'sent'`))[0].n, before, 'one confirmation per order again');
  assert.equal((await retryOrderEmails(admin, memory(), {storeUrl: STORE})).missing, 0, 'and only once');
});

test('retry limits: nothing older than 72 hours is sent; a retry triggered several times at once (job + staff) sends once; success ends it', async () => {
  // Staged with the owner connection on order D (whose five attempts above all failed): one failed attempt, 73 hours old.
  const subject = `Your KITSYUU order ${D.order_number} is confirmed`;
  const stage = async hoursAgo => { await q(`delete from notification_log where order_id = $1`, [D.id]);
    await q(`insert into notification_log (event, order_id, recipient, subject, status, error, created_at) values ('order.placed', $1, 'ravi.mail@test.local', $2, 'failed', 'staged', now() - make_interval(hours => $3))`, [D.id, subject, hoursAgo]); };
  await stage(73);
  const old = memory();
  const r1 = await retryOrderEmails(admin, old, {storeUrl: STORE});
  assert.deepEqual([r1.sent, r1.missing, old.sent.length], [0, 0, 0], 'a failure older than 72 hours is not sent again (the customer would get a stale email)');
  assert.deepEqual((await log(D.id)).map(l => l.status), ['failed'], 'and nothing is added to the log');

  // The same failure one hour old, and the retry triggered three times at the same moment.
  await stage(1);
  const shared = memory();
  const runs = await Promise.all([retryOrderEmails(admin, shared, {storeUrl: STORE}), retryOrderEmails(admin, shared, {storeUrl: STORE}), retryOrderEmails(admin, shared, {storeUrl: STORE})]);
  assert.equal(shared.sent.length, 1, 'three simultaneous retry runs send the email once');
  assert.equal(runs.reduce((n, r) => n + r.sent, 0), 1);
  assert.deepEqual((await log(D.id)).map(l => l.status), ['failed', 'sent']);
  for (let i = 0; i < 3; i++) assert.equal((await retryOrderEmails(admin, shared, {storeUrl: STORE, now: new Date(Date.now() + (i + 1) * 3_600_000)})).sent, 0);
  assert.equal(shared.sent.length, 1, 'a delivered email is never sent again, however often and whenever the retry runs');
  assert.deepEqual(await confirm(shared, D.order_number), {sent: false, reason: 'duplicate'}, 'nor by the checkout path');

  // A confirmed order older than 72 hours with no attempt at all is left alone too.
  await q(`delete from notification_log where order_id = $1`, [D.id]);
  await q(`update orders set created_at = now() - interval '80 hours' where id = $1`, [D.id]);
  const late = memory();
  assert.deepEqual([(await retryOrderEmails(admin, late, {storeUrl: STORE})).missing, late.sent.length], [0, 0]);
  await q(`update orders set created_at = now() - interval '10 minutes' where id = $1`, [D.id]);
  assert.equal((await retryOrderEmails(admin, late, {storeUrl: STORE})).missing, 1, 'inside the window it is sent');
});

// ---------------------------------------------------------------- status and tracking emails
test('status emails: off until switched on; shipped and tracking sent once each; a corrected tracking number is a new email', async () => {
  const ship = async trackingNumber => updateOrderStatus(admin, root, {orderId: A.id, toStatus: 'shipped', expectedStatus: 'processing', note: null, carrierCode: 'manual', trackingNumber}, ctx);
  await ship('TRK-1001');
  const m = memory();
  assert.deepEqual(await notifyOrderStatus(admin, m, A.id, 'order.shipped', {storeUrl: STORE}), {sent: false, reason: 'off'}, 'a business decision: off until switched on');
  assert.deepEqual(await notifyOrderTracking(admin, m, A.id, STORE), {sent: false, reason: 'off'});
  assert.equal(m.sent.length, 0);
  assert.deepEqual((await log(A.id)).map(l => l.event), ['order.placed'], 'nothing is logged for an email that is switched off');

  await set('notifications.order_shipped', 'on');
  await set('notifications.order_tracking', 'on');
  assert.deepEqual(await notifyOrderStatus(admin, m, A.id, 'order.shipped', {storeUrl: STORE}), {sent: true});
  assert.match(m.sent[0].text, /has been shipped/); assert.match(m.sent[0].text, /Tracking number: TRK-1001/);
  assert.deepEqual(await notifyOrderStatus(admin, m, A.id, 'order.shipped', {storeUrl: STORE}), {sent: false, reason: 'duplicate'}, 'shipped is said once');
  assert.deepEqual(await notifyOrderStatus(admin, m, A.id, 'order.cancelled', {storeUrl: STORE}), {sent: false, reason: 'off'}, 'each email has its own switch');

  assert.deepEqual(await notifyOrderTracking(admin, m, A.id, STORE), {sent: true});
  assert.equal(m.sent[1].subject, `Tracking for your KITSYUU order ${A.order_number}: TRK-1001`);
  assert.deepEqual(await notifyOrderTracking(admin, m, A.id, STORE), {sent: false, reason: 'duplicate'});
  await updateShipmentTracking(admin, root, {orderId: A.id, carrierCode: 'manual', trackingNumber: 'TRK-2002'}, ctx);
  assert.deepEqual(await notifyOrderTracking(admin, m, A.id, STORE), {sent: true}, 'a corrected tracking number is told to the customer');
  assert.match(m.sent[2].text, /Tracking number: TRK-2002/);
  assert.equal(m.sent.length, 3);
  assert.deepEqual((await log(A.id)).map(l => [l.event, l.status]), [['order.placed', 'sent'], ['order.shipped', 'sent'], ['order.tracking', 'sent'], ['order.tracking', 'sent']]);

  // a failed status email is retried like the confirmation
  await set('notifications.order_shipped', 'on');
  await updateOrderStatus(admin, root, {orderId: C.id, toStatus: 'shipped', expectedStatus: 'processing', note: null, carrierCode: 'manual', trackingNumber: null}, ctx);
  const t = Date.now();
  assert.deepEqual(await notifyOrderStatus(admin, refusing(), C.id, 'order.shipped', {storeUrl: STORE}), {sent: false, reason: 'failed'});
  const back = memory();
  assert.equal((await retryOrderEmails(admin, back, {storeUrl: STORE, now: new Date(t + 3 * 60_000)})).sent, 1);
  assert.equal(back.sent[0].subject, `Your KITSYUU order ${C.order_number} has shipped`);

  await set('notifications.order_shipped', 'off');
  await set('notifications.order_tracking', 'off');
});

test('payment gateway integration points exist and are inert: no switch, nothing sent', async () => {
  for (const e of ['payment.failed', 'payment.pending']) {
    assert.ok(e in EMAIL_EVENTS);
    const m = memory();
    assert.deepEqual(await sendTransactionalEmail(admin, m, e, async () => ({to: 'asha.mail@test.local', subject: 'x', text: 'x', orderId: A.id})), {sent: false, reason: 'off'});
    assert.equal(m.sent.length, 0);
  }
});

// ---------------------------------------------------------------- what an email may contain
test('privacy: an email goes to the order\'s own customer with that order only; no secrets or internal identifiers', async () => {
  const mine = await orderPlacedMessage(web, A.order_number, {orderUrl: orderUrl(A.order_number)});
  const theirs = await orderPlacedMessage(web, B.order_number, {orderUrl: orderUrl(B.order_number)});
  assert.equal(mine.to, 'asha.mail@test.local'); assert.equal(theirs.to, 'ravi.mail@test.local');
  assert.ok(!mine.text.includes('Ravi') && !mine.text.includes('7 Banyan Road') && !mine.text.includes(B.order_number), 'nothing of another customer\'s order');
  assert.ok(!theirs.text.includes('Asha') && !theirs.text.includes('12 Lotus Street') && !theirs.text.includes(A.order_number));
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const m of [mine, theirs]) {
    const all = `${m.subject}\n${m.text}\n${emailHtml(m.subject, m.text)}`;
    assert.ok(!uuid.test(all), 'no internal database identifiers');
    assert.ok(!/password|token|secret|api[_ -]?key|re_[A-Za-z0-9]{8}|razorpay|staff/i.test(all), 'no credentials, gateway details or staff information');
  }
  const urls = mine.text.match(/https?:\/\/\S+/g) ?? [];
  assert.deepEqual(urls, [orderUrl(A.order_number)], 'the only link is the customer\'s own order page (which needs their sign-in)');
  // The log keeps the recipient and subject only: never the body.
  const [cols] = await q(`select string_agg(column_name, ',' order by ordinal_position) c from information_schema.columns where table_name = 'notification_log'`);
  assert.equal(cols.c, 'id,event,order_id,recipient,subject,status,error,created_at');
});

// ---------------------------------------------------------------- the Resend adapter (against a fake API on this machine)
test('Resend: HTML part and idempotency key are sent; the key stays out of errors; unavailable is transient, refused is not', async () => {
  const seen = []; let answer = 200;
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({auth: req.headers.authorization, idem: req.headers['idempotency-key'] ?? null, body: JSON.parse(body)});
    res.writeHead(answer, {'content-type': 'application/json'}); res.end(answer === 200 ? '{"id":"email_test"}' : '{"message":"no"}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const key = 're_TestKey_' + randomBytes(8).toString('hex');
  try {
    const resend = resendMailer({apiKey: key, from: 'KITSYUU <orders@example.com>', apiBase: `http://127.0.0.1:${srv.address().port}`});
    const o = A;
    // the same order email twice (e.g. a retry after a lost answer) carries the same key
    const msg = await orderPlacedMessage(web, o.order_number, {orderUrl: orderUrl(o.order_number)});
    const idem = emailIdempotencyKey('order.placed', o.id, msg);
    await resend.send({...msg, idempotencyKey: idem}); await resend.send({...msg, idempotencyKey: idem});
    assert.equal(seen[0].auth, `Bearer ${key}`);
    assert.deepEqual([seen[0].idem, seen[1].idem], [idem, idem]);
    assert.equal(seen[0].body.text, msg.text);
    assert.ok(seen[0].body.html.startsWith('<!doctype html>') && seen[0].body.html.includes('Amount payable on delivery'), 'the HTML part is made from the same text');
    assert.deepEqual(seen[0].body.to, ['asha.mail@test.local']);
    answer = 503;
    await assert.rejects(resend.send(msg), e => e instanceof MailError && e.transient === true && !e.message.includes(key));
    answer = 429;
    await assert.rejects(resend.send(msg), e => e.transient === true);
    answer = 422;
    await assert.rejects(resend.send(msg), e => e instanceof MailError && e.transient === false && /Resend answered 422/.test(e.message) && !e.message.includes(key));
  } finally { await new Promise(r => srv.close(r)); }
  const dead = resendMailer({apiKey: key, from: 'a@b.co', apiBase: 'http://127.0.0.1:9', timeoutMs: 500});
  await assert.rejects(dead.send({to: 'x@example.com', subject: 's', text: 't'}), e => e.transient === true && /unreachable/.test(e.message) && !e.message.includes(key));
});

test('local verification: MAILER=file writes the text and the HTML to a folder and delivers nothing; console stays the default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsyuu-outbox-'));
  try {
    const m = await orderPlacedMessage(web, A.order_number, {orderUrl: orderUrl(A.order_number)});
    await fileMailer(dir).send(m);
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 2); assert.ok(files[0].endsWith('.html') && files[1].endsWith('.txt'));
    assert.ok(fs.readFileSync(path.join(dir, files[1]), 'utf8').startsWith(`To: asha.mail@test.local\nSubject: ${m.subject}\n\nHello Asha Mail,`));
    assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('Cash on Delivery'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  assert.equal(createMailer('console').kind, 'console');
  assert.throws(() => createMailer('file'), /MAIL_OUTBOX_DIR/);
  assert.throws(() => createMailer('smtp'), /Unknown MAILER/);
});

test('totals: the ledger holds exactly the six units of the five orders; no email moved stock', async () => {
  const [{orders, customers}] = await q(`select (select count(*)::int from orders) orders, (select count(*)::int from customers) customers`);
  assert.deepEqual([orders, customers], [5, 2]);
  const [{units, mismatch}] = await q(`select (select coalesce(sum(stock_qty),0)::int from product_variants) units,
    (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online)))) mismatch`);
  assert.deepEqual([units, mismatch], [1094, 0]);
});
