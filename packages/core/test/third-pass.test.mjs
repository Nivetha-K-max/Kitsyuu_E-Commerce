/* Client change request, THIRD PASS, against the LOCAL test database: inventory locations, stock transfers, stock per
   location (adjustments, retail sales, counts), the online location = the store's stock, colour variants through cart,
   order and order editing, and the report by location and channel. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ForbiddenError, addAttributeValueInput, createAttributeInput, orderEditInput, placeOrderInput, returnRequestInput, settingUpdateInput} from '@kitsyuu/contracts';
import {
  addAttributeValue, addCartLine, addColourVariant, adjustLocationStock, adjustStock, cancelTransfer, createAttribute, createTransfer, editOrder,
  getCustomerCart, getLocationStock, listLocations, locationReport, onlineLocationId, openStockCount, placeOrder, postStockCount, preparePayment,
  receiveTransfer, recordCounts, getStockCount, removeCartLine, saveCustomerAddress, saveLocation, sendTransfer, setImageColour, setVariantColour,
  settingsShipping, submitPaymentResult, testPaymentProvider,
  createInvoiceForOrder, customerReturnOptions, getCustomerReturn, getOrder, getReturn, requestReturn, updateOrderStatus, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'third-pass.test', requestId: 'test'};
const pay = testPaymentProvider({secret: randomBytes(32).toString('hex')});

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'third pass passphrase', fullName: role}, ctx)).token);
}
const locQty = async (loc, variant) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, variant]))[0].n;
const storeQty = async variant => (await q(`select stock_qty from product_variants where id = $1`, [variant]))[0].stock_qty;
/** The online location's rows always equal the store's stock; every location's rows equal its ledger. */
const invariants = async () => {
  const [{n: onlineMismatch}] = await q(`select count(*)::int n from product_variants v join locations l on l.is_online
    left join location_stock s on s.variant_id = v.id and s.location_id = l.id where coalesce(s.qty, 0) <> v.stock_qty`);
  const [{n: ledgerMismatch}] = await q(`select count(*)::int n from location_stock s join locations l on l.id = s.location_id
    where s.qty <> (select coalesce(sum(m.delta), 0) from inventory_movements m where m.variant_id = s.variant_id
      and (m.location_id = s.location_id or (m.location_id is null and l.is_online)))`);
  return {onlineMismatch, ledgerMismatch};
};

let root, manager, support, online, rb1, rb2, prod, sizes, cust;
before(async () => {
  root = await staff('tp.root@test.local', 'super_admin');
  manager = await staff('tp.manager@test.local', 'manager');
  support = await staff('tp.support@test.local', 'support');
  online = await onlineLocationId(admin);
  [prod] = await owner.selectFrom('products').select(['id', 'sku']).where('status', '=', 'active').orderBy('id').limit(1).execute();
  sizes = await owner.selectFrom('product_variants').select(['id', 'size']).where('product_id', '=', prod.id).orderBy('sort_order').execute();
  const email = 'tp.cust@test.local';
  cust = {customerId: (await owner.insertInto('customers').values({email, full_name: 'TP', email_verified_at: new Date()}).returning('id').executeTakeFirstOrThrow()).id,
    email, fullName: 'TP', emailVerified: true, sessionId: '00000000-0000-4000-8000-000000000000'};
  cust.addr = await saveCustomerAddress(web, cust, {fullName: 'TP', phone: '9876543210', line1: '1 Test Road', line2: null, city: 'Chennai', state: 'Tamil Nadu', pin: '600001', isDefault: true}, ctx);
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('locations: the online location holds today\'s stock; staff add branches (no duplicates); permissions; audited', async () => {
  const list = await listLocations(admin, manager);
  assert.deepEqual(list.map(l => [l.name, l.is_online]), [['Chennai Warehouse', true]]);
  assert.equal(list[0].units, (await q(`select sum(stock_qty)::int n from product_variants`))[0].n, 'every unit of today\'s stock is at the online location');
  await assert.rejects(saveLocation(admin, manager, {code: 'RB-1', name: 'Retail Branch 1', kind: 'retail', address: null, active: true}, ctx), ForbiddenError, 'needs locations.manage');
  rb1 = (await saveLocation(admin, root, {code: 'rb-1', name: 'Retail Branch 1', kind: 'retail', address: 'Anna Nagar', active: true}, ctx)).id;
  rb2 = (await saveLocation(admin, root, {code: 'RB-2', name: 'Retail Branch 2', kind: 'retail', address: null, active: true}, ctx)).id;
  await assert.rejects(saveLocation(admin, root, {code: 'RB-3', name: 'retail branch 1', kind: 'retail', address: null, active: true}, ctx), /already has this code or name/);
  await assert.rejects(saveLocation(admin, root, {locationId: online, code: 'CHN-WH', name: 'Chennai Warehouse', kind: 'warehouse', address: null, active: false}, ctx), /cannot be deactivated/);
  assert.equal((await q(`select code from locations where id = $1`, [rb1]))[0].code, 'RB-1');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'location.create'`))[0].n, 2);
  // Edit, deactivate (empty, no open transfers), refused as a transfer end while inactive, reactivate.
  await saveLocation(admin, root, {locationId: rb2, code: 'RB-2', name: 'Retail Branch 2', kind: 'retail', address: 'T. Nagar', active: true}, ctx);
  assert.equal((await q(`select address from locations where id = $1`, [rb2]))[0].address, 'T. Nagar');
  await saveLocation(admin, root, {locationId: rb2, code: 'RB-2', name: 'Retail Branch 2', kind: 'retail', address: 'T. Nagar', active: false}, ctx);
  assert.deepEqual((await listLocations(admin, manager, {activeOnly: true})).map(l => l.code), ['CHN-WH', 'RB-1']);
  await assert.rejects(createTransfer(admin, manager, {fromLocationId: online, toLocationId: rb2, note: null, lines: [{variantId: sizes[0].id, qty: 1}]}, ctx), /must be active/);
  await assert.rejects(openStockCount(admin, manager, {note: null, locationId: rb2}, ctx), /inactive/);
  await saveLocation(admin, root, {locationId: rb2, code: 'RB-2', name: 'Retail Branch 2', kind: 'retail', address: 'T. Nagar', active: true}, ctx);
  assert.deepEqual((await q(`select action from audit_logs where entity_type = 'locations' and entity_id = $1 order by id`, [rb2])).map(r => r.action),
    ['location.create', 'location.update', 'location.update', 'location.update']);
  assert.deepEqual(await invariants(), {onlineMismatch: 0, ledgerMismatch: 0});
});

test('transfers: stock leaves on send, arrives on receive; a cancelled sent transfer comes back; never below zero; audited', async () => {
  const v = sizes[0].id, start = await storeQty(v);
  await assert.rejects(createTransfer(admin, support, {fromLocationId: online, toLocationId: rb1, note: null, lines: [{variantId: v, qty: 3}]}, ctx), ForbiddenError);
  await assert.rejects(createTransfer(admin, manager, {fromLocationId: rb1, toLocationId: rb1, note: null, lines: [{variantId: v, qty: 1}]}, ctx), /two different locations/);
  const t = await createTransfer(admin, manager, {fromLocationId: online, toLocationId: rb1, note: 'Stock the branch', lines: [{variantId: v, qty: 3}]}, ctx);
  assert.match(t.number, /^TR/);
  assert.equal(await storeQty(v), start, 'a draft moves nothing');
  await sendTransfer(admin, manager, {transferId: t.id}, ctx);
  assert.equal(await storeQty(v), start - 3, 'sent: the store (online location) has 3 fewer');
  assert.equal(await locQty(rb1, v), 0, 'in transit: not at the branch yet');
  await assert.rejects(sendTransfer(admin, manager, {transferId: t.id}, ctx), /Only a draft/);
  await receiveTransfer(admin, manager, {transferId: t.id}, ctx);
  assert.equal(await locQty(rb1, v), 3);
  await assert.rejects(receiveTransfer(admin, manager, {transferId: t.id}, ctx), /Only a sent transfer/, 'received twice: refused');
  assert.equal(await locQty(rb1, v), 3, 'nothing added twice');
  await assert.rejects(cancelTransfer(admin, manager, {transferId: t.id, note: 'late'}, ctx), /already closed/);
  await assert.rejects(saveLocation(admin, root, {locationId: rb1, code: 'RB-1', name: 'Retail Branch 1', kind: 'retail', address: 'Anna Nagar', active: false}, ctx), /still holds 3 unit/);
  assert.deepEqual((await q(`select reason, delta, location_id = $2 as at_online from inventory_movements where transfer_id = $1 order by id`, [t.id, online]))
    .map(r => [r.reason, r.delta, r.at_online]), [['transfer_out', -3, true], ['transfer_in', 3, false]]);
  // Too much: refused, nothing moves.
  const big = await createTransfer(admin, manager, {fromLocationId: rb1, toLocationId: rb2, note: null, lines: [{variantId: v, qty: 4}]}, ctx);
  await assert.rejects(sendTransfer(admin, manager, {transferId: big.id}, ctx), /Not enough stock/);
  assert.equal(await locQty(rb1, v), 3);
  // Sent then cancelled: back to the sender.
  const back = await createTransfer(admin, manager, {fromLocationId: rb1, toLocationId: rb2, note: null, lines: [{variantId: v, qty: 1}]}, ctx);
  await sendTransfer(admin, manager, {transferId: back.id}, ctx);
  assert.equal(await locQty(rb1, v), 2);
  await cancelTransfer(admin, manager, {transferId: back.id, note: 'Wrong branch'}, ctx);
  assert.equal(await locQty(rb1, v), 3); assert.equal(await locQty(rb2, v), 0);
  await cancelTransfer(admin, manager, {transferId: big.id, note: 'Too many'}, ctx);
  assert.deepEqual((await q(`select action from audit_logs where entity_type = 'stock_transfers' order by id`)).map(r => r.action),
    ['transfer.create', 'transfer.send', 'transfer.receive', 'transfer.create', 'transfer.create', 'transfer.send', 'transfer.cancel', 'transfer.cancel']);
  assert.deepEqual(await invariants(), {onlineMismatch: 0, ledgerMismatch: 0});
});

test('stock at a location: retail sales only at retail locations; stale quantity refused; counts per location', async () => {
  const v = sizes[0].id;
  await adjustLocationStock(admin, manager, {locationId: rb1, variantId: v, delta: -1, reason: 'retail_sale', note: 'Walk-in', expectedQty: 3}, ctx);
  assert.equal(await locQty(rb1, v), 2);
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: online, variantId: v, delta: -1, reason: 'retail_sale', note: null, expectedQty: await storeQty(v)}, ctx), /retail location/);
  await assert.rejects(adjustStock(admin, manager, {variantId: v, direction: 'decrease', quantity: 1, reason: 'retail_sale', note: null, expectedQty: await storeQty(v)}, ctx), /listed reasons/);
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: rb1, variantId: v, delta: -1, reason: 'retail_sale', note: null, expectedQty: 3}, ctx), /changed since/);
  await assert.rejects(adjustLocationStock(admin, manager, {locationId: rb1, variantId: v, delta: -5, reason: 'damage', note: null, expectedQty: 2}, ctx), /Not enough stock/);
  // A count at the branch, while the online location can have its own count open.
  const c = await openStockCount(admin, manager, {note: 'Branch count', locationId: rb1}, ctx);
  await openStockCount(admin, manager, {note: 'Warehouse count', locationId: null}, ctx);
  await assert.rejects(openStockCount(admin, manager, {note: null, locationId: rb1}, ctx), /already open for Retail Branch 1/);
  const sc = await getStockCount(admin, manager, c.id);
  const line = sc.lines.find(l => l.expected_qty === 2);
  assert.ok(line, 'expected quantities are the branch stock');
  await recordCounts(admin, manager, {stockCountId: c.id, lines: [{lineId: line.id, counted: 1}]}, ctx);
  await postStockCount(admin, manager, {stockCountId: c.id}, ctx);
  assert.equal(await locQty(rb1, v), 1, 'the difference is posted at the branch');
  const branch = await getLocationStock(admin, manager, {locationId: rb1, inStockOnly: true});
  assert.equal(branch.units, 1);
  // Stock history at the branch, newest first: count, retail sale, the received transfer (with its number).
  assert.deepEqual(branch.movements.map(m => [m.reason, m.delta, m.balance_after]).slice(0, 3), [['count_adjust', -1, 1], ['retail_sale', -1, 2], ['transfer_in', 1, 3]]);
  assert.match(branch.movements[2].transfer_number, /^TR/, 'the cancelled transfer brought 1 back, with its number');
  assert.equal((await q(`select count(*)::int n from inventory_movements where reason = 'retail_sale' and location_id <> $1`, [rb1]))[0].n, 0, 'the retail sale is recorded at its branch');
  assert.deepEqual(await invariants(), {onlineMismatch: 0, ledgerMismatch: 0});
});

test('colour variants: one Colour list; a product\'s sizes get colours; the cart and the order carry the colour; editing moves colour with stock', async () => {
  await createAttribute(admin, root, createAttributeInput.parse({label: 'Colour'}), ctx);
  for (const label of ['Black', 'Grey']) await addAttributeValue(admin, root, addAttributeValueInput.parse({attributeId: 'colour', label}), ctx);
  const m = sizes.find(s => s.size === 'M');
  await assert.rejects(addColourVariant(admin, root, {productId: prod.id, size: 'M', colour: 'grey'}, ctx), /existing sizes of this product their colour first/);
  for (const s of sizes) await setVariantColour(admin, root, {variantId: s.id, colour: 'black'}, ctx);
  assert.equal((await q(`select sku from product_variants where id = $1`, [m.id]))[0].sku, `${prod.sku}-M`, 'a size keeps its SKU');
  await assert.rejects(addColourVariant(admin, root, {productId: prod.id, size: 'M', colour: null}, ctx), /choose the colour/);
  await assert.rejects(addColourVariant(admin, root, {productId: prod.id, size: 'M', colour: 'red'}, ctx), /Attributes → Colour/);
  const grey = await addColourVariant(admin, root, {productId: prod.id, size: 'M', colour: 'grey'}, ctx);
  assert.equal(grey.sku, `${prod.sku}-GREY-M`);
  await assert.rejects(addColourVariant(admin, root, {productId: prod.id, size: 'M', colour: 'grey'}, ctx), /already exists in Grey/);
  await adjustStock(admin, manager, {variantId: grey.variantId, direction: 'increase', quantity: 4, reason: 'restock', note: null, expectedQty: 0}, ctx);
  assert.equal(await locQty(online, grey.variantId), 4, 'a new size gets its online stock row');
  // One product, two colours, different sizes per colour.
  const byColour = Object.fromEntries((await q(`select colour_slug, array_agg(size order by sort_order) sizes from product_variants where product_id = $1 group by 1`, [prod.id])).map(r => [r.colour_slug, r.sizes]));
  assert.deepEqual(byColour, {black: sizes.map(x => x.size), grey: ['M']});
  const [img] = await q(`select id from product_images where product_id = $1 limit 1`, [prod.id]);
  assert.ok(img, 'the seeded product has a photo');
  await setImageColour(admin, root, {imageId: img.id, colour: 'grey'}, ctx);
  assert.equal((await q(`select colour_slug from product_images where id = $1`, [img.id]))[0].colour_slug, 'grey');
  await assert.rejects(setImageColour(admin, root, {imageId: img.id, colour: 'red'}, ctx), /Attributes → Colour/);

  // Cart: the colour is part of the line.
  for (const l of (await getCustomerCart(web, cust)).lines) await removeCartLine(web, cust, l);
  await assert.rejects(addCartLine(web, cust, {productId: prod.id, size: 'M', qty: 1}), /Choose a colour/);
  await addCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'black', qty: 1});
  const cart = await getCustomerCart(web, cust);
  assert.deepEqual(cart.lines.map(l => [l.colour, l.colourLabel, l.size]), [['black', 'Black', 'M']]);
  const placed = await placeOrder(web, cust, placeOrderInput.parse({idempotencyKey: randomBytes(16).toString('hex'), addressId: cust.addr, expectedTotalPaise: String(cart.totals.totalPaise)}), ctx);
  const [o] = await q(`select id, total_paise, channel from orders where order_number = $1`, [placed.orderNumber]);
  assert.equal(o.channel, 'online');
  const [item] = await q(`select id, colour, size from order_items where order_id = $1`, [o.id]);
  assert.deepEqual([item.colour, item.size], ['Black', 'M']);
  const start = await preparePayment(web, pay, cust, placed.orderNumber);
  await submitPaymentResult(web, pay, cust, {orderNumber: placed.orderNumber, result: pay.simulate(start.client.sessionRef, o.total_paise, 'INR', 'success')}, ctx);
  // Edit: Black / M → Grey / M (same price); the stock moves between the two sizes.
  const [blackBefore, greyBefore] = [await storeQty(m.id), await storeQty(grey.variantId)];
  await editOrder(admin, root, orderEditInput.parse({orderId: o.id, expectedTotalPaise: String(o.total_paise), note: 'Customer wants grey',
    itemIds: [item.id], variantIds: [grey.variantId], qtys: ['1']}), ctx, {shipping: settingsShipping(() => admin)});
  assert.deepEqual((await q(`select colour, size from order_items where id = $1`, [item.id]))[0], {colour: 'Grey', size: 'M'});
  assert.deepEqual([await storeQty(m.id), await storeQty(grey.variantId)], [blackBefore + 1, greyBefore - 1]);
  assert.deepEqual(await invariants(), {onlineMismatch: 0, ledgerMismatch: 0});
});

test('colour: one cart line per colour; a missing or sold-out colour / size is refused; invoice, packing slip and return keep the colour', async () => {
  const [grey] = await q(`select id from product_variants where product_id = $1 and colour_slug = 'grey'`, [prod.id]);
  const other = sizes.find(x => x.size !== 'M').size;
  for (const l of (await getCustomerCart(web, cust)).lines) await removeCartLine(web, cust, l);
  await addCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'black', qty: 1});
  await addCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'grey', qty: 2});
  assert.deepEqual((await getCustomerCart(web, cust)).lines.map(l => [l.colourLabel, l.size, l.qty]).sort(), [['Black', 'M', 1], ['Grey', 'M', 2]], 'same size, two colours: two lines');
  await assert.rejects(addCartLine(web, cust, {productId: prod.id, size: other, colour: 'grey', qty: 1}), /not available/, 'Grey has no such size');
  await assert.rejects(addCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'navy', qty: 1}), /not available/, 'no such colour');
  const left = await storeQty(grey.id);
  await adjustStock(admin, manager, {variantId: grey.id, direction: 'decrease', quantity: left, reason: 'damage', note: null, expectedQty: left}, ctx);
  await removeCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'grey'});
  assert.deepEqual((await getCustomerCart(web, cust)).lines.map(l => l.colourLabel), ['Black'], 'removing one colour keeps the other');
  await assert.rejects(addCartLine(web, cust, {productId: prod.id, size: 'M', colour: 'grey', qty: 1}), /Grey, size M, is sold out/);
  await adjustStock(admin, manager, {variantId: grey.id, direction: 'increase', quantity: left, reason: 'restock', note: null, expectedQty: 0}, ctx);
  for (const l of (await getCustomerCart(web, cust)).lines) await removeCartLine(web, cust, l);

  // The order (edited to Grey / M above): invoice, packing slip (the order view), delivery, return.
  const [o] = await q(`select id, order_number from orders where customer_id = $1`, [cust.customerId]);
  await createInvoiceForOrder(admin, root, {orderId: o.id}, ctx);
  assert.deepEqual((await q(`select ii.description from invoice_items ii join invoices i on i.id = ii.invoice_id where i.order_id = $1`, [o.id])).map(r => r.description), [`${(await q(`select name from products where id = $1`, [prod.id]))[0].name} (Grey, size M)`]);
  assert.deepEqual((await getOrder(admin, root, o.id)).items.map(i => [i.colour, i.size]), [['Grey', 'M']]);
  let status = 'paid';
  for (const toStatus of ['processing', 'shipped', 'delivered']) {
    await updateOrderStatus(admin, root, {orderId: o.id, toStatus, expectedStatus: status, note: null, carrierCode: 'manual', trackingNumber: null}, ctx); status = toStatus;
  }
  for (const [key, value] of [['returns.enabled', 'on'], ['returns.window_days', '7']]) await updateSetting(admin, root, settingUpdateInput.parse({key, value}), ctx);
  const opts = await customerReturnOptions(web, cust, o.order_number);
  assert.deepEqual(opts.lines.map(l => [l.colour, l.size]), [['Grey', 'M']]);
  const r = await requestReturn(web, cust, returnRequestInput.parse({orderNumber: o.order_number, reasonCode: 'size_fit', items: [{orderItemId: opts.lines[0].id, qty: 1}]}), ctx);
  assert.deepEqual((await getReturn(admin, root, r.id)).items.map(i => i.colour), ['Grey']);
  assert.deepEqual((await getCustomerReturn(web, cust, r.number)).items.map(i => i.colour), ['Grey']);
  assert.deepEqual(await invariants(), {onlineMismatch: 0, ledgerMismatch: 0});
});

test('report: stock by location and what moved (online sales, retail sales, transfers); online vs retail channel', async () => {
  const from = new Date(Date.now() - 3600_000), to = new Date(Date.now() + 3600_000);
  const r = await locationReport(admin, manager, {from, to});
  const byName = Object.fromEntries(r.locations.map(l => [l.name, l]));
  assert.deepEqual([byName['Retail Branch 1'].retailSales, byName['Retail Branch 1'].transfersIn], [1, 4]);
  assert.equal(byName['Chennai Warehouse'].transfersOut, 3);
  assert.equal(r.channels.online.orders, 1, 'the paid online order');
  assert.equal(r.channels.retail.units, 1, 'retail: units only until a till (POS) is decided');
  assert.deepEqual([byName['Retail Branch 1'].retailSales, byName['Chennai Warehouse'].retailSales, byName['Retail Branch 2'].retailSales], [1, 0, 0], 'retail sales by branch');
  assert.deepEqual(await q(`select channel, count(*)::int n from orders group by channel`), [{channel: 'online', n: 1}], 'the store order is online; nothing is retail');
  await assert.rejects(locationReport(admin, await staff('tp.none@test.local', 'accountant'), {from, to}), ForbiddenError);
});

test('data safety: only what staff changed has colours; no stock or orders moved by the migration', async () => {
  // Only the one product staff gave colours to has coloured sizes or photos; every other product is as before.
  assert.deepEqual(await q(`select distinct product_id from product_variants where colour_slug is not null`), [{product_id: prod.id}]);
  assert.deepEqual(await q(`select distinct product_id from product_images where colour_slug is not null`), [{product_id: prod.id}]);
  // Stock is only at the online location unless a ledger row (transfer, adjustment, count) put it elsewhere.
  const [{n}] = await q(`select count(*)::int n from location_stock s join locations l on l.id = s.location_id and not l.is_online
    where s.qty <> 0 and not exists (select 1 from inventory_movements m where m.variant_id = s.variant_id and m.location_id = s.location_id)`);
  assert.equal(n, 0);
  assert.equal((await q(`select count(*)::int n from orders where channel <> 'online'`))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from products`))[0].n, 22, 'no product removed');
});
