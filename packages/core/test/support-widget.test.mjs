/* Storefront help window (2026-10-12), against the LOCAL test database only. No schema change is involved.
   Covered: help topics are fixed and follow the returns settings; keyword matching is deterministic; a guest's order
   lookup needs the order number AND the order's own contact, answers a wrong number and a wrong contact identically, and
   returns status and shipping facts only; a guest's message becomes a ticket with no account, linked to an order only
   when the email matches; staff see it in Support; the store role cannot read internal notes.
   Store flows run as the real kitsyuu_website role, staff as kitsyuu_admin, setup and checks as the owner.
   Run by apps/admin/tests/run-e2e.mjs, or: node --env-file=apps/admin/tests/.output/test.env --test packages/core/test/support-widget.test.mjs */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {DomainError} from '@kitsyuu/contracts';
import {getTicket, guestOrderStatus, helpTopics, listTickets, lookupContact, matchHelpTopics, openGuestTicket} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 2});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 2});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'support-widget.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'support widget passphrase', fullName: role}, ctx)).token);
}

let agent, buyer, shipped, placed;
before(async () => {
  agent = await staff('sw.support@test.local', 'support');
  [buyer] = await q(`insert into customers (email, full_name, email_verified_at) values ('sw.account@test.local', 'Widget Buyer', now()) returning id`);
  // An order placed with a contact email different from the account's, and a phone number written the way people write them.
  [shipped] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
    values ('KTS-SW-0001', $1, 'shipped', 'paid', 259900, 259900, '{"name":"Priya Nair","email":"Priya.Gift@Example.com","phone":"+91 98765-43210"}', '{"line1":"14 Lake Road","city":"Kochi","pin":"682001"}') returning id`, [buyer.id]);
  await q(`insert into shipments (order_id, carrier_code, tracking_number, tracking_url, shipped_at) values ($1, 'manual', 'TRK-778899', 'https://track.example.com/TRK-778899', now())`, [shipped.id]);
  [placed] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
    values ('KTS-SW-0002', $1, 'paid', 'paid', 99900, 99900, '{"name":"Priya Nair","email":"priya.gift@example.com","phone":"9876543210"}', '{}') returning id`, [buyer.id]);
});
after(async () => { await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end(); });

test('help topics are a fixed list; the returns answer follows the business\'s settings; matching is by keywords and repeatable', async () => {
  const topics = await helpTopics(web);
  assert.deepEqual(topics.map(t => t.id), ['order-status', 'returns', 'change-order', 'delivery-charge', 'sizes', 'contact']);
  assert.match(topics.find(t => t.id === 'returns').answer, /All sales are final/, 'returns are off by default');
  await q(`insert into settings (key, value) values ('returns.enabled', '"on"'), ('returns.window_days', '"7"') on conflict (key) do update set value = excluded.value`);
  assert.match((await helpTopics(web)).find(t => t.id === 'returns').answer, /within 7 days of delivery/);
  await q(`delete from settings where key in ('returns.enabled', 'returns.window_days')`);
  assert.match(topics.find(t => t.id === 'contact').answer, /automated answers.*not a live chat/i, 'it says what it is');
  assert.ok(topics.every(t => !/\b(AI|artificial intelligence|assistant|bot)\b/i.test(t.question + t.answer)), 'nothing claims to be an AI or an assistant');
  const ids = s => matchHelpTopics(topics, s).map(t => t.id);
  assert.deepEqual(ids('Where is my order? It has not arrived'), ['order-status']);
  assert.deepEqual(ids('can i RETURN this, the size is wrong'), ['returns', 'sizes']);
  assert.deepEqual(ids('I want to talk to a person'), ['contact']);
  assert.deepEqual(ids('how much is shipping'), ['order-status', 'delivery-charge'].filter(x => x === 'delivery-charge'));
  assert.deepEqual(ids('zzz qqq'), []); assert.deepEqual(ids(''), []); assert.deepEqual(ids('a an to'), []);
  assert.deepEqual(ids('Where is my order? It has not arrived'), ids('Where is my order? It has not arrived'), 'the same question always gives the same answer');
  assert.ok(matchHelpTopics(topics, 'order return cancel delivery size contact help refund track').length <= 3, 'at most three');
});

test('guest order status: the order number AND the order\'s own contact; status and shipping facts only', async () => {
  const byEmail = await guestOrderStatus(web, {orderNumber: ' kts-sw-0001 ', contact: 'priya.gift@example.com'});
  assert.deepEqual(Object.keys(byEmail).sort(), ['found', 'orderNumber', 'placedOn', 'shipment', 'status', 'statusLabel']);
  assert.deepEqual([byEmail.found, byEmail.orderNumber, byEmail.status, byEmail.statusLabel], [true, 'KTS-SW-0001', 'shipped', 'Shipped']);
  assert.match(byEmail.placedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([byEmail.shipment.trackingNumber, byEmail.shipment.trackingUrl], ['TRK-778899', 'https://track.example.com/TRK-778899']);
  assert.match(byEmail.shipment.shippedOn, /^\d{4}-\d{2}-\d{2}$/);
  // Nothing personal comes back: no name, address, phone, email, amounts or items, anywhere in the answer.
  assert.ok(!/Priya|Nair|Lake Road|Kochi|682001|98765|example\.com\b(?!\/)|2599/.test(JSON.stringify({...byEmail, shipment: {...byEmail.shipment, trackingUrl: null}})), JSON.stringify(byEmail));
  // The phone the order was placed with, however it is typed; and the account's own email.
  for (const contact of ['9876543210', '+91 98765 43210', '098765-43210', 'SW.Account@test.local'])
    assert.equal((await guestOrderStatus(web, {orderNumber: 'KTS-SW-0001', contact})).found, true, contact);
  const notShipped = await guestOrderStatus(web, {orderNumber: 'KTS-SW-0002', contact: 'priya.gift@example.com'});
  assert.deepEqual([notShipped.statusLabel, notShipped.shipment], ['Confirmed', null]);
});

test('guest order status: a wrong number, a wrong contact and a malformed input all get the same answer', async () => {
  const miss = {found: false};
  for (const [orderNumber, contact] of [
    ['KTS-SW-0001', 'someone.else@example.com'],          // a real order, someone else's email
    ['KTS-SW-0001', '9876543211'],                        // a real order, one digit off
    ['KTS-SW-0001', '43210'],                             // part of the phone is not the phone
    ['KTS-SW-0001', ''], ['KTS-SW-0001', '@'], ['KTS-SW-0001', '%'], ['KTS-SW-0001', "' or 1=1 --"],
    ['KTS-SW-9999', 'priya.gift@example.com'],            // the right contact, no such order
    ['KTS-SW-000%', 'priya.gift@example.com'], ['%', 'priya.gift@example.com'], ['', 'priya.gift@example.com'],
    ["KTS-SW-0001' or '1'='1", 'priya.gift@example.com'],
  ]) assert.deepEqual(await guestOrderStatus(web, {orderNumber, contact}), miss, `${orderNumber} / ${contact}`);
  assert.deepEqual(lookupContact(' A@B.co '), {email: 'a@b.co'});
  assert.deepEqual(lookupContact('+91 (98765) 43210'), {phone: '9876543210'});
  assert.equal(lookupContact('12345'), null); assert.equal(lookupContact('not an email@'), null);
  // A second customer's order is never reachable with the first one's contact.
  const [other] = await q(`insert into customers (email, full_name, email_verified_at) values ('sw.other@test.local', 'Other Person', now()) returning id`);
  await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-SW-0003', $1, 'paid', 'paid', 100, 100, '{"email":"other@example.com","phone":"9000000001"}', '{}')`, [other.id]);
  for (const contact of ['priya.gift@example.com', '9876543210', 'sw.account@test.local'])
    assert.deepEqual(await guestOrderStatus(web, {orderNumber: 'KTS-SW-0003', contact}), miss);
});

test('a guest\'s message is a ticket without an account; an order is linked only when its email matches; staff see it in Support', async () => {
  const msg = {name: 'Priya Nair', email: 'Priya.Gift@Example.com', categoryCode: 'order', subject: 'Where is my parcel?', body: 'It was due yesterday.'};
  const [cat] = await q(`select code from support_categories where is_active order by sort_order limit 1`);
  msg.categoryCode = cat.code;
  const linked = await openGuestTicket(web, {...msg, orderNumber: 'kts-sw-0001'}, ctx);
  assert.match(linked.number, /^TCK-[A-Z0-9]{8}$/);
  const row = n => q(`select t.customer_id, t.contact_email, t.contact_name, t.order_id, t.channel, t.status, (select body from support_messages m where m.ticket_id = t.id order by id limit 1) body,
    (select customer_id from support_messages m where m.ticket_id = t.id order by id limit 1) author from support_tickets t where t.number = $1`, [n]).then(r => r[0]);
  assert.deepEqual(await row(linked.number), {customer_id: null, contact_email: 'priya.gift@example.com', contact_name: 'Priya Nair', order_id: shipped.id, channel: 'store', status: 'open', body: 'It was due yesterday.', author: null});
  // Someone else's order number: not linked, and the form's answer does not differ.
  const unlinked = await openGuestTicket(web, {...msg, email: 'stranger@example.com', orderNumber: 'KTS-SW-0001'}, ctx);
  const u = await row(unlinked.number);
  assert.equal(u.order_id, null);
  assert.match(u.body, /Order number given: KTS-SW-0001 \(not matched to this email/);
  assert.deepEqual(Object.keys(unlinked), ['number'], 'the answer says nothing about the order');
  const none = await openGuestTicket(web, {...msg, orderNumber: null}, ctx);
  assert.equal((await row(none.number)).order_id, null);
  // Validation.
  for (const bad of [{email: 'nope'}, {name: '  '}, {subject: ''}, {body: ''}, {body: 'x'.repeat(3801)}, {categoryCode: 'no_such_topic'}])
    await assert.rejects(openGuestTicket(web, {...msg, orderNumber: null, ...bad}, ctx), DomainError, JSON.stringify(bad).slice(0, 40));
  assert.equal((await q(`select count(*)::int n from support_tickets`))[0].n, 3, 'refused messages stored nothing');
  // Staff: listed, opened, with the guest's contact; an alert was raised for each.
  const list = await listTickets(admin, agent, {status: 'all', priority: 'all', assignee: 'all', page: 1});
  assert.equal(list.rows.length, 3);
  const [{id}] = await q(`select id from support_tickets where number = $1`, [linked.number]);
  const t = await getTicket(admin, agent, id);
  assert.deepEqual([t.ticket.contact_email, t.ticket.order_number, t.messages.length], ['priya.gift@example.com', 'KTS-SW-0001', 1]);
  assert.equal((await q(`select count(*)::int n from staff_notifications where kind = 'support.ticket'`))[0].n, 3);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'support.guest_ticket_open' and customer_id is null`))[0].n, 3);
  // The store's role still cannot read an internal note on a guest's ticket.
  await q(`insert into support_messages (ticket_id, author_type, staff_user_id, body, is_internal) values ($1, 'staff', $2, 'Internal: check the courier', true)`, [id, agent.staffId]);
  assert.equal((await web.selectFrom('support_messages').select('id').where('ticket_id', '=', id).execute()).length, 1, 'only the customer\'s own message');
});
