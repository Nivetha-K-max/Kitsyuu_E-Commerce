/* Integration tests for M7 core commerce (cart, wishlist, pricing, checkout, payments, order workflow, stock) against the
   LOCAL test database. Services connect as the real kitsyuu_website role; setup and checks use the owner connection.
   Payments use the development test provider and the Razorpay adapter against a local fake Razorpay (fake-razorpay.mjs):
   no network, no real money.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/commerce.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDb, sql} from '@kitsyuu/db';
import {canTransitionAs, ConflictError, DomainError, NotFoundError, UnavailableError, ORDER_TRANSITIONS_BY_ACTOR, placeOrderInput} from '@kitsyuu/contracts';
import {
  addCartLine, cancelOrderByCustomer, expireUnpaidOrders, getCustomerCart, getCustomerOrder, getWishlist, handlePaymentWebhook, mergeGuestCart,
  mergeGuestWishlist, placeOrder, preparePayment, priceOrder, razorpayProvider, removeCartLine, saveCustomerAddress, setCartLineQty, setWishlisted,
  submitPaymentResult, testPaymentProvider, updateOrderStatus,
} from '@kitsyuu/core';
import {startFakeRazorpay, TEST_KEY_ID} from './fake-razorpay.mjs';

const {WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');
assert.ok(/kitsyuu_website/.test(WEBSITE_DATABASE_URL), 'services must run as the website role');

const db = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});      // kitsyuu_website
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});          // setup and checks only
const ctx = {ip: '127.0.0.1', userAgent: 'commerce.test', requestId: 'test'};
const testPay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const KEY_SECRET = randomBytes(16).toString('hex'), WEBHOOK_SECRET = randomBytes(16).toString('hex');
let rzpFake, rzp;

const key = () => randomBytes(16).toString('hex');
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
let asha, ravi, ashaAddress, raviAddress;
const variant = async (productId, size) => owner.selectFrom('product_variants').select(['id', 'stock_qty', 'size', 'sku']).where('product_id', '=', productId)
  .$if(!!size, q => q.where('size', '=', size)).orderBy('sort_order').executeTakeFirstOrThrow();
const stockOf = async id => (await owner.selectFrom('product_variants').select('stock_qty').where('id', '=', id).executeTakeFirstOrThrow()).stock_qty;
const orderRow = async number => owner.selectFrom('orders').selectAll().where('order_number', '=', number).executeTakeFirstOrThrow();
const audits = async (entityId, action) => (await owner.selectFrom('audit_logs').select('action').where('entity_id', '=', entityId).where('action', '=', action).execute()).length;
const emptyCart = async p => { for (const l of (await getCustomerCart(db, p)).lines) await removeCartLine(db, p, l); };
async function checkout(p, address, lines) {
  await emptyCart(p);
  for (const l of lines) await addCartLine(db, p, l);
  const cart = await getCustomerCart(db, p);
  return placeOrder(db, p, placeOrderInput.parse({idempotencyKey: key(), addressId: address, expectedTotalPaise: String(cart.totals.totalPaise)}), ctx);
}
const payWithTest = async (p, orderNumber, outcome = 'success') => {
  const start = await preparePayment(db, testPay, p, orderNumber);
  const o = await orderRow(orderNumber);
  return submitPaymentResult(db, testPay, p, {orderNumber, result: testPay.simulate(start.client.sessionRef, o.total_paise, o.currency, outcome)}, ctx);
};

before(async () => {
  const mk = async (email, name) => (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  asha = P(await mk('asha.m7@test.local', 'Asha Rao'), 'asha.m7@test.local');
  ravi = P(await mk('ravi.m7@test.local', 'Ravi Kumar'), 'ravi.m7@test.local');
  const addr = {fullName: 'Asha Rao', phone: '9876543210', line1: '12 Test Street', line2: null, city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', isDefault: true};
  ashaAddress = await saveCustomerAddress(db, asha, addr, ctx);
  raviAddress = await saveCustomerAddress(db, ravi, {...addr, fullName: 'Ravi Kumar', city: 'Chennai', pin: '600001'}, ctx);
  rzpFake = await startFakeRazorpay({keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET});
  rzp = razorpayProvider({keyId: TEST_KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, apiBase: rzpFake.url, timeoutMs: 3000});
});
after(async () => { await rzpFake?.close(); await db.destroy(); await owner.destroy(); });

// ---------------------------------------------------------------- workflow
test('order workflow: transitions are defined per actor in one place; payment states only by the system', () => {
  assert.ok(canTransitionAs('system', 'pending_payment', 'paid'));
  assert.ok(canTransitionAs('system', 'payment_failed', 'paid'), 'a failed payment can be retried');
  assert.ok(!canTransitionAs('staff', 'pending_payment', 'paid'), 'staff cannot mark an order paid');
  assert.ok(!canTransitionAs('customer', 'pending_payment', 'paid'), 'a customer cannot mark an order paid');
  assert.ok(canTransitionAs('customer', 'pending_payment', 'cancelled'));
  assert.ok(!canTransitionAs('customer', 'paid', 'cancelled'), 'a customer cannot cancel a paid order');
  assert.ok(!canTransitionAs('system', 'paid', 'cancelled'));
  assert.deepEqual([...ORDER_TRANSITIONS_BY_ACTOR.staff.paid], ['processing']);
  for (const actor of ['staff', 'system', 'customer']) for (const s of ['delivered', 'cancelled', 'refunded']) assert.equal(ORDER_TRANSITIONS_BY_ACTOR[actor][s].length, 0);
});

// ---------------------------------------------------------------- pricing
test('pricing: tax from tax_rates (inclusive / exclusive), pluggable shipping and discount rules; nothing invented by default', async () => {
  const lines = [{productId: 'x', variantId: 'v', qty: 2, unitPaise: 59_000, lineTotalPaise: 118_000}];
  const d = await priceOrder(db, lines);
  assert.equal(d.subtotalPaise, 118_000);
  assert.equal(d.discountPaise, 0); assert.deepEqual(d.discounts, []);
  assert.equal(d.shippingPaise, 0); assert.equal(d.shipping.configured, false, 'no shipping method is configured');
  assert.equal(d.tax.configured, true); assert.equal(d.tax.code, 'PROTOTYPE_INCLUSIVE'); assert.equal(d.taxPaise, 0);
  assert.equal(d.totalPaise, 118_000);
  // Another configuration, inside a transaction that is rolled back.
  await owner.transaction().execute(async tx => {
    await tx.updateTable('tax_rates').set({is_active: false}).execute();
    await tx.insertInto('tax_rates').values({code: 'T18_INCL', label: 'GST 18% incl.', rate_bp: 1800, is_inclusive: true, valid_from: new Date('2026-01-01')}).execute();
    const shipping = {code: 'flat', quote: async () => ({amountPaise: 5_000, method: 'flat', label: 'Flat', configured: true})};
    const discounts = [{code: 'TEN', label: '10% off', evaluate: async ({subtotalPaise}) => subtotalPaise / 10}];
    const r = await priceOrder(tx, lines, {config: {shipping, discounts}});
    assert.equal(r.discountPaise, 11_800); assert.equal(r.shippingPaise, 5_000);
    assert.equal(r.taxPaise, Math.round(106_200 * 1800 / 11_800), 'inclusive tax is the tax part of the discounted price');
    assert.equal(r.totalPaise, 106_200 + 5_000, 'inclusive tax is not added again');
    await tx.updateTable('tax_rates').set({is_inclusive: false}).where('code', '=', 'T18_INCL').execute();
    const ex = await priceOrder(tx, lines, {config: {shipping, discounts}});
    assert.equal(ex.taxPaise, Math.round(106_200 * 0.18)); assert.equal(ex.totalPaise, 106_200 + 5_000 + ex.taxPaise, 'exclusive tax is added');
    throw new Error('rollback');
  }).catch(e => { if (e.message !== 'rollback') throw e; });
  assert.equal((await priceOrder(db, lines)).tax.code, 'PROTOTYPE_INCLUSIVE', 'the configuration test left nothing behind');
});

// ---------------------------------------------------------------- cart
test('cart: server prices (a size may override its product price), merge, per-size limit, stock checks, isolation', async () => {
  const v1 = await variant('ky-proto-001'), v2 = await variant('ky-proto-002');
  const product1 = await owner.selectFrom('products').select('price_paise').where('id', '=', 'ky-proto-001').executeTakeFirstOrThrow();
  await owner.updateTable('product_variants').set({price_paise: 123_400}).where('id', '=', v2.id).execute();
  await addCartLine(db, asha, {productId: 'ky-proto-001', size: v1.size, qty: 2});
  const merged = await addCartLine(db, asha, {productId: 'ky-proto-001', size: v1.size, qty: 3});
  assert.deepEqual(merged, {qty: 5, capped: false}, 'the same size merges into one line');
  await addCartLine(db, asha, {productId: 'ky-proto-002', size: v2.size, qty: 1});
  let cart = await getCustomerCart(db, asha);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines[0].unitPaise, product1.price_paise);
  assert.equal(cart.lines[1].unitPaise, 123_400, 'the size price applies');
  assert.equal(cart.totals.subtotalPaise, product1.price_paise * 5 + 123_400);
  assert.ok(cart.canCheckout);
  const capped = await addCartLine(db, asha, {productId: 'ky-proto-001', size: v1.size, qty: 6});
  assert.deepEqual(capped, {qty: 10, capped: true}, 'more than 10 of one size is capped at 10 (the store limit)');
  await sql`select public.adjust_stock(${v2.id}::uuid, -8, 'correction', null, 'test: two left', null)`.execute(owner);
  await assert.rejects(addCartLine(db, asha, {productId: 'ky-proto-002', size: v2.size, qty: 2}), ConflictError, 'more than the stock is refused (1 in cart + 2 > 2)');
  await assert.rejects(setCartLineQty(db, asha, {productId: 'ky-proto-002', size: v2.size, qty: 3}), ConflictError);
  await sql`select public.adjust_stock(${v2.id}::uuid, 8, 'correction', null, 'test: restore', null)`.execute(owner);
  await setCartLineQty(db, asha, {productId: 'ky-proto-001', size: v1.size, qty: 1});
  await assert.rejects(addCartLine(db, asha, {productId: 'no-such-product', size: 'M', qty: 1}), NotFoundError);
  await assert.rejects(addCartLine(db, asha, {productId: 'ky-proto-001', size: 'XXXL', qty: 1}), NotFoundError);
  assert.equal((await getCustomerCart(db, ravi)).lines.length, 0, "another customer's cart is separate");
  await removeCartLine(db, asha, {productId: 'ky-proto-002', size: v2.size});
  cart = await getCustomerCart(db, asha);
  assert.deepEqual(cart.lines.map(l => [l.productId, l.qty]), [['ky-proto-001', 1]]);
  await owner.updateTable('product_variants').set({price_paise: null}).where('id', '=', v2.id).execute();
});

test('cart: a line that sold out or was archived is flagged / removed and blocks checkout', async () => {
  const v = await variant('ky-proto-003');
  await emptyCart(ravi);
  await addCartLine(db, ravi, {productId: 'ky-proto-003', size: v.size, qty: 2});
  await owner.updateTable('product_variants').set({is_active: false}).where('id', '=', v.id).execute();
  let cart = await getCustomerCart(db, ravi);
  assert.equal(cart.lines[0].problem, 'unavailable'); assert.equal(cart.canCheckout, false); assert.equal(cart.totals.subtotalPaise, 0);
  await owner.updateTable('product_variants').set({is_active: true}).where('id', '=', v.id).execute();
  await owner.updateTable('products').set({status: 'archived'}).where('id', '=', 'ky-proto-003').execute();
  cart = await getCustomerCart(db, ravi);
  assert.equal(cart.lines.length, 0); assert.equal(cart.removed, 1, 'an archived product drops out of the cart');
  await owner.updateTable('products').set({status: 'active'}).where('id', '=', 'ky-proto-003').execute();
});

test('guest cart and wishlist merge after login: invalid lines skipped, no doubling on a second login', async () => {
  await emptyCart(ravi);
  const v = await variant('ky-proto-004');
  const guest = [{id: 'ky-proto-004', size: v.size, qty: 3}, {id: 'ky-proto-004', size: v.size, qty: 2}, {id: '../etc', size: 'M', qty: 1},
    {id: 'ky-proto-005', size: 'NOPE', qty: 1}, {id: 'ky-proto-006', size: (await variant('ky-proto-006')).size, qty: 99}, 'junk'];
  const r1 = await mergeGuestCart(db, ravi, guest);
  assert.deepEqual(r1, {merged: 1, skipped: 4}, 'the two lines of the same size count once');
  const r2 = await mergeGuestCart(db, ravi, guest);
  assert.equal(r2.merged, 1);
  const cart = await getCustomerCart(db, ravi);
  assert.deepEqual(cart.lines.map(l => [l.productId, l.qty]), [['ky-proto-004', 3]],
    'invalid lines (bad id, unknown size, quantity outside 1–10, junk) are skipped; the larger quantity wins; repeating the merge does not double');
  const w = await mergeGuestWishlist(db, ravi, ['ky-proto-007', 'ky-proto-007', 'bad id', 'no-such-product']);
  assert.equal(w.merged, 1);
  assert.equal(await setWishlisted(db, ravi, 'ky-proto-008', true), true);
  assert.deepEqual(await getWishlist(db, ravi), ['ky-proto-007', 'ky-proto-008']);
  assert.equal(await setWishlisted(db, ravi, 'ky-proto-007', false), false);
  assert.equal(await setWishlisted(db, ravi, 'no-such-product', true), false);
  assert.deepEqual(await getWishlist(db, ravi), ['ky-proto-008']);
  assert.deepEqual(await getWishlist(db, asha), [], "another customer's wishlist is separate");
  await owner.updateTable('products').set({status: 'archived'}).where('id', '=', 'ky-proto-008').execute();
  assert.deepEqual(await getWishlist(db, ravi), [], 'archived products drop out');
  await owner.updateTable('products').set({status: 'active'}).where('id', '=', 'ky-proto-008').execute();
});

// ---------------------------------------------------------------- order creation
test('place order: server-side prices, tamper checks, address ownership, stock taken once through the ledger, idempotent', async () => {
  const v = await variant('ky-proto-010');
  await emptyCart(asha);
  await addCartLine(db, asha, {productId: 'ky-proto-010', size: v.size, qty: 2});
  const cart = await getCustomerCart(db, asha);
  const k = key();
  await assert.rejects(placeOrder(db, asha, {idempotencyKey: k, addressId: ashaAddress, expectedTotalPaise: 1}, ctx), ConflictError, 'a different total (tampered or stale) is refused');
  await assert.rejects(placeOrder(db, asha, {idempotencyKey: k, addressId: raviAddress, expectedTotalPaise: cart.totals.totalPaise}, ctx), NotFoundError, "another customer's address is refused");
  assert.equal(await stockOf(v.id), 10, 'refused attempts took no stock');
  const first = await placeOrder(db, asha, {idempotencyKey: k, addressId: ashaAddress, expectedTotalPaise: cart.totals.totalPaise}, ctx);
  const again = await placeOrder(db, asha, {idempotencyKey: k, addressId: ashaAddress, expectedTotalPaise: cart.totals.totalPaise}, ctx);
  assert.equal(again.orderNumber, first.orderNumber); assert.equal(again.reused, true, 'the same checkout form returns the same order');
  const o = await orderRow(first.orderNumber);
  assert.equal(o.status, 'pending_payment'); assert.equal(o.customer_id, asha.customerId); assert.equal(o.user_id, null);
  assert.equal(o.total_paise, cart.totals.totalPaise); assert.ok(Math.abs(o.payment_expires_at - Date.now() - 10 * 86_400_000) < 3_600_000, 'the decided hold time (10 days, migration 1700) is applied');
  assert.equal(o.pricing.tax.code, 'PROTOTYPE_INCLUSIVE'); assert.equal(o.pricing.shipping.configured, false);
  const items = await owner.selectFrom('order_items').selectAll().where('order_id', '=', o.id).execute();
  assert.deepEqual(items.map(i => [i.sku, i.qty, i.unit_price_paise * i.qty === i.line_total_paise]), [[v.sku, 2, true]]);
  assert.equal(await stockOf(v.id), 8, 'stock taken once');
  const ledger = await owner.selectFrom('inventory_movements').select(['delta', 'reason']).where('order_id', '=', o.id).execute();
  assert.deepEqual(ledger, [{delta: -2, reason: 'sale'}]);
  assert.equal(await audits(o.id, 'order.placed'), 1);
  assert.equal((await getCustomerOrder(db, asha, first.orderNumber)).canPay, true);
  await assert.rejects(getCustomerOrder(db, ravi, first.orderNumber), NotFoundError, "another customer cannot see the order");
  await assert.rejects(preparePayment(db, testPay, ravi, first.orderNumber), NotFoundError);
  await assert.rejects(cancelOrderByCustomer(db, ravi, first.orderNumber, ctx), NotFoundError);
});

test('last unit: two customers check out at the same moment → exactly one order, stock never below zero', async () => {
  const v = await variant('ky-proto-011');
  await sql`select public.adjust_stock(${v.id}::uuid, -9, 'correction', null, 'test: leave one', null)`.execute(owner);
  const lines = [{productId: 'ky-proto-011', size: v.size, qty: 1}];
  for (const p of [asha, ravi]) { await emptyCart(p); await addCartLine(db, p, lines[0]); }
  const total = (await getCustomerCart(db, asha)).totals.totalPaise;
  const results = await Promise.allSettled([asha, ravi].map((p, i) =>
    placeOrder(db, p, {idempotencyKey: key(), addressId: i ? raviAddress : ashaAddress, expectedTotalPaise: total}, ctx)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const lost = results.find(r => r.status === 'rejected');
  assert.ok(lost.reason instanceof ConflictError, String(lost.reason));
  assert.equal(await stockOf(v.id), 0);
});

// ---------------------------------------------------------------- payments (test provider)
test('payment: forged or altered results are refused; a verified success marks the order paid once', async () => {
  const {orderNumber} = await checkout(asha, ashaAddress, [{productId: 'ky-proto-012', size: (await variant('ky-proto-012')).size, qty: 1}]);
  const start = await preparePayment(db, testPay, asha, orderNumber);
  const again = await preparePayment(db, testPay, asha, orderNumber);
  assert.equal(again.client.sessionRef, start.client.sessionRef, 'one payment session per order');
  assert.ok(!JSON.stringify(start).match(/secret/i), 'no secret reaches the browser');
  const o = await orderRow(orderNumber);
  const good = testPay.simulate(start.client.sessionRef, o.total_paise, 'INR', 'success');
  for (const bad of [{...good, signature: 'f'.repeat(64)}, {...good, amount: '100'}, {...good, status: 'captured', session_ref: 'test_0000000000000000'}, {paid: 'true'}]) {
    await assert.rejects(submitPaymentResult(db, testPay, asha, {orderNumber, result: bad}, ctx), DomainError);
  }
  assert.equal((await orderRow(orderNumber)).status, 'pending_payment', 'nothing the browser invents changes the order');
  assert.ok(await audits(o.id, 'payment.not_verified') >= 4);
  await assert.rejects(submitPaymentResult(db, testPay, ravi, {orderNumber, result: good}, ctx), NotFoundError, "another customer cannot pay-confirm someone's order");
  assert.equal(await submitPaymentResult(db, testPay, asha, {orderNumber, result: good}, ctx), 'paid');
  assert.equal(await submitPaymentResult(db, testPay, asha, {orderNumber, result: good}, ctx), 'already_paid', 'a repeated callback changes nothing');
  const paid = await orderRow(orderNumber);
  assert.equal(paid.status, 'paid'); assert.equal(paid.payment_status, 'paid'); assert.ok(paid.paid_at);
  const pays = await owner.selectFrom('payments').select(['status', 'provider', 'amount_paise']).where('order_id', '=', o.id).execute();
  assert.deepEqual(pays, [{status: 'captured', provider: 'test', amount_paise: o.total_paise}], 'one payment row, filled in from the session');
  const cart = await owner.selectFrom('carts').select('status').where('id', '=', o.cart_id).executeTakeFirstOrThrow();
  assert.equal(cart.status, 'converted', 'the paid cart is closed; a new one starts on the next add');
  assert.equal((await getCustomerCart(db, asha)).lines.length, 0);
  assert.equal(await audits(o.id, 'payment.captured'), 1);
  await assert.rejects(cancelOrderByCustomer(db, asha, orderNumber, ctx), ConflictError, 'a paid order cannot be cancelled by the customer');
  await assert.rejects(preparePayment(db, testPay, asha, orderNumber), ConflictError, 'a paid order cannot be paid again');
});

test('payment failure → payment_failed; the customer can retry and pay', async () => {
  const {orderNumber} = await checkout(ravi, raviAddress, [{productId: 'ky-proto-013', size: (await variant('ky-proto-013')).size, qty: 1}]);
  assert.equal(await payWithTest(ravi, orderNumber, 'failure'), 'failed');
  let o = await orderRow(orderNumber);
  assert.equal(o.status, 'payment_failed'); assert.equal(o.payment_status, 'failed');
  assert.equal((await getCustomerOrder(db, ravi, orderNumber)).canPay, true, 'still payable');
  const s1 = await preparePayment(db, testPay, ravi, orderNumber), s2 = await preparePayment(db, testPay, ravi, orderNumber);
  assert.equal(s2.client.sessionRef, s1.client.sessionRef, 'a retry (or a page reload) reuses the payment session');
  assert.equal(await payWithTest(ravi, orderNumber, 'success'), 'paid');
  const rows = await owner.selectFrom('payments').select(['status', 'provider_order_id']).where('order_id', '=', (await orderRow(orderNumber)).id).orderBy('created_at').execute();
  assert.deepEqual(rows.map(r => r.status), ['failed', 'captured'], 'one row per attempt, no stray session rows');
  assert.equal(new Set(rows.map(r => r.provider_order_id)).size, 1);
  o = await orderRow(orderNumber);
  assert.equal(o.status, 'paid');
  const history = (await owner.selectFrom('order_status_history').select('to_status').where('order_id', '=', o.id).orderBy('id').execute()).map(h => h.to_status);
  assert.deepEqual(history, ['pending_payment', 'payment_failed', 'paid']);
});

test('customer cancellation returns the stock through the ledger; a newer checkout replaces an older unpaid order', async () => {
  const v = await variant('ky-proto-014');
  const {orderNumber} = await checkout(asha, ashaAddress, [{productId: 'ky-proto-014', size: v.size, qty: 3}]);
  assert.equal(await stockOf(v.id), 7);
  assert.deepEqual(await cancelOrderByCustomer(db, asha, orderNumber, ctx), {released: 3});
  assert.equal(await stockOf(v.id), 10);
  await assert.rejects(cancelOrderByCustomer(db, asha, orderNumber, ctx), ConflictError, 'cancelling twice is refused');
  // Replacement: two checkouts of the same cart.
  const first = await checkout(asha, ashaAddress, [{productId: 'ky-proto-014', size: v.size, qty: 2}]);
  await addCartLine(db, asha, {productId: 'ky-proto-014', size: v.size, qty: 1});
  const total = (await getCustomerCart(db, asha)).totals.totalPaise;
  const second = await placeOrder(db, asha, {idempotencyKey: key(), addressId: ashaAddress, expectedTotalPaise: total}, ctx);
  assert.equal((await orderRow(first.orderNumber)).status, 'cancelled');
  assert.equal((await orderRow(second.orderNumber)).status, 'pending_payment');
  assert.equal(await stockOf(v.id), 7, 'only the newer order holds stock');
  assert.equal(await audits((await orderRow(first.orderNumber)).id, 'order.replaced'), 1);
  await cancelOrderByCustomer(db, asha, second.orderNumber, ctx);
});

test('payment hold time: 10 days as decided (migration 1700); past it unpaid orders are cancelled; unset → no expiry', async () => {
  const v = await variant('ky-proto-015');
  const seeded = await owner.selectFrom('settings').select('value').where('key', '=', 'checkout.payment_window_minutes').executeTakeFirstOrThrow();
  assert.equal(Number(seeded.value), 14400, 'the business decision: 10 days = 14400 minutes');
  const b = await checkout(ravi, raviAddress, [{productId: 'ky-proto-015', size: v.size, qty: 1}]);
  const ob = await orderRow(b.orderNumber);
  assert.ok(Math.abs(ob.payment_expires_at - Date.now() - 10 * 86_400_000) < 3_600_000, 'items are held for 10 days');
  assert.deepEqual(await expireUnpaidOrders(db, {test: testPay}), {expired: 0, paid: 0, skipped: 0}, 'nothing expires before the 10 days');
  await preparePayment(db, testPay, ravi, b.orderNumber);
  await owner.updateTable('orders').set({payment_expires_at: new Date(Date.now() - 1000)}).where('id', '=', ob.id).execute();
  assert.deepEqual(await expireUnpaidOrders(db, {}), {expired: 0, paid: 0, skipped: 1}, 'without its provider the order is left alone');
  assert.deepEqual(await expireUnpaidOrders(db, {test: testPay}), {expired: 1, paid: 0, skipped: 0});
  assert.equal((await orderRow(b.orderNumber)).status, 'cancelled');
  assert.equal(await stockOf(v.id), 10);
  assert.equal(await audits(ob.id, 'order.expired'), 1);
  // With the setting removed, orders get no expiry and are never cancelled on their own.
  await owner.deleteFrom('settings').where('key', '=', 'checkout.payment_window_minutes').execute();
  try {
    const a = await checkout(ravi, raviAddress, [{productId: 'ky-proto-015', size: v.size, qty: 1}]);
    assert.equal((await orderRow(a.orderNumber)).payment_expires_at, null);
    await owner.updateTable('orders').set({created_at: new Date(Date.now() - 30 * 86_400_000)}).where('order_number', '=', a.orderNumber).execute();
    assert.deepEqual(await expireUnpaidOrders(db, {test: testPay}), {expired: 0, paid: 0, skipped: 0});
    await cancelOrderByCustomer(db, ravi, a.orderNumber, ctx);
  } finally {
    await owner.insertInto('settings').values({key: 'checkout.payment_window_minutes', value: seeded.value, description: 'restored after test', is_public: false})
      .onConflict(oc => oc.column('key').doNothing()).execute();
  }
});

// ---------------------------------------------------------------- Razorpay adapter (fake Razorpay)
test('Razorpay adapter: test mode only; signature + API read-back; unavailable service is reported, not crashed', async () => {
  assert.throws(() => razorpayProvider({keyId: 'rzp_live_AbCdEf123456', keySecret: 'x'.repeat(24)}), /live/);
  assert.throws(() => razorpayProvider({keyId: 'REPLACE_WITH_KEY', keySecret: 'x'}), /key id/);
  assert.throws(() => testPaymentProvider({production: true}), /not available in production/);
  const {orderNumber} = await checkout(asha, ashaAddress, [{productId: 'ky-proto-016', size: (await variant('ky-proto-016')).size, qty: 1}]);
  rzpFake.state.down = true;
  await assert.rejects(preparePayment(db, rzp, asha, orderNumber), UnavailableError);
  rzpFake.state.down = false;
  assert.equal((await orderRow(orderNumber)).status, 'pending_payment', 'the order survives the outage');
  const start = await preparePayment(db, rzp, asha, orderNumber);
  assert.match(start.client.razorpayOrderId, /^order_/); assert.equal(start.client.keyId, TEST_KEY_ID);
  const {response} = rzpFake.pay(start.client.razorpayOrderId, 'success');
  await assert.rejects(submitPaymentResult(db, rzp, asha, {orderNumber, result: {...response, razorpay_signature: 'a'.repeat(64)}}, ctx), DomainError);
  await assert.rejects(submitPaymentResult(db, rzp, asha, {orderNumber, result: {razorpay_payment_id: response.razorpay_payment_id}}, ctx), DomainError,
    'an unsigned report cannot claim success');
  assert.equal(await submitPaymentResult(db, rzp, asha, {orderNumber, result: response}, ctx), 'paid');
});

test('Razorpay webhooks: signature checked, each event once, late failure never undoes a capture, payment after cancel flagged', async () => {
  const hdr = w => name => ({'x-razorpay-signature': w.signature, 'x-razorpay-event-id': w.eventId})[name] ?? null;
  const {orderNumber} = await checkout(ravi, raviAddress, [{productId: 'ky-proto-017', size: (await variant('ky-proto-017')).size, qty: 1}]);
  const start = await preparePayment(db, rzp, ravi, orderNumber);
  const {payment} = rzpFake.pay(start.client.razorpayOrderId, 'success');
  const w = rzpFake.webhook('payment.captured', payment);
  assert.deepEqual(await handlePaymentWebhook(db, rzp, w.rawBody, name => name === 'x-razorpay-signature' ? 'b'.repeat(64) : w.eventId), {status: 401, outcome: 'not_verified'});
  assert.deepEqual(await handlePaymentWebhook(db, rzp, w.rawBody.replace('"captured"', '"captured" '), hdr(w)), {status: 401, outcome: 'not_verified'}, 'an altered body is refused');
  assert.deepEqual(await handlePaymentWebhook(db, rzp, w.rawBody, hdr(w)), {status: 200, outcome: 'paid', orderNumber});
  assert.deepEqual(await handlePaymentWebhook(db, rzp, w.rawBody, hdr(w)), {status: 200, outcome: 'duplicate'});
  const late = rzpFake.webhook('payment.failed', {...payment, status: 'failed'});
  await handlePaymentWebhook(db, rzp, late.rawBody, hdr(late));
  const o = await orderRow(orderNumber);
  assert.equal(o.status, 'paid');
  assert.deepEqual((await owner.selectFrom('payments').select('status').where('order_id', '=', o.id).execute()).map(r => r.status), ['captured']);
  // Money that arrives after the customer cancelled: recorded and flagged for a refund, order stays cancelled.
  const c = await checkout(ravi, raviAddress, [{productId: 'ky-proto-018', size: (await variant('ky-proto-018')).size, qty: 1}]);
  const cs = await preparePayment(db, rzp, ravi, c.orderNumber);
  await cancelOrderByCustomer(db, ravi, c.orderNumber, ctx);
  const late2 = rzpFake.webhook('payment.captured', rzpFake.pay(cs.client.razorpayOrderId, 'success').payment);
  assert.deepEqual(await handlePaymentWebhook(db, rzp, late2.rawBody, hdr(late2)), {status: 200, outcome: 'needs_refund', orderNumber: c.orderNumber});
  const oc = await orderRow(c.orderNumber);
  assert.equal(oc.status, 'cancelled'); assert.equal(oc.payment_status, 'paid');
  assert.equal(await audits(oc.id, 'payment.captured_after_cancel'), 1);
  const events = await owner.selectFrom('payment_events').select(['outcome']).orderBy('received_at').execute();
  assert.deepEqual(events.map(e => e.outcome), ['paid', 'already_paid', 'needs_refund']);
});

// ---------------------------------------------------------------- staff workflow + ledger
test('staff move a paid order forward through the same workflow; the website role cannot change stock directly', async () => {
  await assert.rejects(sql`select public.adjust_stock(${(await variant('ky-proto-019')).id}::uuid, 5, 'restock', null, 'x', null)`.execute(db), /permission denied/);
  await assert.rejects(db.updateTable('product_variants').set({sort_order: 1}).where('product_id', '=', 'ky-proto-019').execute(), /permission denied/);
  const o = await owner.selectFrom('orders').select(['id', 'status']).where('status', '=', 'paid').orderBy('created_at').executeTakeFirstOrThrow();
  const staff = {staffId: '00000000-0000-4000-8000-000000000001', email: 'staff@test.local', fullName: 'Staff', sessionId: 'x', permissions: new Set(['orders.read', 'orders.update_status'])};
  await assert.rejects(updateOrderStatus(owner, staff, {orderId: o.id, toStatus: 'delivered', expectedStatus: 'paid', note: null}, ctx), DomainError, 'no skipping steps');
});

test('ledger integrity: every size’s stock equals the sum of its ledger rows', async () => {
  const bad = await owner.selectFrom('product_variants as v').select('v.sku')
    .where(sql`v.stock_qty`, '<>', sql`(select coalesce(sum(m.delta), 0) from inventory_movements m where m.variant_id = v.id)`).execute();
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- email (Resend adapter + order confirmation)
test('Resend mailer: sends Resend’s API format with the key only in the header; errors never contain the key', async () => {
  const http = await import('node:http');
  const seen = [];
  let answer = 200;
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body)});
    res.writeHead(answer, {'content-type': 'application/json'}); res.end(answer === 200 ? '{"id":"email_test"}' : '{"message":"invalid from"}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const {resendMailer, createMailer} = await import('@kitsyuu/auth');
  const key = 're_TestKey_' + randomBytes(8).toString('hex');
  try {
    const m = resendMailer({apiKey: key, from: 'KITSYUU <orders@example.com>', apiBase: `http://127.0.0.1:${srv.address().port}`});
    await m.send({to: 'asha@example.com', subject: 'Hello', text: 'Line 1\nLine 2'});
    assert.deepEqual(seen[0], {method: 'POST', url: '/emails', auth: `Bearer ${key}`,
      body: {from: 'KITSYUU <orders@example.com>', to: ['asha@example.com'], subject: 'Hello', text: 'Line 1\nLine 2'}});
    answer = 422;
    await assert.rejects(m.send({to: 'x@example.com', subject: 's', text: 't'}), e => /Resend answered 422/.test(e.message) && !e.message.includes(key));
  } finally { await new Promise(r => srv.close(r)); }
  assert.throws(() => resendMailer({apiKey: 'REPLACE_ME', from: 'a@b.co'}), /RESEND_API_KEY/);
  assert.throws(() => resendMailer({apiKey: key, from: 'not an address'}), /MAIL_FROM/);
  assert.throws(() => createMailer('smtp'), /Unknown MAILER/);
  assert.equal(createMailer('console').kind, 'console');
});

test('order confirmation email: only for a paid order; facts only (no shipment or refund promises); includes the policy line', async () => {
  const {orderConfirmationEmail} = await import('@kitsyuu/core');
  const {orderNumber} = await checkout(asha, ashaAddress, [{productId: 'ky-proto-020', size: (await variant('ky-proto-020')).size, qty: 2}]);
  const opts = {orderUrl: `http://shop.test/account/orders/${orderNumber}`, policy: 'All sales are final.'};
  assert.equal(await orderConfirmationEmail(db, orderNumber, opts), null, 'an unpaid order gets no confirmation');
  assert.equal(await payWithTest(asha, orderNumber, 'success'), 'paid');
  const m = await orderConfirmationEmail(db, orderNumber, opts);
  const o = await orderRow(orderNumber);
  assert.equal(m.to, 'asha.m7@test.local');
  assert.match(m.subject, new RegExp(orderNumber));
  assert.ok(m.text.includes(`× 2`) && m.text.includes('12 Test Street') && m.text.includes('All sales are final.') && m.text.includes(opts.orderUrl));
  const {paiseToRupees} = await import('@kitsyuu/contracts');
  assert.ok(m.text.includes(`Total paid: ₹${paiseToRupees(o.total_paise)}`), 'the total paid, as recorded on the order');
  assert.ok(!/let you know|notify|refund|deliver(ed)? (by|within)|ships? (by|within)/i.test(m.text), 'no promises');
});

// ---------------------------------------------------------------- cancelled unpaid orders: payment state
test('a cancelled unpaid order no longer looks payable: pending → unpaid, an unused session closed; declined attempts and paid orders untouched', async () => {
  const pays = async id => (await owner.selectFrom('payments').select(['status', 'failure_reason']).where('order_id', '=', id).orderBy('created_at').execute());
  // customer cancels after opening the payment step (a session exists, nothing was paid)
  const a = await checkout(asha, ashaAddress, [{productId: 'ky-proto-021', size: (await variant('ky-proto-021')).size, qty: 1}]);
  await preparePayment(db, testPay, asha, a.orderNumber);
  await cancelOrderByCustomer(db, asha, a.orderNumber, ctx);
  const oa = await orderRow(a.orderNumber);
  assert.deepEqual([oa.status, oa.payment_status], ['cancelled', 'unpaid']);
  assert.deepEqual(await pays(oa.id), [{status: 'failed', failure_reason: 'Order cancelled before payment'}]);
  assert.equal((await getCustomerOrder(db, asha, a.orderNumber)).paymentStatus, 'unpaid');
  const {getOrder} = await import('@kitsyuu/core');
  const staffView = await getOrder(owner, {staffId: '00000000-0000-4000-8000-000000000001', permissions: new Set(['orders.read'])}, oa.id);
  assert.deepEqual(staffView.history.map(h => [h.to_status, h.by_customer]), [['pending_payment', true], ['cancelled', true]],
    'the admin history attributes placing and cancelling to the customer');
  // declined, then cancelled: the order keeps "failed" and the declined attempt keeps its reason
  const b = await checkout(asha, ashaAddress, [{productId: 'ky-proto-021', size: (await variant('ky-proto-021')).size, qty: 1}]);
  assert.equal(await payWithTest(asha, b.orderNumber, 'failure'), 'failed');
  await cancelOrderByCustomer(db, asha, b.orderNumber, ctx);
  const ob = await orderRow(b.orderNumber);
  assert.deepEqual([ob.status, ob.payment_status], ['cancelled', 'failed']);
  assert.deepEqual(await pays(ob.id), [{status: 'failed', failure_reason: 'Declined (test payment)'}]);
  // replaced by a newer checkout (system path)
  const c = await checkout(asha, ashaAddress, [{productId: 'ky-proto-021', size: (await variant('ky-proto-021')).size, qty: 1}]);
  await preparePayment(db, testPay, asha, c.orderNumber);
  const total = (await getCustomerCart(db, asha)).totals.totalPaise;
  const d = await placeOrder(db, asha, {idempotencyKey: key(), addressId: ashaAddress, expectedTotalPaise: total}, ctx);
  const oc = await orderRow(c.orderNumber);
  assert.deepEqual([oc.status, oc.payment_status], ['cancelled', 'unpaid']);
  assert.deepEqual((await pays(oc.id)).map(p => p.status), ['failed']);
  // the new order is untouched and still payable; paying it works as before
  assert.equal((await orderRow(d.orderNumber)).payment_status, 'pending');
  assert.equal(await payWithTest(asha, d.orderNumber, 'success'), 'paid');
  const od = await orderRow(d.orderNumber);
  assert.deepEqual([od.status, od.payment_status], ['paid', 'paid']);
  assert.deepEqual((await pays(od.id)).map(p => p.status), ['captured']);
});
