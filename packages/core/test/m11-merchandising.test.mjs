/* M11 merchandising: collections (hidden until shown, store visibility through the real RLS policies), collection order
   and members, "Complete the look" links, bulk status and SEO text. LOCAL test database only. Leaves the catalogue
   exactly as found (22 products, all active, same sizes and images). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, createCollectionInput, updateProductInput} from '@kitsyuu/contracts';
import {
  bulkSetProductStatus, createCollection, getCollection, getProduct, listCollections, listRelated, moveCollection, moveCollectionMember, moveRelated,
  MAX_RELATED, setCollectionActive, setCollectionMember, setRelated, updateCollection, updateProduct,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm11.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm11 test passphrase', fullName: role}, ctx)).token);
}
/** What the storefront (anon, public key) reads, through the real RLS policies (the grant mirrors Supabase's default). */
async function anon(sqlText) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('grant select on public.collections, public.collection_products to anon');
    await c.query('set local role anon');
    return (await c.query(sqlText)).rows;
  } finally { await c.query('rollback'); c.release(); }
}

let manager, support, admin, P;

test('migration 2200: existing collections stay active and visible; nothing else changed', async () => {
  // (Men, Women and Sale were added hidden and empty by the client change request; the store still sees only New Arrivals.)
  assert.deepEqual(await q(`select id, is_active from collections order by id`), [{id: 'men', is_active: false}, {id: 'new-arrivals', is_active: true}, {id: 'sale', is_active: false}, {id: 'women', is_active: false}]);
  assert.deepEqual((await anon(`select id from collections`)).map(r => r.id), ['new-arrivals']);
  assert.ok((await anon(`select count(*)::int n from collection_products`))[0].n > 0);
  assert.deepEqual(await q(`select count(*)::int n from products where seo_title is not null or seo_description is not null`), [{n: 0}]);
  manager = await staff('m11.manager@test.local', 'manager');     // categories.write + products.write
  admin = await staff('m11.admin@test.local', 'admin');           // + products.publish (2026-10-01)
  support = await staff('m11.support@test.local', 'support');     // read only
  P = (await q(`select id from products order by id`)).map(r => r.id);
});

test('collections: created hidden, invisible to the store until shown with an active product; audited', async () => {
  await assert.rejects(createCollection(db, support, createCollectionInput.parse({id: 'monsoon-edit', label: 'Monsoon Edit'}), ctx), ForbiddenError);
  await createCollection(db, manager, createCollectionInput.parse({id: 'monsoon-edit', label: 'Monsoon Edit'}), ctx);
  await assert.rejects(createCollection(db, manager, createCollectionInput.parse({id: 'monsoon-edit', label: 'Again'}), ctx), ConflictError);
  assert.equal((await listCollections(db, manager)).find(c => c.id === 'monsoon-edit').isActive, false);
  await assert.rejects(setCollectionActive(db, manager, {collectionId: 'monsoon-edit', active: true, expectedActive: false}, ctx), ConflictError, 'empty collection');
  for (const id of P.slice(0, 3)) await setCollectionMember(db, manager, {collectionId: 'monsoon-edit', productId: id, member: true}, ctx);
  assert.deepEqual(await anon(`select * from collection_products where collection_id = 'monsoon-edit'`), [], 'hidden: members invisible to the store');
  await setCollectionActive(db, manager, {collectionId: 'monsoon-edit', active: true, expectedActive: false}, ctx);
  assert.deepEqual((await anon(`select id from collections order by id`)).map(r => r.id), ['monsoon-edit', 'new-arrivals']);
  assert.equal((await anon(`select count(*)::int n from collection_products where collection_id = 'monsoon-edit'`))[0].n, 3);
  await moveCollectionMember(db, manager, {collectionId: 'monsoon-edit', productId: P[2], direction: 'up'}, ctx);
  assert.deepEqual((await getCollection(db, manager, 'monsoon-edit')).members.map(m => m.id), [P[0], P[2], P[1]]);
  await moveCollection(db, manager, {collectionId: 'monsoon-edit', direction: 'up'}, ctx);
  assert.deepEqual((await listCollections(db, manager)).map(c => c.id), ['new-arrivals', 'men', 'women', 'monsoon-edit', 'sale']);
  await updateCollection(db, manager, {collectionId: 'monsoon-edit', label: 'Monsoon', expectedLabel: 'Monsoon Edit'}, ctx);
  await assert.rejects(updateCollection(db, manager, {collectionId: 'monsoon-edit', label: 'X', expectedLabel: 'Monsoon Edit'}, ctx), ConflictError);
  const acts = (await q(`select action from audit_logs where entity_type = 'collections' and entity_id = 'monsoon-edit' order by id`)).map(r => r.action);
  assert.deepEqual(acts, ['collection.create', 'collection.add', 'collection.add', 'collection.add', 'collection.status_update', 'collection.reorder_product', 'collection.reorder', 'collection.update']);
  // Clean up: hide, empty and delete the test collection so the catalogue is as found.
  await setCollectionActive(db, manager, {collectionId: 'monsoon-edit', active: false, expectedActive: true}, ctx);
  for (const id of P.slice(0, 3)) await setCollectionMember(db, manager, {collectionId: 'monsoon-edit', productId: id, member: false}, ctx);
  await q(`delete from collections where id = 'monsoon-edit'`);
});

test('"Complete the look": link, order, remove; no self-links; at most MAX_RELATED; needs products.write', async () => {
  const [a, ...others] = P;
  const seeded = await q(`select product_id, related_id, kind, position from product_relations where product_id = $1`, [a]);
  await q(`delete from product_relations where product_id = $1`, [a]);          // start from none; the seed links are restored below
  await assert.rejects(setRelated(db, manager, {productId: a, relatedId: a, linked: true}, ctx), DomainError);
  await assert.rejects(setRelated(db, support, {productId: a, relatedId: others[0], linked: true}, ctx), ForbiddenError);
  for (const r of others.slice(0, MAX_RELATED)) await setRelated(db, manager, {productId: a, relatedId: r, linked: true}, ctx);
  await assert.rejects(setRelated(db, manager, {productId: a, relatedId: others[MAX_RELATED], linked: true}, ctx), ConflictError);
  await moveRelated(db, manager, {productId: a, relatedId: others[1], direction: 'up'}, ctx);
  const list = await listRelated(db, manager, a);
  assert.deepEqual(list.related.slice(0, 2).map(r => r.id), [others[1], others[0]]);
  assert.ok(!list.candidates.some(c => c.id === a || c.id === others[0]), 'candidates exclude itself and linked ones');
  for (const r of others.slice(0, MAX_RELATED)) await setRelated(db, manager, {productId: a, relatedId: r, linked: false}, ctx);
  assert.deepEqual((await listRelated(db, manager, a)).related, []);
  for (const r of seeded) await q(`insert into product_relations (product_id, related_id, kind, position) values ($1, $2, $3, $4)`, [r.product_id, r.related_id, r.kind, r.position]);
});

test('bulk status: each product checked like one-by-one; a product that cannot be shown is reported, not forced', async () => {
  const [x, y] = P.slice(-2);
  await assert.rejects(bulkSetProductStatus(db, support, {productIds: [x], status: 'draft'}, ctx), ForbiddenError);
  assert.deepEqual(await bulkSetProductStatus(db, manager, {productIds: [x, y, x], status: 'draft'}, ctx), {done: [x, y], failed: []});
  assert.deepEqual(await q(`select status from products where id in ($1, $2)`, [x, y]), [{status: 'draft'}, {status: 'draft'}]);
  await q(`update product_variants set is_active = false where product_id = $1`, [y]);        // y now has no size to sell
  await assert.rejects(bulkSetProductStatus(db, manager, {productIds: [x], status: 'active'}, ctx), ForbiddenError, 'publishing needs products.publish');
  const r = await bulkSetProductStatus(db, admin, {productIds: [x, y], status: 'active'}, ctx);
  assert.deepEqual(r.done, [x]); assert.equal(r.failed[0].productId, y);
  await q(`update product_variants set is_active = true where product_id = $1`, [y]);
  assert.deepEqual((await bulkSetProductStatus(db, admin, {productIds: [y], status: 'active'}, ctx)).done, [y]);
  assert.deepEqual(await q(`select count(*)::int n from products where status <> 'active'`), [{n: 0}]);
});

test('SEO text: optional, length-limited, audited; older forms leave it unchanged', async () => {
  const id = P[0], p = (await getProduct(db, manager, id)).product;
  const base = {productId: id, name: p.name, description: p.description, categoryId: p.category_id, subcategoryId: p.subcategory_id ?? '',
    colourLabel: p.colour_label ?? '', material: p.material ?? '', care: p.care ?? '', origin: p.origin ?? '', features: p.features.join('\n'), isFeatured: p.is_featured ? 'on' : 'off'};
  assert.throws(() => updateProductInput.parse({...base, seoTitle: 'x'.repeat(71)}));
  assert.deepEqual(await updateProduct(db, manager, updateProductInput.parse({...base, seoTitle: 'Balloon trousers | KITSYUU', seoDescription: 'Wide olive balloon trousers.'}), ctx), {changed: 2});
  assert.deepEqual(await updateProduct(db, manager, updateProductInput.parse(base), ctx), {changed: 0});
  await updateProduct(db, manager, updateProductInput.parse({...base, seoTitle: '', seoDescription: ''}), ctx);
  assert.deepEqual(await q(`select seo_title, seo_description from products where id = $1`, [id]), [{seo_title: null, seo_description: null}]);
  await assert.rejects(q(`update products set seo_title = '' where id = $1`, [id]), /products_seo_lengths/);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
