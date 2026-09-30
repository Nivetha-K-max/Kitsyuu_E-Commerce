/* Client change request, first pass, against the LOCAL test database: sale price, bulk product editor, abandoned
   checkout, delivery options, billing address, cart refresh, newsletter, size charts, production ↔ purchasing, brand wording.
   Customer flows run as kitsyuu_website, staff flows as kitsyuu_admin; setup and checks use the owner connection.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/client-first-pass.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, createProductInput, placeOrderInput, settingUpdateInput, shippingRateInput, shippingZoneInput} from '@kitsyuu/contracts';
import {
  addCartLine, bulkEditProducts, cartRefreshMinutes, createProduct, createProductionOrder, databaseDiscounts, defaultCommerceConfig, effectivePrice, exportSubscribers, getBrandCopyAdmin,
  getCustomerCart, listAbandonedCheckouts, listSubscribers, mergeBrandCopy, parseSizeChartTable, placeOrder, priceHistory, productionMaterialNeeds,
  raisePurchaseOrderForProduction, receiveGoods, removeCartLine, rotateUnsubscribeToken, saveBrandCopy, saveCustomerAddress, saveMaterial, saveShippingRate,
  saveShippingZone, saveSizeChart, saveVendor, sendAbandonedCheckoutReminders, setCartLineQty, setProductSale, setProductionInput, setPurchaseOrderStatus,
  settingsShipping, sizeChartForProduct, subscribeNewsletter, unsubscribeByToken, unsubscribeSubscriber, updateSetting, adjustMaterialStock, getPurchaseOrder,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'first-pass.test', requestId: 'test'};
const config = () => ({...defaultCommerceConfig, shipping: settingsShipping(() => web), discountSource: databaseDiscounts});
const P = (id, email) => ({customerId: id, email, fullName: 'Test', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'});
const sent = [];
const resend = {kind: 'resend', async send(m) { sent.push(m); }};
const consoleMailer = {kind: 'console', async send() { throw new Error('the console mailer must not be used for reminders'); }};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'first pass passphrase', fullName: role}, ctx)).token);
}
const set = (actor, key, value) => updateSetting(admin, actor, settingUpdateInput.parse({key, value}), ctx);
const emptyCart = async p => { for (const l of (await getCustomerCart(web, p)).lines) await removeCartLine(web, p, l); };
const firstSize = async productId => owner.selectFrom('product_variants').select(['id', 'size', 'stock_qty']).where('product_id', '=', productId).where('is_active', '=', true).orderBy('sort_order').executeTakeFirstOrThrow();
/** Moves a row's timestamps into the past (the updated_at triggers are skipped for this one local transaction). */
const backdate = async (sqlText) => pool.query(`begin; set local session_replication_role = replica; ${sqlText}; commit;`);

let root, manager, support, asha, ravi, ashaAddr, ashaOther, prodA, prodB;
before(async () => {
  root = await staff('fp.root@test.local', 'super_admin');
  manager = await staff('fp.manager@test.local', 'manager');
  support = await staff('fp.support@test.local', 'support');
  const mk = async (email, name) => (await owner.insertInto('customers').values({email, full_name: name, email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id;
  asha = P(await mk('asha.fp@test.local', 'Asha'), 'asha.fp@test.local');
  ravi = P(await mk('ravi.fp@test.local', 'Ravi'), 'ravi.fp@test.local');
  const addr = {fullName: 'Asha', phone: '9876543210', line1: '1 Test Road', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true};
  ashaAddr = await saveCustomerAddress(web, asha, addr, ctx);
  ashaOther = await saveCustomerAddress(web, asha, {...addr, line1: '9 Office Park', city: 'Bengaluru', state: 'Karnataka', pin: '560001', isDefault: false}, ctx);
  await saveCustomerAddress(web, ravi, {...addr, fullName: 'Ravi'}, ctx);
  [prodA, prodB] = await owner.selectFrom('products').select(['id', 'price_paise', 'category_id']).where('status', '=', 'active').orderBy('id').limit(2).execute();
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

// ---------------------------------------------------------------- sale price
test('sale price: base price kept; checkout uses the sale price while it runs; limit and override; audited and in the history', async () => {
  assert.equal(effectivePrice({basePaise: 1000, salePaise: 800}), 800);
  assert.equal(effectivePrice({basePaise: 1000, salePaise: 800, endsAt: new Date(Date.now() - 1000)}), 1000, 'ended sale');
  assert.equal(effectivePrice({basePaise: 1000, salePaise: 1200}), 1000, 'never above the base price');
  const s = await firstSize(prodA.id);
  await assert.rejects(setProductSale(admin, support, {productId: prodA.id, salePrice: 100, startsAt: null, endsAt: null}, ctx), ForbiddenError);
  await assert.rejects(setProductSale(admin, manager, {productId: prodA.id, salePrice: prodA.price_paise, startsAt: null, endsAt: null}, ctx), /below the price/);
  await set(root, 'pricing.max_sale_discount_percent', '20');
  const deep = Math.round(prodA.price_paise * 0.5);
  await assert.rejects(setProductSale(admin, manager, {productId: prodA.id, salePrice: deep, startsAt: null, endsAt: null}, ctx), /maximum sale discount is 20%/);
  await setProductSale(admin, root, {productId: prodA.id, salePrice: deep, startsAt: null, endsAt: null}, ctx);   // super admin holds the override
  const sale = Math.round(prodA.price_paise * 0.9);
  await setProductSale(admin, manager, {productId: prodA.id, salePrice: sale, startsAt: null, endsAt: null}, ctx);
  assert.equal((await owner.selectFrom('products').select('price_paise').where('id', '=', prodA.id).executeTakeFirstOrThrow()).price_paise, prodA.price_paise, 'base price unchanged');
  await emptyCart(asha);
  await addCartLine(web, asha, {productId: prodA.id, size: s.size, qty: 1});
  assert.equal((await getCustomerCart(web, asha)).lines[0].unitPaise, sale, 'the cart is priced at the sale price on the server');
  await backdate(`update products set sale_starts_at = now() + interval '1 day' where id = '${prodA.id}'`);
  assert.equal((await getCustomerCart(web, asha)).lines[0].unitPaise, prodA.price_paise, 'a sale that has not started yet is not applied');
  await setProductSale(admin, manager, {productId: prodA.id, salePrice: null, startsAt: null, endsAt: null}, ctx);
  const h = await priceHistory(admin, manager, {productId: prodA.id});
  assert.ok(h.filter(r => r.field === 'sale').length >= 3, 'sale changes are in the price history');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'pricing.sale_update' and entity_id = $1`, [prodA.id]))[0].n >= 3, true);
  await emptyCart(asha);
});

// ---------------------------------------------------------------- bulk editor
test('bulk editor: publish only complete products (reasons reported), category, collections, attributes, sale; permissions; one summary audit', async () => {
  const draft = {id: (await createProduct(admin, root, createProductInput.parse({name: 'Bulk Draft Tee', sku: 'KTS-FPB-001', categoryId: prodA.category_id, price: '1500'}), ctx)).productId};
  assert.equal((await q(`select status from products where id = $1`, [draft.id]))[0].status, 'draft', 'a new product starts as a draft');
  const r = await bulkEditProducts(admin, root, {productIds: [draft.id, prodB.id], action: 'publish'}, ctx);
  assert.equal(r.failed.length, 1); assert.equal(r.failed[0].productId, draft.id); assert.match(r.failed[0].reason, /size|image/i);
  assert.deepEqual(r.unchanged, [prodB.id], 'already active');
  await assert.rejects(bulkEditProducts(admin, support, {productIds: [prodB.id], action: 'draft'}, ctx), ForbiddenError);
  const [col] = await q(`select id from collections order by id limit 1`);
  const add = await bulkEditProducts(admin, root, {productIds: [prodA.id, prodB.id], action: 'collection_add', collectionIds: [col.id]}, ctx);
  assert.equal(add.failed.length, 0);
  assert.equal((await q(`select count(*)::int n from collection_products where collection_id = $1 and product_id in ($2, $3)`, [col.id, prodA.id, prodB.id]))[0].n, 2);
  await bulkEditProducts(admin, root, {productIds: [prodA.id, prodB.id], action: 'collection_remove', collectionIds: [col.id]}, ctx);
  await q(`insert into attributes (id, label) values ('fp-fit', 'Fit') on conflict do nothing`);
  await q(`insert into attribute_values (attribute_id, slug, label) values ('fp-fit', 'oversized', 'Oversized') on conflict do nothing`);
  const val = {attribute_id: 'fp-fit', slug: 'oversized'};
  await bulkEditProducts(admin, root, {productIds: [prodA.id, prodB.id], action: 'attribute_add', values: [{attributeId: val.attribute_id, slug: val.slug}]}, ctx);
  assert.equal((await q(`select count(*)::int n from product_attribute_values where attribute_id = $1 and value_slug = $2 and product_id in ($3, $4)`, [val.attribute_id, val.slug, prodA.id, prodB.id]))[0].n, 2);
  await bulkEditProducts(admin, root, {productIds: [prodA.id, prodB.id], action: 'attribute_remove', values: [{attributeId: val.attribute_id, slug: val.slug}]}, ctx);
  const [other] = await q(`select id from categories where parent_id is null and id <> $1 and is_active order by id limit 1`, [prodA.category_id]);
  const mv = await bulkEditProducts(admin, root, {productIds: [draft.id], action: 'category', categoryId: other.id, subcategoryId: null}, ctx);
  assert.deepEqual(mv.done, [draft.id]);
  await set(root, 'pricing.max_sale_discount_percent', '20');
  const tooDeep = await bulkEditProducts(admin, manager, {productIds: [prodA.id, prodB.id], action: 'sale_percent', percent: 30, startsAt: null, endsAt: null}, ctx);
  assert.equal(tooDeep.failed.length, 2, 'the limit applies to bulk sales too');
  const ok = await bulkEditProducts(admin, manager, {productIds: [prodA.id, prodB.id], action: 'sale_percent', percent: 10, startsAt: null, endsAt: null}, ctx);
  assert.equal(ok.done.length, 2);
  assert.equal((await q(`select sale_price_paise from products where id = $1`, [prodA.id]))[0].sale_price_paise, Math.round(prodA.price_paise * 0.9));
  await bulkEditProducts(admin, manager, {productIds: [prodA.id, prodB.id], action: 'sale_clear'}, ctx);
  assert.equal((await q(`select count(*)::int n from products where id in ($1, $2) and sale_price_paise is not null`, [prodA.id, prodB.id]))[0].n, 0);
  assert.ok((await q(`select count(*)::int n from audit_logs where action = 'product.bulk_edit'`))[0].n >= 7, 'one summary record per bulk operation');
  await assert.rejects(bulkEditProducts(admin, root, {productIds: [], action: 'draft'}, ctx), DomainError);
  await q(`delete from products where id = $1`, [draft.id]);   // local test clean-up: the runner expects only the catalogue's products
});

// ---------------------------------------------------------------- delivery options, billing, cart refresh
test('checkout: the customer chooses Standard or Express (server re-checks it); separate billing address; cart refresh (no item limit)', async () => {
  const z = await saveShippingZone(admin, root, shippingZoneInput.parse({name: 'FP South', states: ['Tamil Nadu', 'Karnataka'], pinPrefixes: '', active: 'on'}), ctx);
  const std = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Standard', amount: '50', estMin: '3', estMax: '5', active: 'on'}), ctx);
  const exp = await saveShippingRate(admin, root, shippingRateInput.parse({zoneId: z.id, name: 'Express', amount: '150', estMin: '1', estMax: '2', active: 'on'}), ctx);
  await q(`update shipping_rates set sort_order = 1 where id = $1`, [exp.id]);
  await set(root, 'shipping.method', 'zones');
  const s = await firstSize(prodB.id);
  await emptyCart(asha);
  await addCartLine(web, asha, {productId: prodB.id, size: s.size, qty: 1});
  const shipTo = {state: 'Tamil Nadu', pin: '600001', country: 'India'};
  const def = await getCustomerCart(web, asha, config(), shipTo);
  assert.deepEqual(def.totals.shipping.options.map(o => o.label), ['Standard', 'Express']);
  assert.equal(def.totals.shippingPaise, 5000, 'the first option unless the customer chooses');
  const express = await getCustomerCart(web, asha, config(), {...shipTo, deliveryRateId: exp.id});
  assert.equal(express.totals.shippingPaise, 15000);
  const bogus = await getCustomerCart(web, asha, config(), {...shipTo, deliveryRateId: '00000000-0000-4000-8000-000000000000'});
  assert.equal(bogus.totals.shippingPaise, 5000, 'an unknown option falls back to an offered one');
  // Place the order with Express and a separate billing address.
  const input = placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr, expectedTotalPaise: String(express.totals.totalPaise),
    deliveryRateId: exp.id, billingSame: 'false', billingAddressId: ashaOther});
  const placed = await placeOrder(web, asha, input, ctx, config());
  const [o] = await q(`select shipping_paise, billing_address, shipping_address from orders where order_number = $1`, [placed.orderNumber]);
  assert.equal(o.shipping_paise, 15000);
  assert.equal(o.billing_address.city, 'Bengaluru'); assert.equal(o.shipping_address.city, 'Chennai');
  assert.throws(() => placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr, expectedTotalPaise: '1', billingSame: 'false'}), /billing/);
  // Same as delivery → no separate billing address stored (as for every earlier order).
  await addCartLine(web, asha, {productId: prodB.id, size: s.size, qty: 1});
  const c2 = await getCustomerCart(web, asha, config(), shipTo);
  const p2 = await placeOrder(web, asha, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr, expectedTotalPaise: String(c2.totals.totalPaise)}), ctx, config());
  assert.equal((await q(`select billing_address from orders where order_number = $1`, [p2.orderNumber]))[0].billing_address, null);
  // Someone else's address cannot be used for billing.
  const [raviAddr] = await q(`select id from addresses where customer_id = $1`, [ravi.customerId]);
  await addCartLine(web, asha, {productId: prodB.id, size: s.size, qty: 1});
  const c3 = await getCustomerCart(web, asha, config(), shipTo);
  await assert.rejects(placeOrder(web, asha, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: ashaAddr, expectedTotalPaise: String(c3.totals.totalPaise),
    billingSame: 'false', billingAddressId: raviAddr.id}), ctx, config()), /billing/);
  await set(root, 'shipping.method', 'none');
  // Cart refresh (the client clarified: no item limit; a cart with items re-syncs every 30 minutes). The store reads the
  // interval as the website role; items from different products are not limited.
  assert.equal(await cartRefreshMinutes(web), 30, 'the client’s 30 minutes until a value is set');
  await set(root, 'checkout.cart_refresh_minutes', '45');
  assert.equal(await cartRefreshMinutes(web), 45);
  await emptyCart(asha);
  await addCartLine(web, asha, {productId: prodB.id, size: s.size, qty: 5});
  await addCartLine(web, asha, {productId: prodA.id, size: (await firstSize(prodA.id)).size, qty: 6});
  assert.equal((await getCustomerCart(web, asha)).totals.units, 11, 'no cart-wide item limit');
  await emptyCart(asha);
});

// ---------------------------------------------------------------- abandoned checkout
test('abandoned checkout: unpaid after the delay (24 h by default); one reminder per order; only with a provider and the switch on', async () => {
  const s = await firstSize(prodB.id);
  await emptyCart(ravi);
  await addCartLine(web, ravi, {productId: prodB.id, size: s.size, qty: 1});
  const [addr] = await q(`select id from addresses where customer_id = $1`, [ravi.customerId]);
  const c = await getCustomerCart(web, ravi);
  const placed = await placeOrder(web, ravi, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: addr.id, expectedTotalPaise: String(c.totals.totalPaise)}), ctx);
  const [o] = await q(`select id from orders where order_number = $1`, [placed.orderNumber]);
  assert.equal((await listAbandonedCheckouts(admin, manager, {page: 1})).total, 0, 'a fresh unpaid order is not abandoned yet');
  await backdate(`update orders set created_at = now() - interval '25 hours' where id = '${o.id}'`);
  const list = await listAbandonedCheckouts(admin, manager, {page: 1});
  assert.equal(list.hours, 24); assert.ok(list.rows.some(r => r.order_number === placed.orderNumber));
  await set(root, 'checkout.abandoned_after_hours', '48');
  assert.ok(!(await listAbandonedCheckouts(admin, manager, {page: 1})).rows.some(r => r.order_number === placed.orderNumber), 'the delay is configurable');
  await set(root, 'checkout.abandoned_after_hours', '24');
  assert.deepEqual(await sendAbandonedCheckoutReminders(admin, resend), {skipped: 'off', checked: 0, sent: 0, failed: 0}, 'switch off by default');
  await set(root, 'notifications.abandoned_checkout', 'on');
  assert.equal((await sendAbandonedCheckoutReminders(admin, consoleMailer)).skipped, 'no_provider', 'no real email without a provider');
  const run = await sendAbandonedCheckoutReminders(admin, resend, {storeUrl: 'https://store.test'});
  assert.equal(run.sent, 1);
  assert.match(sent.at(-1).text, /https:\/\/store\.test\/account\/orders\//);
  assert.equal((await sendAbandonedCheckoutReminders(admin, resend)).sent, 0, 'never twice for the same order');
  assert.equal((await q(`select status from checkout_reminders where order_id = $1`, [o.id]))[0].status, 'sent');
  // A paid order is not abandoned; an unsubscribed address is not reminded.
  await q(`update orders set status = 'cancelled' where id = $1`, [o.id]);
  await subscribeNewsletter(web, {email: 'ravi.fp@test.local', consent: true, source: 'store'});
  const [sub] = await q(`select id from newsletter_subscribers where email = 'ravi.fp@test.local'`);
  await unsubscribeSubscriber(admin, root, {subscriberId: sub.id}, ctx);
  await addCartLine(web, ravi, {productId: prodB.id, size: s.size, qty: 1});
  const c2 = await getCustomerCart(web, ravi);
  const p2 = await placeOrder(web, ravi, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: addr.id, expectedTotalPaise: String(c2.totals.totalPaise)}), ctx);
  await backdate(`update orders set created_at = now() - interval '30 hours' where order_number = '${p2.orderNumber}'`);
  assert.equal((await sendAbandonedCheckoutReminders(admin, resend)).sent, 0, 'unsubscribed addresses are skipped');
  await set(root, 'notifications.abandoned_checkout', 'off');
});

// ---------------------------------------------------------------- newsletter
test('newsletter: consent required; one row per email; unsubscribe by token; re-subscribe; admin list and export permissions', async () => {
  await assert.rejects(subscribeNewsletter(web, {email: 'news@test.local', consent: false, source: 'home'}), /Tick the box/);
  await assert.rejects(subscribeNewsletter(web, {email: 'not-an-email', consent: true, source: 'home'}), /valid email/);
  assert.equal((await subscribeNewsletter(web, {email: 'News@Test.local ', consent: true, source: 'home'})).result, 'subscribed');
  assert.equal((await subscribeNewsletter(web, {email: 'news@test.local', consent: true, source: 'footer'})).result, 'already');
  assert.equal((await q(`select count(*)::int n from newsletter_subscribers where email = 'news@test.local'`))[0].n, 1, 'no duplicates');
  const [s] = await q(`select id, consent_text from newsletter_subscribers where email = 'news@test.local'`);
  assert.match(s.consent_text, /unsubscribe/);
  assert.deepEqual(await unsubscribeByToken(web, 'x'.repeat(43)), {ok: false});
  const token = await rotateUnsubscribeToken(admin, s.id);
  assert.deepEqual(await unsubscribeByToken(web, token), {ok: true});
  assert.equal((await q(`select status from newsletter_subscribers where id = $1`, [s.id]))[0].status, 'unsubscribed');
  assert.equal((await subscribeNewsletter(web, {email: 'news@test.local', consent: true, source: 'home'})).result, 'resubscribed');
  const list = await listSubscribers(admin, manager, {status: 'subscribed', page: 1});
  assert.ok(list.rows.some(r => r.email === 'news@test.local'));
  await assert.rejects(listSubscribers(admin, support, {status: 'all', page: 1}), ForbiddenError);
  const rows = await exportSubscribers(admin, root, ctx);
  assert.ok(rows.some(r => r.email === 'news@test.local'));
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'newsletter.export'`))[0].n, 1);
});

// ---------------------------------------------------------------- size charts
test('size charts: validated table; category chart, product override; inactive charts are not public', async () => {
  assert.throws(() => parseSizeChartTable('Size'), /header line/);
  assert.throws(() => parseSizeChartTable('Size, Chest\nS, 90, 91'), /Line 2 has 3 cells/);
  assert.deepEqual(parseSizeChartTable('Size\tChest\tLength\nS\t90\t68\nM\t96\t70'), {headers: ['Chest', 'Length'], rows: [{size: 'S', values: ['90', '68']}, {size: 'M', values: ['96', '70']}]});
  await assert.rejects(saveSizeChart(admin, support, {name: 'x', unit: 'cm', table: 'Size, Chest\nS, 90', notes: null, active: true, categoryIds: [], productIds: []}, ctx), ForbiddenError);
  const cat = await saveSizeChart(admin, root, {name: 'Tops', unit: 'cm', table: 'Size, Chest, Length\nS, 96, 68\nM, 102, 70', notes: 'Measured flat.', active: true,
    categoryIds: [prodA.category_id], productIds: []}, ctx);
  assert.equal((await sizeChartForProduct(web, prodA.id))?.name, 'Tops', 'the category chart applies');
  await saveSizeChart(admin, root, {name: 'Special', unit: 'in', table: 'Size, Waist\n30, 30', notes: null, active: true, categoryIds: [], productIds: [prodA.id]}, ctx);
  assert.equal((await sizeChartForProduct(web, prodA.id))?.name, 'Special', 'the product chart wins');
  await saveSizeChart(admin, root, {chartId: cat.id, name: 'Tops', unit: 'cm', table: 'Size, Chest\nS, 96', notes: null, active: false, categoryIds: [prodA.category_id], productIds: []}, ctx);
  const cl = await pool.connect();
  try { await cl.query('begin; set local role anon'); assert.deepEqual((await cl.query(`select name from size_charts order by name`)).rows, [{name: 'Special'}], 'inactive charts are not public'); }
  finally { await cl.query('rollback'); cl.release(); }
});

// ---------------------------------------------------------------- production ↔ purchasing
test('production ↔ purchasing: shortfall, a draft PO raised for it and linked, partial receiving through the ledger', async () => {
  const v = await saveVendor(admin, root, {name: 'FP Fabrics', contact: null, email: null, phone: null, gstin: null, address: null, notes: null}, ctx);
  const m = await saveMaterial(admin, root, {code: 'FP-COT', name: 'Cotton', unit: 'm', reorderLevel: null, notes: null}, ctx);
  await adjustMaterialStock(admin, root, {materialId: m.id, delta: 2, reason: 'correction', note: 'opening count'}, ctx);
  const s = await firstSize(prodA.id);
  const po0 = await createProductionOrder(admin, root, {variantId: s.id, qty: 5, dueOn: null, notes: null}, ctx);
  await setProductionInput(admin, root, {productionOrderId: po0.id, materialId: m.id, qtyPlanned: 10}, ctx);
  let needs = await productionMaterialNeeds(admin, root, po0.id);
  assert.deepEqual(needs.needs.map(x => [x.remaining, x.stock, x.onOrder, x.shortfall]), [[10, 2, 0, 8]]);
  await assert.rejects(raisePurchaseOrderForProduction(admin, support, {productionOrderId: po0.id, vendorId: v.id, lines: [{materialId: m.id, qty: 8}], notes: null}, ctx), ForbiddenError);
  const raised = await raisePurchaseOrderForProduction(admin, root, {productionOrderId: po0.id, vendorId: v.id, lines: [{materialId: m.id, qty: 8}], notes: null}, ctx);
  needs = await productionMaterialNeeds(admin, root, po0.id);
  assert.deepEqual(needs.needs.map(x => [x.onOrder, x.shortfall]), [[8, 0]], 'what is on order counts');
  assert.deepEqual(needs.linked.map(l => l.po_number), [raised.poNumber]);
  // The normal vendor workflow: order it, receive part of it.
  await setPurchaseOrderStatus(admin, root, {purchaseOrderId: raised.id, status: 'ordered', expectedStatus: 'draft', note: null}, ctx);
  const po = await getPurchaseOrder(admin, root, raised.id);
  await receiveGoods(admin, root, {purchaseOrderId: raised.id, lines: [{lineId: po.lines[0].id, qty: 5}], note: null}, ctx);
  assert.equal((await getPurchaseOrder(admin, root, raised.id)).order.status, 'partially_received');
  needs = await productionMaterialNeeds(admin, root, po0.id);
  assert.deepEqual(needs.needs.map(x => [x.stock, x.onOrder, x.shortfall]), [[7, 3, 0]], 'received stock moved through the ledger');
  assert.equal((await q(`select count(*)::int n from material_movements where material_id = $1 and reason = 'receipt'`, [m.id]))[0].n, 1);
});

// ---------------------------------------------------------------- brand wording
test('brand wording: today\'s text by default; staff publish new wording; the store reads only published wording', async () => {
  // The hero eyebrow line was removed at the client's request: empty by default (not shown).
  assert.equal(mergeBrandCopy(null).heroEyebrow, '');
  assert.equal(mergeBrandCopy(null).heroLead, 'Japanese streetwear. Unconventional shapes. Made personal.', 'other lines keep their default');
  assert.equal(mergeBrandCopy({heroLead: '  '}).heroLead, 'Japanese streetwear. Unconventional shapes. Made personal.', 'empty keeps the default');
  await assert.rejects(saveBrandCopy(admin, support, {heroEyebrow: 'X'}, ctx), ForbiddenError);
  await saveBrandCopy(admin, root, {heroEyebrow: 'KITSYUU — STREETWEAR', footerTagline: 'LINE ONE.\nLINE TWO.'}, ctx);
  const a = await getBrandCopyAdmin(admin, root);
  assert.equal(a.copy.heroEyebrow, 'KITSYUU — STREETWEAR'); assert.equal(a.copy.heroLead, 'Japanese streetwear. Unconventional shapes. Made personal.');
  const cl = await pool.connect();
  try { await cl.query('begin; set local role anon'); const r = (await cl.query(`select content from site_content where key = 'store.brand_copy'`)).rows[0]; assert.equal(r.content.heroEyebrow, 'KITSYUU — STREETWEAR'); }
  finally { await cl.query('rollback'); cl.release(); }
  await assert.rejects(saveBrandCopy(admin, root, {heroTop: 'x'.repeat(41)}, ctx), /under 40/);
});
