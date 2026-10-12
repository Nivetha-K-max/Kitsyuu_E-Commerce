/* Customer Management, Phase A (2026-10-10): the customer page's record loaders, against the LOCAL test database only.
   Order pages, payment attempts and refunds, invoices, returns of old orders, support tickets and the emails sent to a
   customer; every loader's own permission; nothing leaks between customers; nothing is written.
   Fixtures: database/test/order-fixtures (asha, ravi; 8 orders) plus rows added here through the owner connection: 60
   older orders of ravi's (so the customer has more than the 50 most recent), returns, refunds, invoices, tickets, the
   email log and one unverified account. Services run as the real kitsyuu_admin role.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/customer-records.test.mjs */
import test from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError, NotFoundError} from '@kitsyuu/contracts';
import {
  CUSTOMER_ORDERS_PAGE_SIZE, customerEmailLog, customerOrdersPage, customerPayments, customerRecordCounts, customerReturnHistory, customerTickets,
  getCustomer, listInvoices,
} from '@kitsyuu/core';
import {createOrderFixtures} from '../../../database/test/order-fixtures.mjs';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const ctx = {ip: '127.0.0.1', userAgent: 'customer-records.test', requestId: 'test'};
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});          // owner connection for setup and assertions
const adminPool = new pg.Pool({connectionString: ADMIN_DATABASE_URL, max: 1}); // raw kitsyuu_admin connection for privilege probes
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const n = async (text, params = []) => (await q(text, params))[0].n;

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const r = await acceptStaffInvite(db, {token, password: 'customer records test passphrase', fullName: role}, ctx);
  return validateStaffSession(db, r.token);
}

const OLD = 60;                                             // ravi's older orders, all placed at the same instant
const SECRET_WORDS = /password_hash|token_hash|passwordHash|tokenHash|"ip"|user_agent|userAgent|"raw"|payload/;
const NOBODY = '00000000-0000-4000-8000-000000000000';
let F, admin, support, accountant, inventory, noCustomers, noOrders, noReturns, asha, ravi, unverified, oldIds, R = {}, counted;
const TABLES = ['orders', 'payments', 'refunds', 'invoices', 'return_requests', 'return_items', 'support_tickets', 'notification_log', 'audit_logs'];
const rowCounts = async () => JSON.stringify(await q(`select ${TABLES.map(t => `(select count(*)::int from ${t}) as ${t}`).join(', ')}`));

test('setup: fixtures, 60 older orders, returns, refunds, invoices, tickets, the email log, staff of each role', async () => {
  F = await createOrderFixtures(KITSYUU_DB_URL);
  [asha, ravi] = [F.customers_.asha, F.customers_.ravi];
  admin = await staff('cr.admin@test.local', 'admin');                  // everything but roles.manage (system.read included)
  support = await staff('cr.support@test.local', 'support');            // customers, orders, returns, support; no billing, finance, system
  accountant = await staff('cr.accounts@test.local', 'accountant');     // customers, orders, billing, finance, returns; no support
  inventory = await staff('cr.inventory@test.local', 'inventory_manager');   // none of these
  // A role that may read every kind of record but not customers (a role of the business's own making; no seeded role is changed).
  const [role] = await q(`insert into roles (code, name, description, is_system) values ('cr_no_customers', 'Records without customers', 'test', false) returning id`);
  await q(`insert into role_permissions (role_id, permission_code) select $1, code from permissions where code in ('orders.read', 'billing.read', 'finance.read', 'returns.read', 'support.read', 'system.read')`, [role.id]);
  noCustomers = await staff('cr.records@test.local', 'cr_no_customers');
  // 2026-10-12: customers.read WITHOUT one record permission each (no seeded role is like this: every seeded role that reads
  // customers also reads orders and returns). Everything else these two hold is the same, so a refusal can only be the missing one.
  const others = ['customers.read', 'billing.read', 'finance.read', 'support.read', 'system.read'];
  for (const [code, perms] of [['cr_no_orders', [...others, 'returns.read']], ['cr_no_returns', [...others, 'orders.read']]]) {
    const [r] = await q(`insert into roles (code, name, description, is_system) values ($1, $1, 'test', false) returning id`, [code]);
    await q(`insert into role_permissions (role_id, permission_code) select $1, code from permissions where code = any($2)`, [r.id, perms]);
  }
  noOrders = await staff('cr.noorders@test.local', 'cr_no_orders');
  noReturns = await staff('cr.noreturns@test.local', 'cr_no_returns');

  // ravi: 60 delivered orders from 2025, all with the same timestamp (the order id must break the tie between pages).
  oldIds = (await q(`insert into orders (order_number, user_id, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at, created_at, updated_at)
    select 'KTS-OLD-' || lpad(g::text, 4, '0'), $1, $1, 'delivered', 'paid', 100000, 100000, $2, '{}', '2025-03-01 10:00+05:30', '2025-03-01 10:00+05:30', '2025-03-01 10:00+05:30'
    from generate_series(1, ${OLD}) g returning id, order_number`, [ravi.id, JSON.stringify({name: ravi.name, email: ravi.email})])).sort((a, b) => a.order_number.localeCompare(b.order_number));
  const old = i => oldIds[i - 1].id;
  // The orders that get a return below are the oldest of all, so they are certainly outside the 50 most recent.
  await q(`update orders set created_at = '2025-02-01 10:00+05:30' where order_number in ('KTS-OLD-0001', 'KTS-OLD-0003')`);
  const [v] = await q(`select v.id, v.sku, v.size, p.id as product_id, p.name from product_variants v join products p on p.id = v.product_id order by p.id, v.sort_order limit 1`);
  const line = async orderId => (await q(`insert into order_items (order_id, product_id, variant_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, $2, $3, $4, $5, $6, 50000, 2, 100000) returning id`,
    [orderId, v.product_id, v.id, v.sku, v.name, v.size]))[0].id;
  const payment = async (orderId, ref, status, extra = {}) => (await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, method, failure_reason, raw, captured_at, created_at)
    values ($1, 'razorpay', $2, 100000, $3, 'upi', $4, '{"secret":"provider-payload"}', $5, $6) returning id`,
    [orderId, ref, status, extra.reason ?? null, status === 'captured' ? (extra.at ?? '2025-03-01 10:05+05:30') : null, extra.at ?? '2025-03-01 10:05+05:30']))[0].id;

  // Order 1 (the oldest of 63): paid, returned, refunded through the return.
  const pay1 = await payment(old(1), 'pay_OLD0001', 'captured');
  const item1 = await line(old(1));
  [R.old] = await q(`insert into return_requests (order_id, customer_id, status, resolution, reason_code, refund_amount_paise, requested_at) values ($1, $2, 'refunded', 'refund', 'size_fit', 50000, '2025-03-10 10:00+05:30') returning id, number`, [old(1), ravi.id]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [R.old.id, item1]);
  await q(`insert into refunds (payment_id, order_id, return_id, amount_paise, reason, status, method, reference, processed_at, created_at) values ($1, $2, $3, 50000, 'Return refund', 'processed', 'manual', 'UTR-OLD-1', '2025-03-12 10:00+05:30', '2025-03-11 10:00+05:30')`, [pay1, old(1), R.old.id]);
  // Order 2: a failed attempt, then a captured one (two payment rows for one order).
  await payment(old(2), 'pay_OLD0002_FAIL', 'failed', {reason: 'Declined by bank', at: '2025-03-01 10:01+05:30'});
  await payment(old(2), 'pay_OLD0002_OK', 'captured', {at: '2025-03-01 10:02+05:30'});
  // Order 3: a return that names no customer (opened on an order from before customer accounts); it still belongs to ravi's order.
  const item3 = await line(old(3));
  [R.unnamed] = await q(`insert into return_requests (order_id, customer_id, status, reason_code, requested_at) values ($1, null, 'requested', 'damaged', '2025-03-15 10:00+05:30') returning id, number`, [old(3)]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 2)`, [R.unnamed.id, item3]);
  // A refund with no return: recorded on a fixture order of ravi's (KTS-TEST-0005), still waiting to be paid out.
  const [p5] = await q(`select id, order_id from payments where provider_payment_id = 'pay_TEST0005'`);
  await q(`insert into refunds (payment_id, order_id, amount_paise, reason, status) values ($1, $2, 10000, 'Goodwill, no return', 'requested')`, [p5.id, p5.order_id]);
  // asha: a return of her own (must never appear under ravi).
  const [a2] = await q(`select o.id as order_id, (select id from order_items i where i.order_id = o.id order by name limit 1) as item from orders o where order_number = 'KTS-TEST-0002'`);
  [R.asha] = await q(`insert into return_requests (order_id, customer_id, status, reason_code) values ($1, $2, 'requested', 'other') returning id, number`, [a2.order_id, asha.id]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [R.asha.id, a2.item]);

  // Invoices: the fixtures issue one to asha (KTS-TEST-0002). Here: one void for asha, one issued to ravi.
  await q(`insert into invoices (invoice_number, status, order_id, customer_id, financial_year, issued_at, subtotal_paise, tax_paise, total_paise, prices_include_tax, voided_at, void_reason, notes)
    values ('KTS/25-26/90001', 'void', $1, $2, '2025-26', '2026-01-05 10:00+05:30', 1000, 0, 1000, true, now(), 'Issued in error', 'internal finance remark'),
           ('KTS/24-25/90002', 'issued', $3, $4, '2024-25', '2025-03-02 10:00+05:30', 100000, 0, 100000, true, null, null, 'internal finance remark')`, [a2.order_id, asha.id, old(1), ravi.id]);

  // Tickets: one of ravi's account, one opened by staff for the same address with no account link.
  await q(`insert into support_tickets (customer_id, contact_email, subject, category_code) values ($1, $2, 'Where is my order?', 'order'), (null, $2, 'Phone call, no account link', 'general'), ($3, $4, 'Asha asks', 'general')`,
    [ravi.id, ravi.email, asha.id, asha.email]);

  // An account whose email was never verified, and the email log.
  [unverified] = await q(`insert into customers (email, full_name) values ('unverified.cr@test.local', 'Not Verified') returning id, email`);
  const [r4] = await q(`select id from orders where order_number = 'KTS-TEST-0004'`);
  const log = (event, orderId, recipient, status, at = 'now') => q(`insert into notification_log (event, order_id, recipient, subject, status, error, created_at) values ($1, $2, $3, 'SUBJECT-NOT-SHOWN', $4, $5, $6::timestamptz)`,
    [event, orderId, recipient, status, status === 'failed' ? 'PROVIDER-ANSWER-NOT-SHOWN' : null, at === 'now' ? new Date().toISOString() : at]);
  await log('order.placed', r4.id, ravi.email, 'sent');                                   // ravi's order
  await log('order.shipped', r4.id, 'gift.recipient@test.local', 'failed');               // ravi's order, another contact address: still his order
  await log('order.placed', a2.order_id, asha.email, 'sent');                             // asha's order
  await log('support.reply', null, ` ${ravi.email.toUpperCase()} `, 'sent');              // no order, ravi's verified address, after he joined
  await log('cart.reminder', null, ravi.email, 'sent', '2020-01-01 10:00+05:30');         // no order, before the account existed
  await log('cart.reminder', null, asha.email, 'sent');                                   // no order, asha's address
  await log('cart.auto_reminder', null, unverified.email, 'sent');                        // no order, an unverified address

  // 2026-10-12: an order of asha's from before customer accounts (it names only the old user id), and a walk-in counter sale
  // that names nobody, with a payment, a refund, a return and an email of its own (the email even went to ravi's address).
  const [legacy] = await q(`insert into orders (order_number, user_id, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at, created_at, updated_at)
    values ('KTS-LEGACY-0001', $1, null, 'delivered', 'paid', 100000, 100000, $2, '{}', '2025-01-05 10:00+05:30', '2025-01-05 10:00+05:30', '2025-01-05 10:00+05:30') returning id`, [asha.id, JSON.stringify({name: asha.name, email: asha.email})]);
  await payment(legacy.id, 'pay_LEGACY0001', 'captured', {at: '2025-01-05 10:05+05:30'});
  const [walkin] = await q(`insert into orders (order_number, user_id, customer_id, channel, location_id, status, payment_status, payment_method, subtotal_paise, total_paise, contact, shipping_address, paid_at)
    values ('KTS-WALKIN-0001', null, null, 'retail', (select id from locations order by is_online desc limit 1), 'delivered', 'paid', 'cash', 100000, 100000, '{"name":"Walk-in customer"}', '{}', now()) returning id`);
  const payW = await payment(walkin.id, 'pay_WALKIN0001', 'captured', {at: new Date().toISOString()});
  const itemW = await line(walkin.id);
  [R.walkin] = await q(`insert into return_requests (order_id, customer_id, status, reason_code) values ($1, null, 'requested', 'other') returning id, number`, [walkin.id]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [R.walkin.id, itemW]);
  await q(`insert into refunds (payment_id, order_id, return_id, amount_paise, reason, status) values ($1, $2, $3, 100000, 'Walk-in refund', 'requested')`, [payW, walkin.id, R.walkin.id]);
  await log('order.placed', walkin.id, ravi.email, 'sent');
  counted = await rowCounts();
});

// ---------------------------------------------------------------- orders: pages
test('orders: server-side pages of 25, newest first with the order id breaking ties; every order once; bad page numbers are page 1', async () => {
  const want = (await q(`select order_number from orders where customer_id = $1 order by created_at desc, id desc`, [ravi.id])).map(r => r.order_number);
  assert.equal(want.length, 3 + OLD);
  const pages = [];
  for (const page of [1, 2, 3]) pages.push(await customerOrdersPage(db, support, ravi.id, {page}));
  assert.deepEqual(pages.map(p => [p.page, p.rows.length, p.hasNext]), [[1, 25, true], [2, 25, true], [3, 13, false]]);
  assert.equal(pages[0].pageSize, CUSTOMER_ORDERS_PAGE_SIZE);
  assert.deepEqual(pages.flatMap(p => p.rows.map(r => r.order_number)), want, 'the pages, in order, are exactly the customer\'s orders, each once');
  assert.deepEqual((await customerOrdersPage(db, support, ravi.id, {page: 2})).rows.map(r => r.id), pages[1].rows.map(r => r.id), 'the same page twice is the same rows');
  const past = await customerOrdersPage(db, support, ravi.id, {page: 4});
  assert.deepEqual([past.rows.length, past.hasNext, past.page], [0, false, 4], 'a page past the end is empty, not an error');
  for (const bad of [0, -3, 1.5, NaN, '2', null, undefined])
    assert.deepEqual((await customerOrdersPage(db, support, ravi.id, {page: bad})).rows.map(r => r.id), pages[0].rows.map(r => r.id), `page ${String(bad)} is read as page 1`);
  assert.equal((await customerOrdersPage(db, support, ravi.id, {page: 1e9})).page, 10_000, 'the page number is capped');
  // Each row carries how it is paid and its packing state; nothing of another customer.
  const first = pages[0].rows[0];
  assert.deepEqual(Object.keys(first).sort(), ['channel', 'cod_status', 'created_at', 'currency', 'id', 'order_number', 'packing_state', 'paid_at', 'payment_method', 'payment_status', 'pos_number', 'status', 'total_paise']);
  const ashaOrders = await customerOrdersPage(db, support, asha.id);
  assert.equal(ashaOrders.rows.length, 6, 'her five fixture orders and the one from before customer accounts');
  assert.ok(ashaOrders.rows.every(r => !want.includes(r.order_number)), 'asha\'s page has none of ravi\'s orders');
  assert.equal((await customerOrdersPage(db, support, unverified.id)).rows.length, 0, 'a customer without orders: an empty first page');
});

test('getCustomer: reads only the parts asked for; the header figures are the true counts', async () => {
  const all = await getCustomer(db, admin, ravi.id);
  assert.equal(all.summary.ordersCount, 3 + OLD, 'the true number of orders');
  assert.equal(all.orders.length, 50, 'the overview and timeline use the 50 most recent');
  assert.ok('payment_method' in all.orders[0] && 'packing_state' in all.orders[0] && 'paid_at' in all.orders[0]);
  assert.ok(all.audit !== undefined);
  const none = await getCustomer(db, admin, ravi.id, {parts: []});
  assert.deepEqual([none.orders.length, none.addresses.length, none.sessions.length, none.loginAttempts.length, none.audit], [0, 0, 0, 0, undefined]);
  assert.deepEqual([none.customer.email, none.summary.ordersCount], [ravi.email, 3 + OLD]);
  assert.equal((await getCustomer(db, admin, ravi.id, {parts: ['orders']})).orders.length, 50);
});

// ---------------------------------------------------------------- payments
test('payments: every attempt and every refund of the customer\'s orders, one row each, with or without a return', async () => {
  const p = await customerPayments(db, accountant, ravi.id);
  const refs = p.attempts.map(a => a.provider_payment_id);
  assert.deepEqual([...refs].sort(), ['pay_OLD0001', 'pay_OLD0002_FAIL', 'pay_OLD0002_OK', 'pay_TEST0004', 'pay_TEST0005'], 'ravi\'s five attempts and nobody else\'s');
  assert.equal(new Set(p.attempts.map(a => a.id)).size, p.attempts.length, 'no attempt twice');
  const two = p.attempts.filter(a => a.order_number === 'KTS-OLD-0002');
  assert.deepEqual(two.map(a => [a.provider_payment_id, a.status, a.failure_reason]), [['pay_OLD0002_OK', 'captured', null], ['pay_OLD0002_FAIL', 'failed', 'Declined by bank']], 'two attempts of one order, newest first');
  assert.deepEqual(p.attempts.map(a => a.id), (await q(`select p.id from payments p join orders o on o.id = p.order_id where o.customer_id = $1 order by p.created_at desc, p.id desc`, [ravi.id])).map(r => r.id));
  assert.ok(p.attempts.every(a => a.order_id && a.amount_paise > 0 && a.currency === 'INR'));
  // Refunds: one made through a return, one with no return at all. One row each (the order of the first has a return AND a payment).
  assert.equal(p.refunds.length, 2);
  const viaReturn = p.refunds.find(r => r.return_id), plain = p.refunds.find(r => !r.return_id);
  assert.deepEqual([viaReturn.order_number, viaReturn.return_number, viaReturn.status, viaReturn.method, viaReturn.reference, viaReturn.amount_paise], ['KTS-OLD-0001', R.old.number, 'processed', 'manual', 'UTR-OLD-1', 50000]);
  assert.deepEqual([plain.order_number, plain.return_number, plain.status, plain.amount_paise, plain.reason], ['KTS-TEST-0005', null, 'requested', 10000, 'Goodwill, no return'], 'a refund not tied to a return is listed, and no return is invented for it');
  assert.deepEqual([p.attemptsMore, p.refundsMore], [false, false]);
  // asha: her own attempts only; no refunds.
  const a = await customerPayments(db, accountant, asha.id);
  assert.ok(a.attempts.length > 0 && a.attempts.every(x => !refs.includes(x.provider_payment_id)));
  assert.equal(a.refunds.length, 0);
  assert.doesNotMatch(JSON.stringify([p, a]), SECRET_WORDS, 'nothing of the provider payload');
  assert.doesNotMatch(JSON.stringify([p, a]), /provider-payload/);
});

// ---------------------------------------------------------------- invoices
test('invoices: issued and void invoices of the customer, through the Finance service; finance.read required', async () => {
  const mine = await listInvoices(db, accountant, {customerId: asha.id, status: 'all', page: 1});
  assert.deepEqual(mine.rows.map(i => i.status).sort(), ['issued', 'void'], 'asha: the fixture invoice and the void one');
  assert.ok(mine.rows.every(i => i.order_number === 'KTS-TEST-0002' && i.currency === 'INR' && i.invoice_number));
  assert.deepEqual((await listInvoices(db, accountant, {customerId: asha.id, status: 'void', page: 1})).rows.map(i => i.invoice_number), ['KTS/25-26/90001']);
  const his = await listInvoices(db, accountant, {customerId: ravi.id, status: 'all', page: 1});
  assert.deepEqual(his.rows.map(i => [i.invoice_number, i.order_number, i.total_paise]), [['KTS/24-25/90002', 'KTS-OLD-0001', 100000]], 'ravi: only his own');
  assert.equal((await listInvoices(db, accountant, {customerId: unverified.id, status: 'all', page: 1})).rows.length, 0);
  assert.equal((await listInvoices(db, accountant, {status: 'all', page: 1})).rows.length, 3, 'without a customer the Finance list is unchanged: every invoice');
  assert.doesNotMatch(JSON.stringify([mine, his]), /internal finance remark|Issued in error|seller_details|billing_address/, 'no finance notes or addresses');
  // Customer staff without finance.read get nothing, whatever they call.
  await assert.rejects(listInvoices(db, support, {customerId: asha.id, status: 'all', page: 1}), ForbiddenError);
  await assert.rejects(listInvoices(db, inventory, {customerId: asha.id, status: 'all', page: 1}), ForbiddenError);
  await assert.rejects(listInvoices(db, noCustomers, {customerId: asha.id, status: 'all', page: 1}), ForbiddenError, 'finance.read alone does not open a customer\'s invoices');
  assert.equal((await listInvoices(db, noCustomers, {status: 'all', page: 1})).rows.length, 3, 'finance.read still opens the Finance list');
});

// ---------------------------------------------------------------- returns
test('returns: every return of the customer, however old the order; items and refunds in the same read; never another customer\'s', async () => {
  const recent = (await getCustomer(db, admin, ravi.id)).orders.map(o => o.order_number);
  assert.ok(!recent.includes('KTS-OLD-0001') && !recent.includes('KTS-OLD-0003'), 'the returned orders are not among the 50 most recent');
  const r = await customerReturnHistory(db, support, ravi.id);
  assert.deepEqual(r.rows.map(x => x.number), [R.unnamed.number, R.old.number], 'both returns, newest first');
  assert.equal(r.more, false);
  const old = r.rows.find(x => x.number === R.old.number), unnamed = r.rows.find(x => x.number === R.unnamed.number);
  assert.deepEqual([old.order_number, old.status, old.resolution, old.reason, old.refund_amount_paise], ['KTS-OLD-0001', 'refunded', 'refund', 'Size or fit', 50000]);
  assert.deepEqual(old.items.map(i => [i.qty, i.size !== undefined, typeof i.name]), [[1, true, 'string']]);
  assert.deepEqual(old.refunds.map(f => [f.amount_paise, f.status, f.method]), [[50000, 'processed', 'manual']], 'the refund of the return (refunds.return_id)');
  assert.deepEqual([unnamed.order_number, unnamed.items.map(i => i.qty), unnamed.refunds.length], ['KTS-OLD-0003', [2], 0], 'a return that names no customer is found through his order');
  assert.ok(r.rows.every(x => x.refunds.every(f => f.amount_paise !== 10000)), 'the refund without a return is not attached to any return');
  const light = await customerReturnHistory(db, support, ravi.id, {lines: false});
  assert.deepEqual([light.rows.map(x => x.number), light.rows.every(x => x.items.length === 0 && x.refunds.length === 0)], [[R.unnamed.number, R.old.number], true]);
  assert.deepEqual((await customerReturnHistory(db, support, asha.id)).rows.map(x => x.number), [R.asha.number]);
  assert.equal((await customerReturnHistory(db, support, unverified.id)).rows.length, 0);
  assert.deepEqual(await customerRecordCounts(db, support, ravi.id), {returns: 2, tickets: 1});
  assert.deepEqual(await customerRecordCounts(db, accountant, ravi.id), {returns: 2, tickets: null}, 'no support.read: no ticket count');
  assert.deepEqual(await customerRecordCounts(db, support, asha.id), {returns: 1, tickets: 1});
});

// ---------------------------------------------------------------- support
test('support: the tickets linked to the customer\'s account only', async () => {
  assert.deepEqual((await customerTickets(db, support, ravi.id)).map(t => t.subject), ['Where is my order?'], 'the ticket with no account link is not guessed from its address');
  assert.deepEqual((await customerTickets(db, support, asha.id)).map(t => t.subject), ['Asha asks']);
  await assert.rejects(customerTickets(db, accountant, ravi.id), ForbiddenError, 'support.read required');
});

// ---------------------------------------------------------------- emails
test('emails: only those tied to the customer for certain; others need the outbox permission and a verified address', async () => {
  const forSupport = await customerEmailLog(db, support, ravi.id);                // orders.read, no system.read
  assert.deepEqual(forSupport.rows.map(m => [m.event, m.recipient, m.status, m.order_number]).sort(),
    [['order.placed', ravi.email, 'sent', 'KTS-TEST-0004'], ['order.shipped', 'gift.recipient@test.local', 'failed', 'KTS-TEST-0004']], 'the emails of his orders, sent or failed');
  assert.equal(forSupport.direct, false);
  const forAdmin = await customerEmailLog(db, admin, ravi.id);                    // system.read as well
  assert.equal(forAdmin.direct, true);
  assert.deepEqual(forAdmin.rows.map(m => m.event).sort(), ['order.placed', 'order.shipped', 'support.reply'], 'plus the one sent to his verified address after he joined; not the one from before the account');
  assert.equal(forAdmin.rows.find(m => m.event === 'support.reply').order_number, null);
  // Nothing of asha's in ravi's list, and the other way round.
  assert.ok(forAdmin.rows.every(m => m.recipient.trim().toLowerCase() !== asha.email));
  const hers = await customerEmailLog(db, admin, asha.id);
  assert.deepEqual(hers.rows.map(m => [m.event, m.order_number]).sort(), [['cart.reminder', null], ['order.placed', 'KTS-TEST-0002']]);
  assert.ok(hers.rows.every(m => m.recipient.trim().toLowerCase() !== ravi.email && m.recipient !== 'gift.recipient@test.local'));
  // An unverified address proves nothing: even the outbox permission lists nothing for it.
  const nv = await customerEmailLog(db, admin, unverified.id);
  assert.deepEqual([nv.rows.length, nv.direct], [0, false]);
  // What was tried and the result only.
  assert.deepEqual(Object.keys(forAdmin.rows[0]).sort(), ['created_at', 'event', 'id', 'order_id', 'order_number', 'recipient', 'status']);
  assert.doesNotMatch(JSON.stringify([forSupport, forAdmin, hers]), /SUBJECT-NOT-SHOWN|PROVIDER-ANSWER-NOT-SHOWN|"subject"|"error"/, 'no subject, message or provider answer');
});

// ---------------------------------------------------------------- permissions
test('every loader checks its own permission and the customer, whoever calls it', async () => {
  const loaders = {
    customerOrdersPage: a => customerOrdersPage(db, a, ravi.id), customerPayments: a => customerPayments(db, a, ravi.id),
    customerReturnHistory: a => customerReturnHistory(db, a, ravi.id), customerTickets: a => customerTickets(db, a, ravi.id),
    customerEmailLog: a => customerEmailLog(db, a, ravi.id), customerRecordCounts: a => customerRecordCounts(db, a, ravi.id),
    listInvoices: a => listInvoices(db, a, {customerId: ravi.id, status: 'all', page: 1}),
  };
  // Holding every record permission is not enough without customers.read; holding none of them is refused too.
  for (const [name, run] of Object.entries(loaders)) {
    await assert.rejects(run(noCustomers), ForbiddenError, `${name}: customers.read required`);
    await assert.rejects(run(inventory), ForbiddenError, `${name}: refused for staff with no customer permission`);
  }
  // customers.read is not enough for a kind of record the staff member may not see.
  await assert.rejects(customerPayments(db, support, ravi.id), ForbiddenError, 'billing.read');
  await assert.rejects(customerTickets(db, accountant, ravi.id), ForbiddenError, 'support.read');
  for (const [name, run] of Object.entries(loaders)) await run(admin).then(() => {}, e => assert.fail(`${name} for admin: ${e.message}`));
  // An id that is not a customer, or not an id: not found, never a database error.
  for (const bad of [NOBODY, 'not-an-id', "' or 1=1 --", '']) {
    await assert.rejects(customerOrdersPage(db, admin, bad), NotFoundError);
    await assert.rejects(customerPayments(db, admin, bad), NotFoundError);
    await assert.rejects(customerReturnHistory(db, admin, bad), NotFoundError);
    await assert.rejects(customerTickets(db, admin, bad), NotFoundError);
    await assert.rejects(customerEmailLog(db, admin, bad), NotFoundError);
    await assert.rejects(customerRecordCounts(db, admin, bad), NotFoundError);
    await assert.rejects(listInvoices(db, admin, {customerId: bad, status: 'all', page: 1}), NotFoundError);
  }
});

test('isolation: an order from before customer accounts belongs to its customer; a walk-in sale and everything about it belongs to nobody', async () => {
  // asha's old order is found through the old user id (the "legacy" half of the ownership rule), with its payment.
  const hers = await customerOrdersPage(db, admin, asha.id);
  assert.ok(hers.rows.some(o => o.order_number === 'KTS-LEGACY-0001'));
  assert.equal((await getCustomer(db, admin, asha.id)).summary.ordersCount, 6);
  assert.ok((await customerPayments(db, admin, asha.id)).attempts.some(a => a.provider_payment_id === 'pay_LEGACY0001' && a.order_number === 'KTS-LEGACY-0001'));
  assert.ok(!(await customerPayments(db, admin, ravi.id)).attempts.some(a => a.provider_payment_id === 'pay_LEGACY0001'), 'and under nobody else');
  // The walk-in sale exists with a payment, refund, return and email, and no customer's records include any of them, for the
  // staff member who may see the most (admin: every record permission and the email outbox).
  assert.equal(await n(`select count(*)::int n from orders o join payments p on p.order_id = o.id join refunds f on f.order_id = o.id join return_requests r on r.order_id = o.id
    join notification_log l on l.order_id = o.id where o.order_number = 'KTS-WALKIN-0001' and o.customer_id is null and o.user_id is null`), 1, 'the walk-in fixture is complete');
  for (const c of [asha, ravi, unverified]) {
    const orders = [];
    for (let page = 1; ; page++) { const p = await customerOrdersPage(db, admin, c.id, {page}); orders.push(...p.rows); if (!p.hasNext) break; }
    const pay = await customerPayments(db, admin, c.id), ret = await customerReturnHistory(db, admin, c.id), mail = await customerEmailLog(db, admin, c.id);
    const all = JSON.stringify([orders, pay, ret, mail, await getCustomer(db, admin, c.id), await listInvoices(db, admin, {customerId: c.id, status: 'all', page: 1})]);
    assert.doesNotMatch(all, /KTS-WALKIN-0001|pay_WALKIN0001|Walk-in refund/, `${c.email}: nothing of the walk-in sale`);
    assert.ok(!all.includes(R.walkin.number) && !ret.rows.some(r => r.id === R.walkin.id), `${c.email}: not its return`);
  }
  // Its email went to ravi's own verified address, and still is not his: it is about an order that is not his.
  const his = await customerEmailLog(db, admin, ravi.id);
  assert.ok(his.direct && his.rows.every(m => m.order_number !== 'KTS-WALKIN-0001') && his.rows.length === 3);
  assert.deepEqual(await customerRecordCounts(db, admin, ravi.id), {returns: 2, tickets: 1}, 'the counts do not include it either');
});

test('customers.read is not enough: the order, email and return loaders each refuse staff who lack their own record permission', async () => {
  const has = (a, code) => a.permissions instanceof Set ? a.permissions.has(code) : a.permissions.includes(code);
  assert.deepEqual(['customers.read', 'orders.read', 'returns.read'].map(c => has(noOrders, c)), [true, false, true], 'the role under test: customers and returns, no orders');
  assert.deepEqual(['customers.read', 'orders.read', 'returns.read'].map(c => has(noReturns, c)), [true, true, false], 'the role under test: customers and orders, no returns');
  // No orders.read: no order pages and no emails (not even with system.read, which this role holds); returns still open.
  await assert.rejects(customerOrdersPage(db, noOrders, ravi.id), ForbiddenError, 'order loader without orders.read');
  await assert.rejects(customerOrdersPage(db, noOrders, ravi.id, {page: 2}), ForbiddenError);
  await assert.rejects(customerEmailLog(db, noOrders, ravi.id), ForbiddenError, 'email loader without orders.read');
  assert.equal((await customerReturnHistory(db, noOrders, ravi.id)).rows.length, 2, 'the same person may still read returns: the refusal above is orders.read alone');
  assert.ok((await getCustomer(db, noOrders, ravi.id)).customer.email, 'and the customer record itself');
  // No returns.read: no return history (with or without lines) and no return count; orders and emails still open.
  await assert.rejects(customerReturnHistory(db, noReturns, ravi.id), ForbiddenError, 'return loader without returns.read');
  await assert.rejects(customerReturnHistory(db, noReturns, ravi.id, {lines: false}), ForbiddenError);
  assert.deepEqual(await customerRecordCounts(db, noReturns, ravi.id), {returns: null, tickets: 1}, 'no return count either');
  assert.equal((await customerOrdersPage(db, noReturns, ravi.id)).rows.length, CUSTOMER_ORDERS_PAGE_SIZE, 'the same person may still read orders');
  assert.ok((await customerEmailLog(db, noReturns, ravi.id)).rows.length >= 2, 'and the emails of those orders');
  // The customer record itself gives staff without orders.read each order's number, status and total (as always), but not how
  // it is paid or packed; with orders.read those are there.
  const plain = (await getCustomer(db, noOrders, ravi.id)).orders, full = (await getCustomer(db, noReturns, ravi.id)).orders;
  assert.ok(plain.length === 50 && plain.every(o => o.order_number && o.status && o.total_paise > 0));
  assert.ok(plain.every(o => o.payment_method === null && o.cod_status === null && o.paid_at === null && o.packing_state === null), 'no payment or packing detail without orders.read');
  assert.ok(full.every(o => o.payment_method !== null) && full.some(o => o.paid_at !== null), 'with orders.read the detail is there');
  // A refusal comes before the customer is looked at: the answer is the same for an id that is not a customer.
  await assert.rejects(customerOrdersPage(db, noOrders, NOBODY), ForbiddenError);
  await assert.rejects(customerEmailLog(db, noOrders, NOBODY), ForbiddenError);
  await assert.rejects(customerReturnHistory(db, noReturns, NOBODY), ForbiddenError);
});

// ---------------------------------------------------------------- safety
test('safety: no secrets in any result, the admin role still cannot read them, and nothing was written', async () => {
  await q(`insert into customer_sessions (customer_id, token_hash, idle_expires_at, expires_at, ip, user_agent) values ($1, sha256('cr-session'::bytea), now() + interval '1 day', now() + interval '30 days', '10.7.7.7', 'secret-agent-cr')`, [ravi.id]);
  const everything = JSON.stringify([await getCustomer(db, admin, ravi.id), await customerOrdersPage(db, admin, ravi.id), await customerPayments(db, admin, ravi.id),
    await customerReturnHistory(db, admin, ravi.id), await customerTickets(db, admin, ravi.id), await customerEmailLog(db, admin, ravi.id),
    await listInvoices(db, admin, {customerId: ravi.id, status: 'all', page: 1})]);
  assert.doesNotMatch(everything, SECRET_WORDS);
  assert.doesNotMatch(everything, /10\.7\.7\.7|secret-agent-cr|\$argon2|provider-payload/);
  for (const text of [`select password_hash from customers limit 1`, `select token_hash from customer_sessions limit 1`, `select * from customers limit 1`])
    await assert.rejects(adminPool.query(text), e => e.code === '42501', text);
  assert.equal(await rowCounts(), counted, 'the loaders are read only: no row added to any table they read, and no audit row');
  assert.equal(await n(`select count(*)::int n from orders where customer_id is null and user_id is null`), 1, 'the walk-in sale still names nobody: no loader adopted it or created another');
});

test.after(async () => { await Promise.all([db.destroy(), owner.destroy(), pool.end(), adminPool.end()]); });
