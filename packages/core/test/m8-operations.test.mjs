/* M8 integration tests: customers, payment operations, settings, fulfilment, order export and dashboard figures, against
   the LOCAL test database only (with database/test/order-fixtures). Services run as the real kitsyuu_admin role; setup
   and assertions use the owner connection. Also re-checks the M7 order rules that M8 must not change. */
import test from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, DomainError, ForbiddenError, NotFoundError, ORDER_TRANSITIONS_BY_ACTOR, customerListQuery, orderListQuery, packingStateInput,
  paymentEventListQuery, paymentListQuery, recordManualRefundInput, setCustomerStatusInput, settingUpdateInput, shipmentTrackingInput,
  updateCustomerContactInput, updateOrderStatusInput,
} from '@kitsyuu/contracts';
import {
  exportOrders, getCustomer, getDashboard, getOrder, getPaymentExceptions, listCustomers, listPaymentEvents, listPayments, listSettings,
  reconcileOrderPayments, recordManualRefund, setCustomerStatus, setPackingState, updateCustomerContact, updateOrderStatus, updateSetting,
  updateShipmentTracking,
} from '@kitsyuu/core';
import {createOrderFixtures} from '../../../database/test/order-fixtures.mjs';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const ctx = {ip: '127.0.0.1', userAgent: 'm8.test', requestId: 'test'};
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
  const r = await acceptStaffInvite(db, {token, password: 'm8 operations test passphrase', fullName: role}, ctx);
  return validateStaffSession(db, r.token);
}

let F, admin, manager, sales, support, accountant, asha, ravi;
const audits = (action, entityId) => n(`select count(*)::int n from audit_logs where action = $1 and entity_id = $2`, [action, entityId]);
const ledgerAgrees = async () => (await n(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`)) === 0;
const status = (num, toStatus, expectedStatus, extra = {}) => updateOrderStatusInput.parse({orderId: F.ids[num], toStatus, expectedStatus, note: '', ...extra});
const SECRET_WORDS = /password_hash|token_hash|passwordHash|tokenHash|"ip"|user_agent|userAgent/;

test('setup: fixtures, staff of every relevant role, a live customer session', async () => {
  F = await createOrderFixtures(KITSYUU_DB_URL);
  assert.deepEqual([F.orders, F.customers], [8, 2]);
  admin = await staff('m8.admin@test.local', 'admin');                 // everything but roles.manage
  manager = await staff('m8.manager@test.local', 'manager');           // settings.read, billing.read, customers.read; no manage
  sales = await staff('m8.sales@test.local', 'sales');                 // orders.update_status, customers.read
  support = await staff('m8.support@test.local', 'support');           // read-only orders + customers
  accountant = await staff('m8.accounts@test.local', 'accountant');    // billing.read/manage, refunds.create
  [asha, ravi] = [F.customers_.asha.id, F.customers_.ravi.id];
  await q(`insert into customer_sessions (customer_id, token_hash, idle_expires_at, expires_at, ip, user_agent)
    values ($1, sha256('m8-session-a'::bytea), now() + interval '1 day', now() + interval '30 days', '10.0.0.9', 'secret-agent'),
           ($1, sha256('m8-session-b'::bytea), now() + interval '1 day', now() + interval '30 days', null, null)`, [ravi]);
});

// ---------------------------------------------------------------- security (migration 1800)
test('security: the admin database role cannot read customer secrets', async () => {
  const denied = async (text, params = []) => {
    await assert.rejects(adminPool.query(text, params), e => e.code === '42501', text);
  };
  await denied(`select password_hash from customers limit 1`);
  await denied(`select * from customers limit 1`);
  await denied(`select token_hash from customer_sessions limit 1`);
  await denied(`update customer_sessions set expires_at = now()`);
  const ok = (await adminPool.query(`select count(*)::int n, count(email)::int e from customers`)).rows[0];
  assert.deepEqual([ok.n, ok.e], [2, 2], 'safe columns and count(*) stay readable');
  assert.equal((await adminPool.query(`select count(*)::int n from auth_tokens where customer_id is not null`)).rows[0].n, 0, 'customer link tokens are invisible');
  assert.equal((await adminPool.query(`select count(*)::int n from auth_tokens`)).rows[0].n,
    await n(`select count(*)::int n from auth_tokens where staff_user_id is not null`), 'staff tokens still visible (invites, resets)');
});

// ---------------------------------------------------------------- customers
test('customers: list with counts, lifetime value, search and filters', async () => {
  const all = await listCustomers(db, support, customerListQuery.parse({}));
  assert.equal(all.rows.length, 2);
  assert.deepEqual(all.totals, {total: 2, disabled: 0});
  const r = all.rows.find(c => c.id === ravi);
  const paid = await q(`select count(*)::int n, coalesce(sum(total_paise),0)::int v from orders where customer_id = $1 and payment_status = 'paid'`, [ravi]);
  assert.equal(r.ordersCount, 3);
  assert.equal(r.paidOrdersCount, paid[0].n);
  assert.equal(r.lifetimeValuePaise, paid[0].v);
  assert.ok(r.lastOrderAt instanceof Date);
  assert.deepEqual((await listCustomers(db, support, customerListQuery.parse({q: 'ravi'}))).rows.map(c => c.id), [ravi]);
  assert.equal((await listCustomers(db, support, customerListQuery.parse({status: 'disabled'}))).rows.length, 0);
  assert.equal((await listCustomers(db, support, customerListQuery.parse({orders: 'without'}))).rows.length, 0);
  assert.equal((await listCustomers(db, support, customerListQuery.parse({verified: 'unverified'}))).rows.length, 0);
  assert.equal((await listCustomers(db, support, customerListQuery.parse({q: '%'}))).rows.length, 0, 'LIKE wildcards are literal');
  await assert.rejects(listCustomers(db, await staff('m8.inv@test.local', 'inventory_manager'), customerListQuery.parse({})), ForbiddenError);
});

test('customers: detail shows profile, orders, addresses and safe session activity; never secrets', async () => {
  const d = await getCustomer(db, support, ravi);
  assert.equal(d.customer.email, F.customers_.ravi.email);
  assert.equal(d.orders.length, 3);
  assert.equal(d.sessions.length, 2);
  assert.ok(d.sessions.every(s => s.active));
  assert.equal(d.canManage, false);
  assert.equal(d.audit, undefined, 'support has no audit.read');
  const json = JSON.stringify(d);
  assert.doesNotMatch(json, SECRET_WORDS);
  assert.doesNotMatch(json, /10\.0\.0\.9|secret-agent/, 'no IP address or user agent');
  await assert.rejects(getCustomer(db, support, '00000000-0000-4000-8000-000000000000'), NotFoundError);
  assert.equal((await getCustomer(db, admin, ravi)).canManage, true);
});

test('customers: disable ends every session (audited), enable restores login; stale and permission guards', async () => {
  const input = setCustomerStatusInput.parse({customerId: ravi, status: 'disabled', expectedStatus: 'active', note: 'Fraud check'});
  await assert.rejects(setCustomerStatus(db, sales, input, ctx), ForbiddenError, 'customers.read is not enough');
  assert.equal(setCustomerStatusInput.safeParse({customerId: ravi, status: 'disabled', expectedStatus: 'active', note: ''}).success, false, 'reason required');
  const r = await setCustomerStatus(db, admin, input, ctx);
  assert.deepEqual([r.status, r.sessionsEnded], ['disabled', 2]);
  assert.equal(await n(`select count(*)::int n from customer_sessions where customer_id = $1 and revoked_at is null`, [ravi]), 0);
  assert.equal(await audits('customer.disable', ravi), 1);
  const a = (await q(`select metadata, before_data as before, after_data as after from audit_logs where action = 'customer.disable' and entity_id = $1`, [ravi]))[0];
  assert.deepEqual([a.before.status, a.after.status, a.metadata.note, a.metadata.sessions_ended], ['active', 'disabled', 'Fraud check', 2]);
  await assert.rejects(setCustomerStatus(db, admin, input, ctx), ConflictError, 'stale page refused');
  assert.equal((await listCustomers(db, support, customerListQuery.parse({status: 'disabled'}))).totals.disabled, 1);
  await setCustomerStatus(db, admin, setCustomerStatusInput.parse({customerId: ravi, status: 'active', expectedStatus: 'disabled', note: 'Cleared'}), ctx);
  assert.equal(await audits('customer.enable', ravi), 1);
  assert.equal((await q(`select status from customers where id = $1`, [ravi]))[0].status, 'active');
  assert.ok((await getCustomer(db, admin, ravi)).audit.length >= 2, 'admin sees the audit trail');
});

test('customers: contact correction is validated and audited; email is not editable', async () => {
  const input = updateCustomerContactInput.parse({customerId: asha, fullName: 'Asha Fixture K', phone: '9876543210'});
  await assert.rejects(updateCustomerContact(db, support, input, ctx), ForbiddenError);
  assert.equal((await updateCustomerContact(db, admin, input, ctx)).changed, true);
  assert.equal((await updateCustomerContact(db, admin, input, ctx)).changed, false, 'no-op when unchanged');
  assert.equal(await audits('customer.update_contact', asha), 1);
  assert.equal(updateCustomerContactInput.safeParse({customerId: asha, fullName: 'A', phone: '12'}).success, false);
  assert.equal('email' in updateCustomerContactInput.shape, false);
});

// ---------------------------------------------------------------- payments
test('payments: attempts list with filters; billing.read required', async () => {
  const all = await listPayments(db, accountant, paymentListQuery.parse({}));
  assert.equal(all.rows.length, 6);
  assert.deepEqual(all.providers, ['razorpay']);
  assert.ok(all.rows.every(r => r.exception === null), 'fixtures have no exceptions');
  assert.equal((await listPayments(db, accountant, paymentListQuery.parse({status: 'failed'}))).rows.length, 1);
  assert.deepEqual((await listPayments(db, accountant, paymentListQuery.parse({q: 'KTS-TEST-0004'}))).rows.map(r => r.provider_payment_id), ['pay_TEST0004']);
  await assert.rejects(listPayments(db, support, paymentListQuery.parse({})), ForbiddenError);
  assert.doesNotMatch(JSON.stringify(all.rows), /"raw"/);
});

test('payments: exceptions are derived (captured after cancel, amount mismatch, duplicate capture, paid without capture)', async () => {
  const id = num => F.ids[num];
  await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at) values ($1, 'razorpay', 'pay_LATE0006', 99900, 'captured', now())`, [id('KTS-TEST-0006')]);
  await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at)
    select order_id, 'razorpay', 'pay_DUP0003', amount_paise, 'captured', now() from payments where provider_payment_id = 'pay_TEST0003'`);
  await q(`update payments set amount_paise = amount_paise + 100 where provider_payment_id = 'pay_TEST0005'`);
  await q(`update payments set status = 'failed', captured_at = null where provider_payment_id = 'pay_TEST0002'`);
  const ex = await getPaymentExceptions(db, accountant);
  const kinds = ex.rows.map(e => `${e.orderNumber}:${e.kind}`).sort();
  assert.deepEqual(kinds, ['KTS-TEST-0002:paid_without_capture', 'KTS-TEST-0003:duplicate_capture', 'KTS-TEST-0003:duplicate_capture',
    'KTS-TEST-0005:amount_mismatch', 'KTS-TEST-0006:captured_after_cancel']);
  assert.equal(ex.openCount, 5);
  assert.equal((await listPayments(db, accountant, paymentListQuery.parse({exception: 'any'}))).rows.length, 4);
  assert.equal((await listPayments(db, accountant, paymentListQuery.parse({exception: 'captured_after_cancel'}))).rows.length, 1);
  await assert.rejects(getPaymentExceptions(db, support), ForbiddenError);
  // Order page: Cancelled + Payment exception.
  assert.equal((await getOrder(db, accountant, id('KTS-TEST-0006'))).payment.cancelled.kind, 'cancelled_payment_exception');
  assert.equal((await getOrder(db, support, id('KTS-TEST-0006'))).payment, undefined, 'hidden without billing.read');
});

test('payments: manual refund is recorded only for money received on a cancelled order, once, with audit; no provider call', async () => {
  const late = (await q(`select id from payments where provider_payment_id = 'pay_LATE0006'`))[0].id;
  const dup = (await q(`select id from payments where provider_payment_id = 'pay_DUP0003'`))[0].id;
  const input = pid => recordManualRefundInput.parse({paymentId: pid, note: 'Refund by bank transfer'});
  await assert.rejects(recordManualRefund(db, support, input(late), ctx), ForbiddenError);
  await assert.rejects(recordManualRefund(db, manager, input(late), ctx), ForbiddenError, 'billing.read without refunds.create');
  await assert.rejects(recordManualRefund(db, accountant, input(dup), ctx), ConflictError, 'order not cancelled: not a refund case');
  const r = await recordManualRefund(db, accountant, input(late), ctx);
  assert.equal(r.amountPaise, 99900);
  await assert.rejects(recordManualRefund(db, accountant, input(late), ctx), ConflictError, 'only once');
  const row = (await q(`select status, requested_by, amount_paise, provider_refund_id, processed_at from refunds where payment_id = $1`, [late]))[0];
  assert.deepEqual([row.status, row.requested_by, row.amount_paise, row.provider_refund_id, row.processed_at], ['requested', accountant.staffId, 99900, null, null]);
  assert.equal(await audits('payment.manual_refund_recorded', F.ids['KTS-TEST-0006']), 1);
  assert.equal((await q(`select status from payments where id = $1`, [late]))[0].status, 'captured', 'payment record untouched');
  assert.equal((await q(`select status from orders where id = $1`, [F.ids['KTS-TEST-0006']]))[0].status, 'cancelled', 'order untouched');
  assert.equal((await getOrder(db, accountant, F.ids['KTS-TEST-0006'])).payment.cancelled.kind, 'cancelled_paid_refund_recorded');
  assert.equal((await getPaymentExceptions(db, accountant)).openCount, 4, 'recorded exception is no longer open');
  assert.equal(recordManualRefundInput.safeParse({paymentId: late, note: ''}).success, false, 'note required');
});

test('payments: Cancelled + Unpaid is distinguished', async () => {
  // KTS-TEST-0001 cancelled by staff below (M7 rules); before that, a cancelled order without money:
  await updateOrderStatus(db, sales, status('KTS-TEST-0001', 'cancelled', 'pending_payment', {note: 'Customer asked'}), ctx);
  assert.equal((await getOrder(db, accountant, F.ids['KTS-TEST-0001'])).payment.cancelled.kind, 'cancelled_unpaid');
  assert.equal((await getOrder(db, accountant, F.ids['KTS-TEST-0004'])).payment.cancelled, null, 'not cancelled');
});

test('payments: webhook/event viewer without payloads', async () => {
  await q(`insert into payment_events (id, provider, type, payload, order_id, outcome, processed_at) values
    ('razorpay:evt_1', 'razorpay', 'payment.captured', '{"secret":"do-not-show"}', $1, 'applied', now()),
    ('razorpay:evt_2', 'razorpay', 'payment.failed', '{}', null, 'ignored', null)`, [F.ids['KTS-TEST-0004']]);
  const all = await listPaymentEvents(db, accountant, paymentEventListQuery.parse({}));
  assert.equal(all.rows.length, 2);
  assert.doesNotMatch(JSON.stringify(all.rows), /do-not-show|payload/);
  assert.deepEqual((await listPaymentEvents(db, accountant, paymentEventListQuery.parse({outcome: 'ignored'}))).rows.map(r => r.id), ['razorpay:evt_2']);
  assert.deepEqual((await listPaymentEvents(db, accountant, paymentEventListQuery.parse({q: 'KTS-TEST-0004'}))).rows.map(r => r.id), ['razorpay:evt_1']);
  await assert.rejects(listPaymentEvents(db, support, paymentEventListQuery.parse({})), ForbiddenError);
});

test('payments: reconciliation compares provider payments with records (read-only); no provider means unavailable', async () => {
  await q(`update payments set provider_order_id = 'order_R0004' where provider_payment_id = 'pay_TEST0004'`);
  const before = await n(`select count(*)::int n from payments`);
  const fake = {listPayments: async ref => ref === 'order_R0004'
    ? [{id: 'pay_TEST0004', status: 'captured', amountPaise: 1}, {id: 'pay_UNSEEN', status: 'captured', amountPaise: 1}] : null};
  const r = await reconcileOrderPayments(db, accountant, {razorpay: fake}, F.ids['KTS-TEST-0004']);
  assert.deepEqual(r.rows.map(x => `${x.providerPaymentId}:${x.result}`), ['pay_TEST0004:match', 'pay_UNSEEN:missing']);
  assert.deepEqual((await reconcileOrderPayments(db, accountant, {}, F.ids['KTS-TEST-0004'])).unavailable, ['razorpay']);
  assert.equal(await n(`select count(*)::int n from payments`), before, 'reconciliation never writes');
  await assert.rejects(reconcileOrderPayments(db, support, {}, F.ids['KTS-TEST-0004']), ForbiddenError);
});

// ---------------------------------------------------------------- settings
test('settings: typed registry, locked business rules, audited edits of safe settings only', async () => {
  const s = await listSettings(db, manager);
  const all = s.groups.flatMap(g => g.items);
  const hold = all.find(i => i.key === 'checkout.payment_window_minutes');
  assert.deepEqual([hold.editable, hold.canEdit, hold.value], [false, false, 14400]);
  const low = all.find(i => i.key === 'inventory.low_stock_threshold');
  assert.deepEqual([low.editable, low.canEdit], [true, false], 'manager has settings.read only');
  assert.equal((await listSettings(db, admin)).groups.flatMap(g => g.items).find(i => i.key === 'inventory.low_stock_threshold').canEdit, true);
  // M10 added company details and the delivery charge (entered by the business); every rule-bearing setting stays locked.
  // ERP modules 1–8 add business switches that all start off (discounts, returns, emails, alerts) and thresholds with no value.
  const erpKeys = ['carts.abandon_after_hours', 'company.state', 'discounts.enabled', 'discounts.stacking', 'notifications.abandoned_cart', 'notifications.order_delivered',
    'notifications.refund_processed', 'notifications.return_status', 'notifications.support_reply', 'returns.enabled', 'returns.window_days',
    // client change request, first pass
    'checkout.abandoned_after_hours', 'checkout.cart_refresh_minutes', 'notifications.abandoned_checkout', 'pricing.max_sale_discount_percent',
    // client change request, second pass (cash on delivery and loyalty points: off / empty until the business decides)
    'payments.cod_enabled', 'payments.cod_discount', 'payments.cod_min_order', 'payments.cod_max_order', 'loyalty.enabled', 'loyalty.earn_points_per_100',
    'loyalty.earn_when', 'loyalty.point_value_paise', 'loyalty.min_redeem_points', 'loyalty.max_redeem_points', 'loyalty.expiry_months',
    // commerce workflows (2026-10-01): staff discount limit, order emails, automatic cart reminder and its wording
    'discounts.staff_max_percent', 'notifications.order_packed', 'notifications.payment_request', 'notifications.abandoned_cart_auto',
    'emails.cart_reminder_subject', 'emails.cart_reminder_intro',
    // purchasing / products workflows (2026-10-01): COD % discount with its minimum and stacking rule
    'payments.cod_discount_percent', 'payments.cod_discount_min_order', 'payments.cod_discount_with_other'];
  assert.deepEqual(all.filter(i => i.editable && !i.key.startsWith('alerts.')).map(i => i.key).sort(), ['company.address', 'company.gstin', 'company.legal_name', 'company.phone', 'company.support_email',
    'inventory.low_stock_threshold', 'notifications.order_cancelled', 'notifications.order_shipped', 'reviews.eligibility', 'shipping.flat_rate_paise', 'shipping.free_from_paise', 'shipping.method', ...erpKeys].sort(), 'editable settings');
  assert.ok(all.filter(i => i.key.startsWith('alerts.')).every(i => i.editable && i.type.kind === 'choice'), 'staff alert switches');
  for (const k of erpKeys) assert.equal(all.find(i => i.key === k).value, null, `${k} has no value until the business sets it`);
  assert.ok(s.policies.some(p => /returns/i.test(p.label) && /None/.test(p.value)));
  await assert.rejects(listSettings(db, support), ForbiddenError);

  const U = (key, value) => settingUpdateInput.parse({key, value});
  await assert.rejects(updateSetting(db, manager, U('inventory.low_stock_threshold', '7'), ctx), ForbiddenError);
  await assert.rejects(updateSetting(db, admin, U('checkout.payment_window_minutes', '60'), ctx), ForbiddenError, 'M7 hold time locked');
  await assert.rejects(updateSetting(db, admin, U('billing.prices_include_tax', 'false'), ctx), ForbiddenError, 'tax locked');
  await assert.rejects(updateSetting(db, admin, U('store.new_key', '1'), ctx), NotFoundError, 'no new keys');
  await assert.rejects(updateSetting(db, admin, U('inventory.low_stock_threshold', '1001'), ctx), DomainError);
  await assert.rejects(updateSetting(db, admin, U('inventory.low_stock_threshold', '-1'), ctx), DomainError);
  await assert.rejects(updateSetting(db, admin, U('inventory.low_stock_threshold', '2.5'), ctx), DomainError);
  const orig = (await q(`select value from settings where key = 'inventory.low_stock_threshold'`))[0].value;
  assert.equal((await updateSetting(db, admin, U('inventory.low_stock_threshold', '7'), ctx)).changed, true);
  assert.equal((await q(`select value from settings where key = 'inventory.low_stock_threshold'`))[0].value, 7);
  assert.equal((await updateSetting(db, admin, U('inventory.low_stock_threshold', '7'), ctx)).changed, false);
  const a = (await q(`select before_data as before, after_data as after, staff_id from audit_logs where action = 'settings.update' and entity_id = 'inventory.low_stock_threshold'`));
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].before.value, a[0].after.value, a[0].staff_id], [orig, 7, admin.staffId]);
  assert.equal((await q(`select value from settings where key = 'checkout.payment_window_minutes'`))[0].value, 14400, 'hold time unchanged');
  await updateSetting(db, admin, U('inventory.low_stock_threshold', String(orig)), ctx);
});

// ---------------------------------------------------------------- fulfilment
test('fulfilment: packing while processing, ship with optional tracking, deliver; one status system', async () => {
  const o3 = F.ids['KTS-TEST-0003'];
  const P = s => packingStateInput.parse({orderId: o3, packingState: s});
  await assert.rejects(setPackingState(db, support, P('packing'), ctx), ForbiddenError);
  await setPackingState(db, sales, P('packing'), ctx);
  assert.equal((await getOrder(db, support, o3)).shipment.packingState, 'packing');
  await setPackingState(db, sales, P('packed'), ctx);
  assert.equal(await audits('fulfilment.packing_update', o3), 2);
  await assert.rejects(setPackingState(db, sales, packingStateInput.parse({orderId: F.ids['KTS-TEST-0002'], packingState: 'packing'}), ctx), ConflictError, 'paid, not processing');
  assert.equal(updateOrderStatusInput.safeParse({orderId: o3, toStatus: 'shipped', expectedStatus: 'processing', carrierCode: 'Bad Courier'}).success, false);
  await assert.rejects(updateOrderStatus(db, sales, status('KTS-TEST-0003', 'shipped', 'processing', {carrierCode: 'shiprocket'}), ctx), DomainError, 'unknown carrier');
  assert.equal(await (async () => (await q(`select status from orders where id = $1`, [o3]))[0].status)(), 'processing', 'refused change left the order');

  await updateOrderStatus(db, sales, status('KTS-TEST-0003', 'shipped', 'processing'), ctx);   // no tracking number
  let d = await getOrder(db, support, o3);
  assert.equal(d.order.status, 'shipped');
  assert.deepEqual([d.shipment.carrierCode, d.shipment.trackingNumber, d.shipment.packingState], ['manual', null, 'packed']);
  assert.ok(d.shipment.shippedAt instanceof Date);
  assert.equal(d.shipment.deliveredAt, null);
  const meta = (await q(`select metadata from audit_logs where action = 'order.status_update' and entity_id = $1 order by occurred_at desc limit 1`, [o3]))[0].metadata;
  assert.deepEqual(meta.shipment, {carrier: 'manual', tracking_number: null});

  const T = (orderId, trackingNumber) => shipmentTrackingInput.parse({orderId, carrierCode: 'manual', trackingNumber});
  await assert.rejects(updateShipmentTracking(db, support, T(o3, 'AWB123'), ctx), ForbiddenError);
  await updateShipmentTracking(db, sales, T(o3, ' AWB-123/45 '), ctx);
  assert.equal((await getOrder(db, support, o3)).shipment.trackingNumber, 'AWB-123/45');
  assert.equal(await audits('fulfilment.tracking_update', o3), 1);
  assert.equal(shipmentTrackingInput.safeParse({orderId: o3, carrierCode: 'manual', trackingNumber: '<script>'}).success, false);
  await assert.rejects(updateShipmentTracking(db, sales, T(F.ids['KTS-TEST-0002'], 'X1'), ctx), ConflictError, 'not shipped yet');

  await updateOrderStatus(db, sales, status('KTS-TEST-0003', 'delivered', 'shipped'), ctx);
  d = await getOrder(db, support, o3);
  assert.ok(d.shipment.deliveredAt >= d.shipment.shippedAt);
  assert.equal(d.shipment.trackingNumber, 'AWB-123/45', 'tracking kept');

  // An order shipped before M8 (no shipment row): delivery takes the shipped time from the order history.
  const o4 = F.ids['KTS-TEST-0004'];
  await updateOrderStatus(db, sales, status('KTS-TEST-0004', 'delivered', 'shipped'), ctx);
  const s4 = (await getOrder(db, support, o4)).shipment;
  const h4 = (await q(`select max(created_at) t from order_status_history where order_id = $1 and to_status = 'shipped'`, [o4]))[0].t;
  assert.equal(s4.shippedAt.getTime(), h4.getTime());
  assert.equal(s4.trackingNumber, null);
  assert.equal(await n(`select count(*)::int n from shipments`), 2);
  assert.ok(await ledgerAgrees());
});

// ---------------------------------------------------------------- M7 non-regression
test('M7 rules unchanged: transitions table, captured-money cancel refused, stock and payment close on cancel', async () => {
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS_BY_ACTOR).sort(), ['customer', 'staff', 'system']);
  assert.equal(updateOrderStatusInput.safeParse({orderId: F.ids['KTS-TEST-0005'], toStatus: 'cancelled', expectedStatus: 'delivered', note: 'x'}).success, false,
    'delivered orders cannot be cancelled');
  // KTS-TEST-0002 has its captured payment back (paid orders can only move forward).
  await q(`update payments set status = 'captured', captured_at = now() where provider_payment_id = 'pay_TEST0002'`);
  await updateOrderStatus(db, sales, status('KTS-TEST-0002', 'processing', 'paid'), ctx);
  assert.equal(updateOrderStatusInput.safeParse({orderId: F.ids['KTS-TEST-0002'], toStatus: 'cancelled', expectedStatus: 'processing', note: 'x'}).success, false);
  // KTS-TEST-0008 waits for payment but holds an authorised payment: staff cancellation is still refused.
  await assert.rejects(updateOrderStatus(db, sales, status('KTS-TEST-0008', 'cancelled', 'pending_payment', {note: 'Customer asked'}), ctx), ConflictError);
  // KTS-TEST-0001 (cancelled above): 2 units back to stock, payment state closed.
  const o1 = (await q(`select status, payment_status from orders where id = $1`, [F.ids['KTS-TEST-0001']]))[0];
  assert.deepEqual([o1.status, o1.payment_status], ['cancelled', 'unpaid']);
  assert.equal(await n(`select sum(stock_qty)::int n from product_variants`), 1100 - 11 + 2);
  assert.ok(await ledgerAgrees());
  assert.equal(await n(`select value::int n from settings where key = 'checkout.payment_window_minutes'`), 14400);
});

// ---------------------------------------------------------------- export
test('order export: same filters as the list, CSV-safe, capped and audited', async () => {
  const r = await exportOrders(db, support, orderListQuery.parse({status: 'delivered'}), ctx);
  const lines = r.csv.trim().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'Order');
  assert.equal(r.rows, 3);
  assert.equal(lines.length, 4);
  assert.ok(lines.some(l => l.includes('AWB-123/45')));
  await q(`update orders set contact = jsonb_set(contact, '{name}', '"=HYPERLINK(1)"') where id = $1`, [F.ids['KTS-TEST-0005']]);
  const all = await exportOrders(db, support, orderListQuery.parse({}), ctx);
  assert.equal(all.rows, 8);
  assert.ok(all.csv.includes(`'=HYPERLINK(1)`) && !/,=HYPERLINK/.test(all.csv), 'formula neutralised');
  assert.doesNotMatch(all.csv, /line1|pin|pay_TEST/i);
  assert.equal(await n(`select count(*)::int n from audit_logs where action = 'order.export' and staff_id = $1`, [support.staffId]), 2);
  await assert.rejects(exportOrders(db, await staff('m8.inv2@test.local', 'inventory_manager'), orderListQuery.parse({}), ctx), ForbiddenError);
});

// ---------------------------------------------------------------- dashboard
test('dashboard: fulfilment, payment and customer figures from live rows; payments by permission', async () => {
  await setCustomerStatus(db, admin, setCustomerStatusInput.parse({customerId: asha, status: 'disabled', expectedStatus: 'active', note: 'Dashboard check'}), ctx);
  const d = await getDashboard(db, accountant);
  // Now: 0002 processing (not started); 0003/0004/0005 delivered; 0001/0006 cancelled; 0007 failed; 0008 pending payment.
  assert.deepEqual(d.fulfilment, {awaiting: 1, paid: 0, not_started: 1, packing: 0, packed: 0, shipped: 0, delivered: 3, shipped_without_tracking: 0});
  assert.equal(d.payments.pending, 1);
  assert.equal(d.payments.exceptions, (await getPaymentExceptions(db, accountant)).openCount);
  assert.deepEqual(d.customers, {total: 2, active: 1, disabled: 1});
  assert.equal((await getDashboard(db, support)).payments, null, 'no billing.read');
  await setCustomerStatus(db, admin, setCustomerStatusInput.parse({customerId: asha, status: 'active', expectedStatus: 'disabled', note: 'Restore'}), ctx);
});

test.after(async () => { await Promise.all([db.destroy(), owner.destroy(), pool.end(), adminPool.end()]); });
