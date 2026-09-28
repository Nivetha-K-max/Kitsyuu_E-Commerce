/* Product attributes (store filters): definitions, values, product tagging, permissions, audit, and what the storefront
   (anon, public key) can see through the real RLS policies. LOCAL test database only. Services run as kitsyuu_admin.
   Leaves the catalogue as it found it (no product, variant, image or stock change). */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, addAttributeValueInput, createAttributeInput, setProductAttributesInput} from '@kitsyuu/contracts';
import {
  addAttributeValue, createAttribute, deleteAttributeValue, getProductAttributes, listAttributes, moveAttribute, moveAttributeValue,
  renameAttributeValue, setAttributeActive, setProductAttributes, updateAttribute,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'attributes.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'attributes test passphrase', fullName: role}, ctx)).token);
}
/** What the storefront (anon, public key) reads, through the real RLS policies (see m4-catalogue.test.mjs for the grant). */
async function anon(sqlText) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role anon');
    return (await c.query(sqlText)).rows;
  } finally { await c.query('rollback'); c.release(); }
}
const tags = async p => (await getProductAttributes(db, manager, p)).sort();

let manager, support, P1, P2;

test('setup: no attributes exist (nothing is pre-filled), staff with and without write access', async () => {
  assert.deepEqual(await q('select count(*)::int n from attributes'), [{n: 0}]);
  assert.deepEqual(await q('select count(*)::int n from attribute_values'), [{n: 0}]);
  manager = await staff('attr.manager@test.local', 'manager');     // categories.write + products.write
  support = await staff('attr.support@test.local', 'support');     // products.read only
  [P1, P2] = (await q(`select id from products order by id limit 2`)).map(r => r.id);
});

test('create attribute: audited; duplicate and reserved ids refused; needs categories.write', async () => {
  await createAttribute(db, manager, createAttributeInput.parse({id: 'fabric', label: 'Fabric'}), ctx);
  await createAttribute(db, manager, createAttributeInput.parse({id: 'occasion', label: 'Occasion', description: 'Where to wear it'}), ctx);
  await assert.rejects(createAttribute(db, manager, createAttributeInput.parse({id: 'fabric', label: 'Again'}), ctx), ConflictError);
  await assert.rejects(createAttribute(db, manager, createAttributeInput.parse({id: 'size', label: 'Size'}), ctx), DomainError);
  await assert.rejects(createAttribute(db, support, createAttributeInput.parse({id: 'brand', label: 'Brand'}), ctx), ForbiddenError);
  assert.throws(() => createAttributeInput.parse({id: 'Bad Id!', label: 'x'}));
  assert.deepEqual((await q(`select action, entity_id from audit_logs where action = 'attribute.create' order by id`)).map(r => r.entity_id), ['fabric', 'occasion']);
});

test('values: slug from the name, duplicates refused, rename and reorder audited', async () => {
  for (const label of ['Cotton', 'Linen', 'Denim']) await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'fabric', label}), ctx);
  const cb = await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'fabric', label: 'Cotton / Blend'}), ctx);
  assert.equal(cb.slug, 'cotton-blend');
  await assert.rejects(addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'fabric', label: 'COTTON'}), ctx), ConflictError);
  await assert.rejects(addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'fabric', label: 'コットン'}), ctx), DomainError);
  await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'fabric', label: 'コットン', slug: 'cotton-jp'}), ctx);
  await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'occasion', label: 'Street'}), ctx);
  await renameAttributeValue(db, manager, {attributeId: 'fabric', slug: 'linen', label: 'Pure linen'}, ctx);
  await moveAttributeValue(db, manager, {attributeId: 'fabric', slug: 'denim', direction: 'up'}, ctx);
  const fabric = (await listAttributes(db, manager)).find(a => a.id === 'fabric');
  assert.deepEqual(fabric.values.map(v => v.slug), ['cotton', 'denim', 'linen', 'cotton-blend', 'cotton-jp']);
  assert.equal(fabric.values.find(v => v.slug === 'linen').label, 'Pure linen');
  await moveAttribute(db, manager, {attributeId: 'occasion', direction: 'up'}, ctx);
  assert.deepEqual((await listAttributes(db, manager)).map(a => a.id), ['occasion', 'fabric']);
  assert.deepEqual(await listAttributes(db, support).then(l => l.length), 2);   // products.read may read definitions (product page)
});

test('tagging a product: only differences written, audited; unknown values refused; needs products.write', async () => {
  const set = (p, values, who = manager) => setProductAttributes(db, who, setProductAttributesInput.parse({productId: p, values}), ctx);
  assert.deepEqual(await set(P1, [{attributeId: 'fabric', slug: 'cotton'}, {attributeId: 'fabric', slug: 'denim'}, {attributeId: 'occasion', slug: 'street'}]), {changed: 3});
  assert.deepEqual(await tags(P1), ['fabric:cotton', 'fabric:denim', 'occasion:street']);
  assert.deepEqual(await set(P1, [{attributeId: 'fabric', slug: 'cotton'}, {attributeId: 'occasion', slug: 'street'}]), {changed: 1});
  assert.deepEqual(await set(P1, [{attributeId: 'occasion', slug: 'street'}, {attributeId: 'fabric', slug: 'cotton'}]), {changed: 0});
  await assert.rejects(set(P1, [{attributeId: 'fabric', slug: 'silk'}]), DomainError);
  await assert.rejects(set(P2, [{attributeId: 'fabric', slug: 'linen'}], support), ForbiddenError);
  await set(P2, [{attributeId: 'fabric', slug: 'linen'}]);
  const log = await q(`select metadata from audit_logs where action = 'product.attributes_update' and entity_id = $1 order by id`, [P1]);
  assert.equal(log.length, 2);
  assert.deepEqual(log[1].metadata, {added: [], removed: ['fabric:denim']});
  assert.deepEqual(await tags(P1), ['fabric:cotton', 'occasion:street'], 'the refused call changed nothing');
});

test('a value in use cannot be deleted; an unused one can', async () => {
  await assert.rejects(deleteAttributeValue(db, manager, {attributeId: 'fabric', slug: 'cotton'}, ctx), ConflictError);
  await deleteAttributeValue(db, manager, {attributeId: 'fabric', slug: 'cotton-jp'}, ctx);
  assert.deepEqual(await q(`select count(*)::int n from attribute_values where slug = 'cotton-jp'`), [{n: 0}]);
});

test('storefront (anon) sees active attributes, their values and product tags only; deactivating hides them', async () => {
  const seen = async () => ({
    attrs: (await anon('select id from attributes order by id')).map(r => r.id),
    values: (await anon('select count(*)::int n from attribute_values'))[0].n,
    tags: (await anon('select count(*)::int n from product_attribute_values'))[0].n,
  });
  assert.deepEqual(await seen(), {attrs: ['fabric', 'occasion'], values: 5, tags: 3});
  await setAttributeActive(db, manager, {attributeId: 'fabric', active: false, expectedActive: true}, ctx);
  assert.deepEqual(await seen(), {attrs: ['occasion'], values: 1, tags: 1});
  await assert.rejects(setAttributeActive(db, manager, {attributeId: 'fabric', active: true, expectedActive: true}, ctx), ConflictError);
  await setAttributeActive(db, manager, {attributeId: 'fabric', active: true, expectedActive: false}, ctx);
  assert.deepEqual((await seen()).attrs, ['fabric', 'occasion']);
  await assert.rejects(anon(`insert into attributes (id, label) values ('hack', 'Hack')`), /permission denied|row-level security/);
});

test('rename attribute: stale edit refused; tags cleaned up', async () => {
  await updateAttribute(db, manager, {attributeId: 'occasion', label: 'Occasion', description: 'Where you wear it', expectedLabel: 'Occasion'}, ctx);
  await assert.rejects(updateAttribute(db, manager, {attributeId: 'occasion', label: 'X', description: '', expectedLabel: 'Old name'}, ctx), ConflictError);
  // Clean up the tags so the catalogue is exactly as found.
  for (const p of [P1, P2]) await setProductAttributes(db, manager, setProductAttributesInput.parse({productId: p, values: []}), ctx);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); });
