/* M12 reviews: verified purchase only (per the eligibility setting, closed until chosen), one review per order line,
   photos re-encoded without metadata, nothing public before staff approval, moderation with stale checks and audit,
   ratings from approved reviews only. Customer actions run as the WEBSITE role, moderation as the ADMIN role.
   LOCAL test database only. Leaves 2 customers and 4 fixture orders (the append-only audit log refers to them; see
   run-e2e.mjs); moves no stock and leaves the catalogue untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import sharp from 'sharp';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, NotFoundError, moderateReviewInput, settingUpdateInput, submitReviewInput} from '@kitsyuu/contracts';
import {
  approvedReviews, customerReviewState, listReviews, moderateReview, ratingSummary, reviewPhoto, submitReview, updateSetting, REVIEW_MAX_PHOTOS,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 3});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 3});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm12.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'm12 test passphrase', fullName: role}, ctx)).token);
}
/** A customer with one order line per [status, productId]. Fixtures are written directly (no stock is moved). */
async function customerWith(email, lines) {
  const [c] = await q(`insert into customers (email, full_name, status) values ($1, 'Asha Rao', 'active') returning id`, [email]);
  const items = [];
  for (const [i, [status, productId]] of lines.entries()) {
    const [o] = await q(`insert into orders (order_number, customer_id, status, subtotal_paise, total_paise) values ($1, $2, $3, 100, 100) returning id`, [`KTS-M12-${email[0]}${i}`, c.id, status]);
    const [it] = await q(`insert into order_items (order_id, product_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, $2, 'SKU', 'Item', 'M', 100, 1, 100) returning id`, [o.id, productId]);
    items.push(it.id);
  }
  return {p: {customerId: c.id}, items};
}
const input = (orderItemId, over = {}) => submitReviewInput.parse({orderItemId, rating: '5', title: 'Great fit', body: 'Loved the fabric and the cut.', displayName: 'Asha', ...over});
const photoWithGps = () => sharp({create: {width: 2400, height: 1800, channels: 3, background: '#335577'}})
  .withMetadata({exif: {IFD0: {Make: 'TestCam'}, IFD3: {GPSLatitudeRef: 'N', GPSLatitude: '12/1 58/1 0/1'}}}).jpeg().toBuffer();

let root, support, inventory, asha, ravi, P;

test('setup: reviews closed until the business chooses; permissions seeded for the right roles', async () => {
  const holders = (await q(`select distinct r.code from role_permissions rp join roles r on r.id = rp.role_id where rp.permission_code = 'reviews.moderate' order by 1`)).map(r => r.code);
  assert.deepEqual(holders, ['admin', 'manager', 'super_admin', 'support']);
  root = await staff('m12.root@test.local', 'super_admin');
  support = await staff('m12.support@test.local', 'support');
  inventory = await staff('m12.inventory@test.local', 'inventory_manager');   // no reviews.* permission
  P = (await q(`select id from products order by id limit 2`)).map(r => r.id);
  asha = await customerWith('asha.m12@test.local', [['delivered', P[0]], ['shipped', P[1]], ['pending_payment', P[1]]]);
  ravi = await customerWith('ravi.m12@test.local', [['delivered', P[0]]]);
  const state = await customerReviewState(web, asha.p);
  assert.deepEqual([state.eligibility, state.reviewable.length], [null, 0]);
  await assert.rejects(submitReview(web, asha.p, input(asha.items[0]), [], ctx), ForbiddenError);
});

test('eligibility "delivered": only delivered lines of the customer; one review per line; someone else\'s line looks missing', async () => {
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'reviews.eligibility', value: 'delivered'}), ctx);
  const state = await customerReviewState(web, asha.p);
  assert.deepEqual(state.reviewable.map(i => i.id), [asha.items[0]]);
  await assert.rejects(submitReview(web, asha.p, input(asha.items[1]), [], ctx), ConflictError, 'shipped is not delivered');
  await assert.rejects(submitReview(web, asha.p, input(ravi.items[0]), [], ctx), NotFoundError);
  assert.throws(() => input(asha.items[0], {body: 'short'}));
  assert.throws(() => input(asha.items[0], {rating: '6'}));
  const r = await submitReview(web, asha.p, input(asha.items[0]), [], ctx);
  await assert.rejects(submitReview(web, asha.p, input(asha.items[0]), [], ctx), ConflictError);
  assert.deepEqual((await q(`select status, customer_id from reviews where id = $1`, [r.id]))[0], {status: 'pending', customer_id: asha.p.customerId});
  assert.equal((await q(`select actor_type, action from audit_logs where entity_id = $1`, [r.id]))[0].action, 'review.submit');
});

test('eligibility "paid": shipped lines open up, unpaid never; photos re-encoded to WebP without metadata, max count enforced', async () => {
  await updateSetting(admin, root, settingUpdateInput.parse({key: 'reviews.eligibility', value: 'paid'}), ctx);
  assert.deepEqual((await customerReviewState(web, asha.p)).reviewable.map(i => i.id), [asha.items[1]]);
  const photo = await photoWithGps();
  assert.ok((await sharp(photo).metadata()).exif, 'the upload carries EXIF');
  await assert.rejects(submitReview(web, asha.p, input(asha.items[1]), Array(REVIEW_MAX_PHOTOS + 1).fill({bytes: photo}), ctx), DomainError);
  await assert.rejects(submitReview(web, asha.p, input(asha.items[1]), [{bytes: Buffer.from('not an image')}], ctx), DomainError);
  const r = await submitReview(web, asha.p, input(asha.items[1], {rating: '3', title: ''}), [{bytes: photo}, {bytes: photo}], ctx);
  const stored = await q(`select position, width, height, bytes from review_photos where review_id = $1 order by position`, [r.id]);
  assert.deepEqual(stored.map(s => [s.position, s.width, s.height]), [[0, 1600, 1200], [1, 1600, 1200]]);
  const meta = await sharp(stored[0].bytes).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.exif, undefined, 'metadata (incl. GPS) removed');
});

test('nothing is public before approval; moderation needs reviews.moderate, a reason to reject, and a fresh page', async () => {
  const pending = (await listReviews(admin, support, {status: 'pending', page: 1})).rows;
  assert.equal(pending.length, 2);
  assert.deepEqual(await approvedReviews(web, P[0]), []);
  const photoId = (await q(`select id from review_photos order by position limit 1`))[0].id;
  assert.equal(await reviewPhoto(web, photoId), null, 'unapproved photo is not served to the store');
  assert.ok(await reviewPhoto(admin, photoId, support), 'staff with reviews.read can see it');
  await assert.rejects(listReviews(admin, inventory, {page: 1}), ForbiddenError);
  const first = pending.find(r => r.product_id === P[0]), second = pending.find(r => r.product_id === P[1]);
  await assert.rejects(moderateReview(admin, inventory, moderateReviewInput.parse({reviewId: first.id, decision: 'approved', expectedStatus: 'pending'}), ctx), ForbiddenError);
  await assert.rejects(moderateReview(admin, support, moderateReviewInput.parse({reviewId: second.id, decision: 'rejected', expectedStatus: 'pending'}), ctx), DomainError);
  await moderateReview(admin, support, moderateReviewInput.parse({reviewId: first.id, decision: 'approved', expectedStatus: 'pending'}), ctx);
  await assert.rejects(moderateReview(admin, support, moderateReviewInput.parse({reviewId: first.id, decision: 'rejected', note: 'x', expectedStatus: 'pending'}), ctx), ConflictError);
  await moderateReview(admin, support, moderateReviewInput.parse({reviewId: second.id, decision: 'approved', expectedStatus: 'pending'}), ctx);
  const pub = await approvedReviews(web, P[1]);
  assert.equal(pub.length, 1); assert.equal(pub[0].photos.length, 2);
  assert.ok(await reviewPhoto(web, pub[0].photos[0].id), 'approved photo is served');
  assert.ok(!('customer_id' in pub[0]) && !JSON.stringify(pub).includes('@'), 'no customer ids or emails in public data');
  const ratings = await ratingSummary(web);
  assert.deepEqual([ratings.get(P[0]), ratings.get(P[1])], [{average: 5, count: 1}, {average: 3, count: 1}]);
  // The store reads only these totals, with the public key (anon): no review text, names or ids of customers.
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role anon');
    const view = (await c.query('select * from v_product_ratings order by product_id')).rows;
    assert.deepEqual(view.map(v => Object.keys(v).sort()), [['average', 'count', 'product_id'], ['average', 'count', 'product_id']]);
    await assert.rejects(c.query('select * from reviews'), /permission denied/);
  } finally { await c.query('rollback'); c.release(); }
  // Taking a published review down hides it and its photos again.
  await moderateReview(admin, root, moderateReviewInput.parse({reviewId: second.id, decision: 'rejected', note: 'Photo shows another brand', expectedStatus: 'approved'}), ctx);
  assert.deepEqual(await approvedReviews(web, P[1]), []);
  assert.equal(await reviewPhoto(web, pub[0].photos[0].id), null);
  const log = (await q(`select action, staff_id is not null s from audit_logs where entity_type = 'reviews' and action like 'review.%' order by id`)).map(r => r.action);
  assert.deepEqual(log, ['review.submit', 'review.submit', 'review.approve', 'review.approve', 'review.reject']);
  const mine = (await customerReviewState(web, asha.p)).reviews.map(r => r.status).sort();
  assert.deepEqual(mine, ['approved', 'rejected'], 'the customer sees where each review stands');
});

test('database guards: the website role cannot publish or edit; the admin role cannot change review text', async () => {
  await assert.rejects(web.insertInto('reviews').values({product_id: P[0], customer_id: ravi.p.customerId, order_item_id: ravi.items[0], rating: 5, body: 'Fake approved review', display_name: 'X', status: 'approved', moderated_at: new Date()}).execute(), /row-level security|violates/);
  const [r] = await q(`select id from reviews limit 1`);
  await assert.rejects(web.updateTable('reviews').set({status: 'approved'}).where('id', '=', r.id).execute(), /permission denied/);
  await assert.rejects(admin.updateTable('reviews').set({body: 'edited by staff'}).where('id', '=', r.id).execute(), /permission denied/);
  await assert.rejects(q(`insert into reviews (product_id, customer_id, order_item_id, rating, body, display_name) values ($1, $2, $3, 0, 'x', 'x')`, [P[0], ravi.p.customerId, ravi.items[0]]), /check constraint/);
});

test.after(async () => {
  await q(`delete from settings where key = 'reviews.eligibility'`);
  await admin.destroy(); await web.destroy(); await owner.destroy(); await pool.end();
});
