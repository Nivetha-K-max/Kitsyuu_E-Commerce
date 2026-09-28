/* M17: customer emails (off until switched on; logged; a failure never throws), the store announcement (drafts private,
   only the published text is public), customer notes (audited without their text) and the cart/wishlist view.
   LOCAL test database only. Adds 1 customer and 2 fixture orders (no stock moved; run-e2e.mjs expects them). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {DomainError, ForbiddenError, announcementInput, settingUpdateInput} from '@kitsyuu/contracts';
import {
  addCustomerNote, customerBasket, getAnnouncementAdmin, listCustomerNotes, listNotificationLog, notifyOrderStatus, saveAnnouncement, unpublishAnnouncement, updateSetting,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm17.test', requestId: 'test'};
const sent = [];
const mailer = {kind: 'memory', async send(m) { sent.push(m); }};
const broken = {kind: 'broken', async send() { throw new Error('SMTP says no'); }};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm17 test passphrase', fullName: role}, ctx)).token);
}
/** What the store (anon, public key) can read, through the real RLS policy. */
async function anon(sqlText) {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query('set local role anon'); return (await c.query(sqlText)).rows; }
  finally { await c.query('rollback'); c.release(); }
}

let root, manager, support, inventory, C, shipped, cancelled;

test('setup and emails: off by default (nothing sent, nothing logged); on → sent with tracking and logged; failures logged, never thrown', async () => {
  root = await staff('m17.root@test.local', 'super_admin');
  manager = await staff('m17.manager@test.local', 'manager');
  support = await staff('m17.support@test.local', 'support');
  inventory = await staff('m17.inventory@test.local', 'inventory_manager');
  [C] = await q(`insert into customers (email, full_name, status) values ('asha.m17@test.local', 'Asha', 'active') returning id`);
  const contact = JSON.stringify({name: 'Asha', email: 'asha.m17@test.local'});
  [shipped] = await q(`insert into orders (order_number, customer_id, status, subtotal_paise, total_paise, contact) values ('KTS-M17-1', $1, 'shipped', 100, 100, $2) returning id`, [C.id, contact]);
  [cancelled] = await q(`insert into orders (order_number, customer_id, status, subtotal_paise, total_paise, contact) values ('KTS-M17-2', $1, 'cancelled', 100, 100, $2) returning id`, [C.id, contact]);
  await q(`insert into shipments (order_id, carrier_code, tracking_number, packing_state, shipped_at) values ($1, 'manual', 'AWB123', 'packed', now())`, [shipped.id]);
  assert.deepEqual(await notifyOrderStatus(db, mailer, shipped.id, 'order.shipped'), {sent: false, reason: 'off'});
  assert.equal(sent.length, 0); assert.deepEqual(await q(`select count(*)::int n from notification_log`), [{n: 0}]);
  await updateSetting(db, root, settingUpdateInput.parse({key: 'notifications.order_shipped', value: 'on'}), ctx);
  assert.deepEqual(await notifyOrderStatus(db, mailer, shipped.id, 'order.shipped', {storeUrl: 'https://store.test'}), {sent: true});
  assert.equal(sent[0].to, 'asha.m17@test.local');
  assert.match(sent[0].subject, /KTS-M17-1 has shipped/);
  assert.match(sent[0].text, /Tracking number: AWB123/); assert.match(sent[0].text, /https:\/\/store\.test\/account\/orders/);
  assert.deepEqual(await notifyOrderStatus(db, mailer, cancelled.id, 'order.cancelled'), {sent: false, reason: 'off'}, 'each email has its own switch');
  await updateSetting(db, root, settingUpdateInput.parse({key: 'notifications.order_cancelled', value: 'on'}), ctx);
  assert.deepEqual(await notifyOrderStatus(db, broken, cancelled.id, 'order.cancelled'), {sent: false, reason: 'failed'});
  assert.deepEqual(await notifyOrderStatus(db, mailer, shipped.id, 'order.cancelled'), {sent: false, reason: 'no_recipient'}, 'wrong state: no email');
  const log = await listNotificationLog(db, root);
  assert.deepEqual(log.map(l => [l.event, l.status, l.order_number]), [['order.cancelled', 'failed', 'KTS-M17-2'], ['order.shipped', 'sent', 'KTS-M17-1']]);
  assert.equal(log[0].error, 'SMTP says no');
  await assert.rejects(listNotificationLog(db, manager), ForbiddenError);
});

test('announcement: validated; drafts are private, the published text is public; take down; content.manage only', async () => {
  await assert.rejects(saveAnnouncement(db, support, announcementInput.parse({text: 'Hi'}), ctx), ForbiddenError);
  assert.throws(() => announcementInput.parse({text: 'x', href: 'javascript:alert(1)'}));
  await saveAnnouncement(db, manager, announcementInput.parse({text: 'New drop Friday', href: '/shop?collection=new-arrivals'}), ctx);
  assert.deepEqual(await anon(`select status from site_content`), [], 'a draft is never public');
  await saveAnnouncement(db, manager, announcementInput.parse({text: 'New drop Friday', href: '/shop?collection=new-arrivals', publish: 'yes'}), ctx);
  assert.deepEqual((await anon(`select status, content from site_content`)), [{status: 'published', content: {text: 'New drop Friday', href: '/shop?collection=new-arrivals'}}]);
  await saveAnnouncement(db, manager, announcementInput.parse({text: 'Edited draft'}), ctx);
  assert.equal((await anon(`select content->>'text' t from site_content`))[0].t, 'New drop Friday', 'editing the draft does not change what is live');
  const a = await getAnnouncementAdmin(db, manager);
  assert.deepEqual([a.draft.text, a.published.text], ['Edited draft', 'New drop Friday']);
  await unpublishAnnouncement(db, manager, ctx);
  assert.deepEqual(await anon(`select status from site_content`), []);
  assert.deepEqual((await q(`select action from audit_logs where entity_type = 'site_content' order by id`)).map(r => r.action), ['content.save', 'content.publish', 'content.save', 'content.unpublish']);
});

test('customer notes (text never copied into the audit log) and the cart / wishlist view', async () => {
  await assert.rejects(addCustomerNote(db, inventory, {customerId: C.id, body: 'x'}, ctx), ForbiddenError);
  await assert.rejects(addCustomerNote(db, support, {customerId: C.id, body: '   '}, ctx), DomainError);
  await addCustomerNote(db, support, {customerId: C.id, body: 'Called about sizing; prefers email.'}, ctx);
  assert.deepEqual((await listCustomerNotes(db, manager, C.id)).map(n => [n.body, n.author]), [['Called about sizing; prefers email.', 'm17.support@test.local']]);
  const audit = await q(`select metadata, before_data, after_data from audit_logs where action = 'customer.note_add'`);
  assert.ok(!JSON.stringify(audit).includes('sizing'), 'the note text is not in the audit log');
  const [v] = await q(`select v.id, p.id pid from product_variants v join products p on p.id = v.product_id order by v.sku limit 1`);
  const [cart] = await q(`insert into carts (customer_id, status) values ($1, 'active') returning id`, [C.id]);
  await q(`insert into cart_items (cart_id, variant_id, qty) values ($1, $2, 2)`, [cart.id, v.id]);
  const [wl] = await q(`insert into wishlists (customer_id) values ($1) returning id`, [C.id]);
  await q(`insert into wishlist_items (wishlist_id, product_id) values ($1, $2)`, [wl.id, v.pid]);
  const b = await customerBasket(db, support, C.id);
  assert.deepEqual([b.cart.length, b.cart[0].qty, b.wishlist.length], [1, 2, 1]);
  await assert.rejects(customerBasket(db, inventory, C.id), ForbiddenError);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
