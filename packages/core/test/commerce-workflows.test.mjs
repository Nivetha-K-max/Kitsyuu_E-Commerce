/* Commerce workflows (2026-10-01), against the LOCAL test database: overselling protection (two buyers, one unit), cart
   revalidation, staff discounts with limits, draft orders → online / offline orders, location stock, restock with cost and
   history, abandoned-cart reminders (one per cart), order emails, invoices for every channel, tracking for the customer. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, placeOrderInput, settingUpdateInput, updateOrderStatusInput} from '@kitsyuu/contracts';
import {
  addCartLine, adjustLocationStock, cancelDraftOrder, confirmDraftOrder, createDraftOrder, createInvoiceForOrder, getCustomerCart, getCustomerOrder, getDraftOrder,
  getLocationStock, listDraftOrders, notifyOrderPacked, notifyPaymentRequest, onlineLocationId, placeOrder, preparePayment, removeCartLine, saveCustomerAddress,
  saveLocation, sendAbandonedCartReminders, setDraftAddresses, setDraftDiscount, setDraftItem, setPackingState, settingsShipping, submitPaymentResult,
  testPaymentProvider, updateOrderStatus, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 6});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
/** Test only: makes a customer's active cart look untouched for `minutes` (the updated_at triggers are paused meanwhile). */
const ageCart = async (customerId, minutes) => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('alter table public.carts disable trigger carts_updated_at'); await c.query('alter table public.cart_items disable trigger cart_items_updated_at');
    await c.query(`update public.carts set updated_at = now() - make_interval(mins => $2) where customer_id = $1 and status = 'active'`, [customerId, minutes]);
    await c.query(`update public.cart_items set updated_at = now() - make_interval(mins => $2) where cart_id in (select id from public.carts where customer_id = $1 and status = 'active')`, [customerId, minutes]);
    await c.query('alter table public.carts enable trigger carts_updated_at'); await c.query('alter table public.cart_items enable trigger cart_items_updated_at');
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
};
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'commerce-workflows.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});
const config = {shipping: settingsShipping(() => admin), discounts: []};
const mails = []; const mailer = {kind: 'test', send: async m => { mails.push(m); }};
const set = (key, value) => updateSetting(admin, root, settingUpdateInput.parse({key, value}), ctx);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'workflow test passphrase', fullName: role}, ctx)).token);
}
async function customer(email, name) {
  const id = (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  const c = {customerId: id, email, fullName: name, emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'};
  c.addr = await saveCustomerAddress(web, c, {fullName: name, phone: '9876543210', line1: '1 Anna Salai', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600002', isDefault: true}, ctx);
  return c;
}
const stock = async variantId => (await q(`select stock_qty n from product_variants where id = $1`, [variantId]))[0].n;
const locQty = async (loc, v) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, v]))[0].n;
const variant = async (sku) => (await q(`select v.id, v.size, p.id product_id, p.price_paise from product_variants v join products p on p.id = v.product_id where v.sku = $1`, [sku]))[0];
const checkout = async (c, extra = {}) => {
  const cart = await getCustomerCart(web, c, config);
  return placeOrder(web, c, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: c.addr, expectedTotalPaise: String(cart.totals.totalPaise), ...extra}), ctx, config);
};

let root, manager, support, sales, online, store1, store2, asha, ravi, meena;
before(async () => {
  root = await staff('wf.root@test.local', 'super_admin');
  manager = await staff('wf.manager@test.local', 'manager');
  support = await staff('wf.support@test.local', 'support');
  sales = await staff('wf.sales@test.local', 'sales');
  online = await onlineLocationId(admin);
  asha = await customer('wf.asha@test.local', 'Asha'); ravi = await customer('wf.ravi@test.local', 'Ravi'); meena = await customer('wf.meena@test.local', 'Meena');
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('overselling: two customers buy the last unit at the same moment, exactly one order succeeds', async () => {
  const v = await variant('KTS-TOP-001-XS');
  const n = await stock(v.id);
  await adjustLocationStock(admin, manager, {locationId: online, variantId: v.id, delta: -(n - 1), reason: 'damage', note: 'leave one', expectedQty: n}, ctx);
  assert.equal(await stock(v.id), 1);
  for (const c of [asha, ravi]) await addCartLine(web, c, {productId: v.product_id, size: v.size, qty: 1});
  const results = await Promise.allSettled([checkout(asha), checkout(ravi)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'one order');
  const lost = results.find(r => r.status === 'rejected');
  assert.ok(lost.reason instanceof ConflictError && /sold out/.test(lost.reason.message), String(lost.reason?.message));
  assert.equal(await stock(v.id), 0, 'never below zero');
});

test('cart revalidation: a stale cart shows the sold-out / reduced quantity and cannot check out', async () => {
  const v = await variant('KTS-TOP-001-S');
  for (const l of (await getCustomerCart(web, meena)).lines) await removeCartLine(web, meena, l);
  await addCartLine(web, meena, {productId: v.product_id, size: v.size, qty: 3});
  // Someone else's purchase / a correction leaves 2: the cart says "Only 2 left" and checkout is refused.
  const n = await stock(v.id);
  await adjustLocationStock(admin, manager, {locationId: online, variantId: v.id, delta: -(n - 2), reason: 'damage', note: null, expectedQty: n}, ctx);
  let cart = await getCustomerCart(web, meena);
  assert.deepEqual([cart.lines[0].problem, cart.lines[0].available, cart.canCheckout], ['insufficient_stock', 2, false]);
  await assert.rejects(checkout(meena), /Only 2 left/);
  // Sold out: the line says so; checkout refused.
  await adjustLocationStock(admin, manager, {locationId: online, variantId: v.id, delta: -2, reason: 'damage', note: null, expectedQty: 2}, ctx);
  cart = await getCustomerCart(web, meena);
  assert.deepEqual([cart.lines[0].problem, cart.canCheckout], ['out_of_stock', false]);
  await assert.rejects(checkout(meena), /sold out/);
  await adjustLocationStock(admin, manager, {locationId: online, variantId: v.id, delta: 10, reason: 'restock', note: null, expectedQty: 0}, ctx);
  for (const l of (await getCustomerCart(web, meena)).lines) await removeCartLine(web, meena, l);
});

test('locations: two Chennai branches; restock with cost and history (before / change / after / reason / staff)', async () => {
  store1 = (await saveLocation(admin, root, {code: 'CHN-S1', name: 'Chennai Store 1', kind: 'retail', address: 'T. Nagar, Chennai', active: true}, ctx)).id;
  store2 = (await saveLocation(admin, root, {code: 'CHN-S2', name: 'Chennai Store 2', kind: 'retail', address: 'Anna Nagar, Chennai', active: true}, ctx)).id;
  const v = await variant('KTS-TOP-002-M');
  await adjustLocationStock(admin, manager, {locationId: store1, variantId: v.id, delta: 5, reason: 'restock', note: 'Received 5 units from supplier.', expectedQty: 0, unitCostPaise: 85000}, ctx);
  await adjustLocationStock(admin, manager, {locationId: store2, variantId: v.id, delta: 3, reason: 'restock', note: null, expectedQty: 0}, ctx);
  await adjustLocationStock(admin, manager, {locationId: store1, variantId: v.id, delta: 20, reason: 'restock', note: 'Received 20 units from supplier.', expectedQty: 5}, ctx);
  assert.deepEqual([await locQty(store1, v.id), await locQty(store2, v.id), await stock(v.id)], [25, 3, 10], 'per location; the online stock is unchanged');
  const s1 = await getLocationStock(admin, manager, {locationId: store1});
  const [last, first] = s1.movements;
  assert.deepEqual([last.balance_before, last.delta, last.balance_after, last.reason, last.note, last.staff_email], [5, 20, 25, 'restock', 'Received 20 units from supplier.', 'wf.manager@test.local']);
  assert.equal(first.unit_cost_paise, 85000, 'the unit cost is kept on the restock row');
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: store1, variantId: v.id, delta: -1, reason: 'damage', note: null, expectedQty: 25, unitCostPaise: 100}, ctx), /stock coming in/);
  await assert.rejects(adjustLocationStock(admin, support, {locationId: store1, variantId: v.id, delta: 1, reason: 'restock', note: null, expectedQty: 25}, ctx), ForbiddenError);
});

test('staff discount limits: not set up → refused; above the maximum, below a minimum price, or without a reason → refused with the reason', async () => {
  const v = await variant('KTS-OUT-001-M');                    // ₹ price from the seed
  const d = await createDraftOrder(admin, sales, {channel: 'online', customerId: asha.customerId}, ctx);
  await setDraftItem(admin, sales, {draftId: d.id, variantId: v.id, qty: 1}, ctx);
  await assert.rejects(setDraftDiscount(admin, sales, {draftId: d.id, percent: 5, reason: 'Loyal customer'}, ctx), ForbiddenError, 'sales staff cannot give discounts');
  await assert.rejects(setDraftDiscount(admin, manager, {draftId: d.id, percent: 5, reason: 'Loyal customer'}, ctx), /not set up/);
  await set('discounts.staff_max_percent', '10');
  await assert.rejects(setDraftDiscount(admin, manager, {draftId: d.id, percent: 15, reason: 'Loyal customer'}, ctx), /15% is above the maximum staff discount of 10%/);
  await assert.rejects(setDraftDiscount(admin, manager, {draftId: d.id, percent: 10, reason: ''}, ctx), /reason/);
  // Minimum price: price less 10% would undercut it.
  await q(`update products set min_price_paise = $2 where id = $1`, [v.product_id, Math.floor(v.price_paise * 0.95)]);
  await assert.rejects(setDraftDiscount(admin, manager, {draftId: d.id, percent: 10, reason: 'Loyal customer'}, ctx), /below its minimum price/);
  await setDraftDiscount(admin, manager, {draftId: d.id, percent: 5, reason: 'Customer loyalty discount'}, ctx);
  await q(`update products set min_price_paise = null where id = $1`, [v.product_id]);
  await cancelDraftOrder(admin, sales, {draftId: d.id}, ctx);
  assert.equal((await q(`select status from draft_orders where id = $1`, [d.id]))[0].status, 'cancelled');
});

let onlineOrder;
test('draft → online order: no stock held while a draft; confirmed → awaiting payment with stock held; customer pays; discount kept on the order', async () => {
  const hoodie = await variant('KTS-TOP-006-M'), jeans = await variant('KTS-BTM-004-32');
  const [h0, j0] = [await stock(hoodie.id), await stock(jeans.id)];
  const d = await createDraftOrder(admin, sales, {channel: 'online', customerId: ravi.customerId, note: 'Customer called the store'}, ctx);
  await setDraftItem(admin, sales, {draftId: d.id, variantId: hoodie.id, qty: 1}, ctx);
  await setDraftItem(admin, sales, {draftId: d.id, variantId: jeans.id, qty: 2}, ctx);
  await setDraftDiscount(admin, manager, {draftId: d.id, percent: 10, reason: 'Customer loyalty discount'}, ctx);
  await setDraftAddresses(admin, sales, {draftId: d.id, shipping: {name: 'Ravi', phone: '9876543210', line1: '5 Mount Road', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600006', country: 'India'},
    billingSame: false, billing: {name: 'Ravi Kumar', phone: '9876543210', line1: '12 Office Street', line2: 'Floor 2', city: 'Chennai', state: 'Tamil Nadu', pin: '600017', country: 'India'}}, ctx);
  assert.deepEqual([await stock(hoodie.id), await stock(jeans.id)], [h0, j0], 'a draft holds no stock');
  assert.equal((await listDraftOrders(admin, support, {})).some(x => x.id === d.id), true, 'listed as an open draft');
  const view = await getDraftOrder(admin, sales, d.id, {config});
  const subtotal = hoodie.price_paise + 2 * jeans.price_paise, discount = Math.round(subtotal * 0.1);
  assert.deepEqual([view.totals.subtotalPaise, view.totals.discountPaise, view.canConfirm], [subtotal, discount, true]);
  await assert.rejects(confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'online', expectedTotalPaise: view.totals.totalPaise + 1}, ctx, config), /changed since/);
  await assert.rejects(confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'cash', expectedTotalPaise: view.totals.totalPaise}, ctx, config), /online payment or cash on delivery/);
  await assert.rejects(confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'cod', expectedTotalPaise: view.totals.totalPaise}, ctx, config), /Cash on delivery is not/, 'COD only where the store allows it');
  const r = await confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'online', expectedTotalPaise: view.totals.totalPaise}, ctx, config);
  onlineOrder = r;
  const [o] = await q(`select status, channel, location_id, created_by, subtotal_paise, discount_paise, staff_discount_paise, staff_discount_bp, staff_discount_reason, staff_discount_by,
    total_paise, billing_address->>'line1' bill, shipping_address->>'line1' ship, payment_expires_at is not null held from orders where id = $1`, [r.orderId]);
  assert.deepEqual([o.status, o.channel, o.location_id, o.created_by], ['pending_payment', 'online', null, sales.staffId]);
  assert.deepEqual([o.subtotal_paise, o.staff_discount_paise, o.staff_discount_bp, o.staff_discount_reason, o.staff_discount_by, o.total_paise],
    [subtotal, discount, 1000, 'Customer loyalty discount', sales.staffId, subtotal - discount], 'original, discount, final, reason, who confirmed it');
  assert.deepEqual([o.ship, o.bill, o.held], ['5 Mount Road', '12 Office Street', true], 'both addresses kept on the order');
  assert.deepEqual([await stock(hoodie.id), await stock(jeans.id)], [h0 - 1, j0 - 2], 'stock held from the online location like a checkout');
  assert.equal((await q(`select status from draft_orders where id = $1`, [d.id]))[0].status, 'confirmed');
  await assert.rejects(setDraftItem(admin, sales, {draftId: d.id, variantId: hoodie.id, qty: 2}, ctx), /no longer be changed/);
  // The payment-request email (switch on) and the customer paying from their account.
  await set('notifications.payment_request', 'on');
  assert.deepEqual(await notifyPaymentRequest(admin, mailer, r.orderId, 'http://store.test'), {sent: true});
  assert.match(mails.at(-1).text, new RegExp(`http://store.test/account/orders/${r.orderNumber}`));
  const detail = await getCustomerOrder(web, ravi, r.orderNumber);
  assert.deepEqual([detail.canPay, detail.channel, detail.staffDiscount?.reason], [true, 'online', 'Customer loyalty discount']);
  const start = await preparePayment(web, pay, ravi, r.orderNumber);
  await submitPaymentResult(web, pay, ravi, {orderNumber: r.orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, 'INR', 'success')}, ctx);
  assert.equal((await q(`select status from orders where id = $1`, [r.orderId]))[0].status, 'paid');
});

test('invoice, packing, shipping and tracking: the customer sees the courier link and the invoice; packed email sent once switched on', async () => {
  await owner.insertInto('couriers').values({code: 'testship', name: 'Test Courier', mode: 'manual', tracking_url_template: 'https://track.example/{tracking}', is_active: true}).execute();
  const inv = await createInvoiceForOrder(admin, root, {orderId: onlineOrder.orderId}, ctx);
  const [ii] = await q(`select discount_paise, total_paise from invoices where id = $1`, [inv.invoiceId ?? inv.id]);
  const [o] = await q(`select discount_paise, total_paise from orders where id = $1`, [onlineOrder.orderId]);
  assert.deepEqual([ii.discount_paise, ii.total_paise], [o.discount_paise, o.total_paise], 'the invoice carries the staff discount');
  await updateOrderStatus(admin, root, updateOrderStatusInput.parse({orderId: onlineOrder.orderId, toStatus: 'processing', expectedStatus: 'paid', note: ''}), ctx);
  await setPackingState(admin, root, {orderId: onlineOrder.orderId, packingState: 'packed'}, ctx);
  assert.deepEqual(await notifyOrderPacked(admin, mailer, onlineOrder.orderId, null), {sent: false, reason: 'off'}, 'off until switched on');
  await set('notifications.order_packed', 'on');
  assert.deepEqual(await notifyOrderPacked(admin, mailer, onlineOrder.orderId, null), {sent: true});
  await updateOrderStatus(admin, root, updateOrderStatusInput.parse({orderId: onlineOrder.orderId, toStatus: 'shipped', expectedStatus: 'processing', carrierCode: 'testship', trackingNumber: 'TS123456', note: ''}), ctx);
  const d = await getCustomerOrder(web, ravi, onlineOrder.orderNumber);
  assert.deepEqual([d.shipment.carrier, d.shipment.trackingNumber, d.shipment.trackingUrl, d.shipment.status], ['Test Courier', 'TS123456', 'https://track.example/TS123456', 'shipped']);
  assert.ok(d.shipment.shippedAt && d.shipment.events.some(e => e.status === 'shipped'));
  assert.match(d.invoice.number, /\//, 'the issued invoice is shown to the customer');
});

test('offline order at a branch: walk-in customer, paid in the store, stock taken from that branch (not online), invoice', async () => {
  const v = await variant('KTS-TOP-002-M');
  const [s1, onl] = [await locQty(store1, v.id), await stock(v.id)];
  await assert.rejects(createDraftOrder(admin, sales, {channel: 'retail', locationId: online, contact: {name: 'Walk-in'}}, ctx), /not a branch/);
  const d = await createDraftOrder(admin, sales, {channel: 'retail', locationId: store1, contact: {name: 'Priya', phone: '9123456780'}}, ctx);
  await assert.rejects(setDraftItem(admin, sales, {draftId: d.id, variantId: v.id, qty: 26}, ctx), /at most|quantity/i);
  await assert.rejects(setDraftItem(admin, sales, {draftId: d.id, variantId: (await variant('KTS-TOP-003-M')).id, qty: 1}, ctx), /Only 0 .* at this branch/);
  await setDraftItem(admin, sales, {draftId: d.id, variantId: v.id, qty: 2}, ctx);
  await setDraftDiscount(admin, manager, {draftId: d.id, percent: 10, reason: 'Opening offer'}, ctx);
  const view = await getDraftOrder(admin, sales, d.id, {payment: 'cash', config});
  assert.equal(view.totals.shippingPaise, 0, 'nothing charged for delivery in the store');
  await assert.rejects(confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'online', expectedTotalPaise: view.totals.totalPaise}, ctx, config), /paid in the store/);
  const r = await confirmDraftOrder(admin, sales, {draftId: d.id, payment: 'cash', expectedTotalPaise: view.totals.totalPaise}, ctx, config);
  const [o] = await q(`select status, payment_status, payment_method, channel, location_id, customer_id, contact->>'name' name, created_by from orders where id = $1`, [r.orderId]);
  assert.deepEqual(o, {status: 'delivered', payment_status: 'paid', payment_method: 'cash', channel: 'retail', location_id: store1, customer_id: null, name: 'Priya', created_by: sales.staffId});
  assert.deepEqual([await locQty(store1, v.id), await stock(v.id)], [s1 - 2, onl], 'the branch stock goes down; the online stock does not');
  assert.equal((await q(`select count(*)::int n from inventory_movements where order_id = $1 and location_id = $2 and reason = 'retail_sale' and delta = -2`, [r.orderId, store1]))[0].n, 1);
  const inv = await createInvoiceForOrder(admin, root, {orderId: r.orderId}, ctx);
  assert.ok(inv, 'an offline order can be invoiced');
  // Branch out of stock: refused when confirming, nothing written.
  const d2 = await createDraftOrder(admin, sales, {channel: 'retail', locationId: store2, contact: {name: 'Karthik'}}, ctx);
  await setDraftItem(admin, sales, {draftId: d2.id, variantId: v.id, qty: 3}, ctx);
  await adjustLocationStock(admin, manager, {locationId: store2, variantId: v.id, delta: -2, reason: 'damage', note: null, expectedQty: 3}, ctx);
  const v2 = await getDraftOrder(admin, sales, d2.id, {payment: 'upi', config});
  await assert.rejects(confirmDraftOrder(admin, sales, {draftId: d2.id, payment: 'upi', expectedTotalPaise: v2.totals.totalPaise}, ctx, config), /Only 1 .* at this branch/);
  assert.equal(await locQty(store2, v.id), 1);
  // The location report separates the channels.
  const [{retail}] = await q(`select count(*)::int retail from orders where channel = 'retail'`);
  assert.equal(retail, 1);
});

test('abandoned-cart reminder: one per cart, after the delay, only in-stock items, not after an order, not when off', async () => {
  const v = await variant('KTS-BTM-001-M');
  for (const l of (await getCustomerCart(web, meena)).lines) await removeCartLine(web, meena, l);
  await addCartLine(web, meena, {productId: v.product_id, size: v.size, qty: 1});
  const age = minutes => ageCart(meena.customerId, minutes);
  assert.equal((await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45})).skipped, 'off');
  await set('notifications.abandoned_cart_auto', 'on');
  assert.equal((await sendAbandonedCartReminders(admin, {kind: 'console', send: async () => {}}, {delayMinutes: 45})).skipped, 'no_provider', 'nothing pretends to send without an email provider');
  await age(10);
  assert.equal((await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45})).sent, 0, 'not before the delay');
  await set('emails.cart_reminder_subject', 'Still thinking it over?');
  await age(50);
  const before = mails.length;
  const run = await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45, storeUrl: 'http://store.test'});
  assert.equal(run.sent, 1);
  const m = mails.at(-1);
  assert.deepEqual([mails.length - before, m.to, m.subject], [1, 'wf.meena@test.local', 'Still thinking it over?']);
  assert.match(m.text, /You left these items in your KITSYUU cart\.[\s\S]*size M[\s\S]*http:\/\/store\.test\/cart/);
  assert.equal((await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45})).sent, 0, 'never twice for the same cart');
  assert.equal((await q(`select count(*)::int n from notification_log where event = 'cart.auto_reminder' and recipient = 'wf.meena@test.local'`))[0].n, 1);
  // A customer who has ordered since the cart last changed gets no email (Asha bought the last unit in the first test).
  const ashaRun = await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45});
  assert.equal(ashaRun.sent, 0);
  // Another customer's cart whose only item sold out: no email.
  const devi = await customer('wf.devi@test.local', 'Devi');
  const w = await variant('KTS-BTM-003-M');
  await addCartLine(web, devi, {productId: w.product_id, size: w.size, qty: 1});
  const n = await stock(w.id);
  await adjustLocationStock(admin, manager, {locationId: online, variantId: w.id, delta: -n, reason: 'damage', note: null, expectedQty: n}, ctx);
  await ageCart(devi.customerId, 120);
  const r2 = await sendAbandonedCartReminders(admin, mailer, {delayMinutes: 45});
  assert.deepEqual([r2.sent, r2.noStock >= 1], [0, true], 'a cart with nothing in stock gets no email');
  await adjustLocationStock(admin, manager, {locationId: online, variantId: w.id, delta: n, reason: 'restock', note: null, expectedQty: 0}, ctx);
  for (const l of (await getCustomerCart(web, devi)).lines) await removeCartLine(web, devi, l);
});

test('drafts in the ERP: permissions — support can read, not create; sales can create, not discount', async () => {
  await assert.rejects(createDraftOrder(admin, support, {channel: 'online', customerId: asha.customerId}, ctx), ForbiddenError);
  await assert.rejects(createDraftOrder(admin, sales, {channel: 'online'}, ctx), DomainError, 'an online draft needs the customer');
  assert.ok(Array.isArray(await listDraftOrders(admin, support, {status: 'all'})));
});
