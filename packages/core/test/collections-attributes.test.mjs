/* Client change request: collections grouped as Men / Women / Sale, and attributes as tags (add, rename, deactivate,
   reactivate, one or several values, no case-duplicates), product and bulk assignment, product list filters, what the
   storefront sees through the real RLS policies, the Colour attribute, permissions and audit. LOCAL test database only.
   Leaves products, variants, images and stock as found. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {
  ConflictError, DomainError, ForbiddenError, addAttributeValueInput, bulkEditInput, createAttributeInput, createCollectionInput, productCollectionsInput,
  productListQuery, setAttributeValueActiveInput, setProductAttributesInput, updateAttributeInput, updateCollectionInput,
} from '@kitsyuu/contracts';
import {
  addAttributeValue, bulkEditProducts, createAttribute, createCollection, createCollectionGroup, getCollection, getProductAttributes, getProductCollections,
  listAttributes, listCollectionGroups, listCollections, listProducts, renameAttributeValue, setAttributeActive, setAttributeValueActive, setCollectionActive,
  setProductAttributes, setProductCollections, updateAttribute, updateCollection,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'collections-attributes.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'tags test passphrase', fullName: role}, ctx)).token);
}
/** What the storefront (anon, public key) reads, through the real RLS policies. */
async function anon(sqlText) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    // Supabase grants anon select on public tables by default; the local test database does not (rolled back below). RLS decides the rows.
    await c.query('grant select on public.collections, public.collection_products, public.attribute_values, public.product_attribute_values to anon');
    await c.query('set local role anon');
    return (await c.query(sqlText)).rows;
  }
  finally { await c.query('rollback'); c.release(); }
}

let manager, support, P;
const stockBefore = async () => (await q(`select coalesce(sum(stock_qty), 0)::int n from product_variants`))[0].n;
let units;

test('migration: Men, Women and Sale exist as groups and hidden, empty collections; New Arrivals and its products unchanged', async () => {
  manager = await staff('tags.manager@test.local', 'manager');     // categories.write + products.write
  support = await staff('tags.support@test.local', 'support');     // read only
  P = (await q(`select id from products where status = 'active' order by id`)).map(r => r.id);
  units = await stockBefore();
  assert.deepEqual((await listCollectionGroups(db, manager)).map(g => g.label), ['Men', 'Women', 'Sale']);
  const cols = await listCollections(db, manager);
  for (const [id, label] of [['men', 'Men'], ['women', 'Women'], ['sale', 'Sale']]) {
    const c = cols.find(x => x.id === id);
    assert.deepEqual([c.label, c.groupId, c.isActive, c.products], [label, id, false, 0], `${id}: hidden and empty (no product is guessed into it)`);
  }
  const na = cols.find(c => c.id === 'new-arrivals');
  assert.ok(na.isActive && na.products > 0 && na.groupId === null, 'existing collection kept, ungrouped');
  assert.deepEqual((await anon(`select id from collections order by id`)).map(r => r.id), ['new-arrivals'], 'the store sees no hidden collection');
});

test('collections: products in several collections (category unchanged); counts; filters combine; SEO; show in store; audited', async () => {
  const cat = (await q(`select category_id from products where id = $1`, [P[0]]))[0].category_id;
  await assert.rejects(setProductCollections(db, support, productCollectionsInput.parse({productId: P[0], collectionIds: ['men']}), ctx), ForbiddenError);
  assert.deepEqual(await setProductCollections(db, manager, productCollectionsInput.parse({productId: P[0], collectionIds: ['men', 'sale']}), ctx), {added: 2, removed: 0});
  await setProductCollections(db, manager, productCollectionsInput.parse({productId: P[1], collectionIds: ['women']}), ctx);
  assert.deepEqual((await getProductCollections(db, manager, P[0])).sort(), ['men', 'sale']);
  assert.equal((await q(`select category_id from products where id = $1`, [P[0]]))[0].category_id, cat, 'a collection does not change the category');
  assert.deepEqual(await setProductCollections(db, manager, productCollectionsInput.parse({productId: P[0], collectionIds: ['men']}), ctx), {added: 0, removed: 1});
  await assert.rejects(setProductCollections(db, manager, {productId: P[0], collectionIds: ['nope']}, ctx), DomainError);
  const men = (await listCollections(db, manager)).find(c => c.id === 'men');
  assert.deepEqual([men.products, men.activeProducts, men.draftProducts], [1, 1, 0]);
  // Admin product list: collection + category + status + availability together.
  const list = async o => (await listProducts(db, manager, productListQuery.parse(o))).map(p => p.id);
  assert.deepEqual(await list({collection: 'men'}), [P[0]]);
  assert.deepEqual(await list({collection: 'men', category: cat, status: 'active'}), [P[0]]);
  assert.deepEqual(await list({collection: 'men', status: 'draft'}), []);
  assert.deepEqual(await list({collection: 'women', stock: 'in_stock'}), [P[1]]);
  assert.deepEqual(await list({collection: 'women', stock: 'out'}), []);
  // Edit: group and search-engine text; shown in the store once it has an active product.
  await updateCollection(db, manager, updateCollectionInput.parse({collectionId: 'men', label: 'Men', expectedLabel: 'Men', groupId: 'men', seoTitle: 'Men’s streetwear', seoDescription: ''}), ctx);
  assert.deepEqual((await getCollection(db, manager, 'men')).collection.seoTitle, 'Men’s streetwear');
  assert.throws(() => updateCollectionInput.parse({collectionId: 'men', label: 'Men', expectedLabel: 'Men', seoTitle: 'x'.repeat(71)}), /70/);
  await setCollectionActive(db, manager, {collectionId: 'men', active: true, expectedActive: false}, ctx);
  assert.deepEqual((await anon(`select id, seo_title from collections where id = 'men'`)), [{id: 'men', seo_title: 'Men’s streetwear'}]);
  assert.equal((await anon(`select count(*)::int n from collection_products where collection_id = 'men'`))[0].n, 1, 'the store lists its products');
  // New collection: id made from the name, placed in a group; names unique whatever the case; groups can be added.
  const c = await createCollection(db, manager, createCollectionInput.parse({label: 'Winter Drop', groupId: 'men'}), ctx);
  assert.equal(c.id, 'winter-drop');
  await assert.rejects(createCollection(db, manager, createCollectionInput.parse({label: 'WINTER DROP', id: 'other-id'}), ctx), ConflictError);
  const g = await createCollectionGroup(db, manager, {label: 'Kids'}, ctx);
  assert.equal(g.id, 'kids');
  await assert.rejects(createCollectionGroup(db, manager, {label: 'kids'}, ctx), ConflictError);
  await assert.rejects(createCollectionGroup(db, support, {label: 'Teens'}, ctx), ForbiddenError);
  const acts = (await q(`select action from audit_logs where entity_type in ('collections', 'collection_groups') and entity_id in ('men', 'winter-drop', 'kids') order by id`)).map(r => r.action);
  assert.deepEqual(acts, ['collection.add', 'collection.update', 'collection.status_update', 'collection.create', 'collection_group.create']);
  // Clean up (the test's own additions): the store is as found.
  await setCollectionActive(db, manager, {collectionId: 'men', active: false, expectedActive: true}, ctx);
  for (const p of [P[0], P[1]]) await setProductCollections(db, manager, {productId: p, collectionIds: (await getProductCollections(db, manager, p)).filter(c => c === 'new-arrivals')}, ctx);
  await q(`delete from collections where id = 'winter-drop'`);
  await q(`delete from collection_groups where id = 'kids'`);
});

test('attributes: tags without ids; case-insensitive duplicates refused; rename; deactivate keeps product data; single vs several', async () => {
  // Staff type names only: the link id is made from the name.
  const colour = await createAttribute(db, manager, createAttributeInput.parse({label: 'Colour', selection: 'multi'}), ctx);
  assert.equal(colour.id, 'colour', 'Colour is an ordinary attribute now (one colour list)');
  const fit = await createAttribute(db, manager, createAttributeInput.parse({label: 'Fit', selection: 'single'}), ctx);
  await assert.rejects(createAttribute(db, manager, createAttributeInput.parse({label: 'colour', id: 'colour-2'}), ctx), ConflictError);
  await assert.rejects(createAttribute(db, support, createAttributeInput.parse({label: 'Fabric'}), ctx), ForbiddenError);
  for (const [label, swatch] of [['Black', '#111111'], ['Grey', '#888888'], ['Beige', '#d8c8a8']])
    await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'colour', label, swatch}), ctx);
  for (const label of ['Oversized', 'Regular']) await addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: fit.id, label}), ctx);
  for (const dup of ['black', 'BLACK', 'Black']) await assert.rejects(addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'colour', label: dup}), ctx), /already exists/);
  assert.throws(() => addAttributeValueInput.parse({attributeId: 'colour', label: 'Pink', swatch: 'pink'}), /colour/i);
  await renameAttributeValue(db, manager, {attributeId: 'colour', slug: 'grey', label: 'Charcoal Grey'}, ctx);
  await assert.rejects(renameAttributeValue(db, manager, {attributeId: 'colour', slug: 'grey', label: 'BEIGE'}, ctx), /already exists/);

  // Product tags: several colours, one fit.
  const set = (p, values, who = manager) => setProductAttributes(db, who, setProductAttributesInput.parse({productId: p, values}), ctx);
  await set(P[0], [{attributeId: 'colour', slug: 'black'}, {attributeId: 'colour', slug: 'grey'}, {attributeId: fit.id, slug: 'oversized'}]);
  await assert.rejects(set(P[1], [{attributeId: fit.id, slug: 'oversized'}, {attributeId: fit.id, slug: 'regular'}]), /Fit takes one value/);
  // Deactivate Beige after a product has it: the product keeps it; it cannot be given to another product.
  await set(P[1], [{attributeId: 'colour', slug: 'beige'}]);
  await setAttributeValueActive(db, manager, setAttributeValueActiveInput.parse({attributeId: 'colour', slug: 'beige', active: 'false'}), ctx);
  assert.deepEqual((await getProductAttributes(db, manager, P[1])), ['colour:beige'], 'historical value kept');
  await set(P[1], [{attributeId: 'colour', slug: 'beige'}, {attributeId: 'colour', slug: 'black'}]);    // keeping it is allowed
  await assert.rejects(set(P[2], [{attributeId: 'colour', slug: 'beige'}]), /deactivated/);
  await assert.rejects(addAttributeValue(db, manager, addAttributeValueInput.parse({attributeId: 'colour', label: 'beige'}), ctx), /reactivate it instead/);
  // Switching an attribute to one value is refused while a product has several.
  await assert.rejects(updateAttribute(db, manager, updateAttributeInput.parse({attributeId: 'colour', label: 'Colour', expectedLabel: 'Colour', selection: 'single'}), ctx), /more than one Colour value/);
  const row = (await listAttributes(db, manager)).find(a => a.id === 'colour');
  assert.deepEqual(row.values.map(v => [v.label, v.isActive, v.swatch]), [['Black', true, '#111111'], ['Charcoal Grey', true, '#888888'], ['Beige', false, '#d8c8a8']]);
  // The store: the attribute and its values are readable (the store itself leaves deactivated values out of its filters).
  await setAttributeActive(db, manager, {attributeId: 'colour', active: true, expectedActive: true}, ctx).catch(() => null);
  const seen = await anon(`select slug, is_active from attribute_values where attribute_id = 'colour' order by sort_order`);
  assert.deepEqual(seen, [{slug: 'black', is_active: true}, {slug: 'grey', is_active: true}, {slug: 'beige', is_active: false}]);
  assert.deepEqual((await anon(`select product_id from product_attribute_values where attribute_id = 'colour' and value_slug = 'black' order by product_id`)).map(r => r.product_id), [P[0], P[1]].sort());
  await setAttributeValueActive(db, manager, {attributeId: 'colour', slug: 'beige', active: true}, ctx);
  const acts = (await q(`select action from audit_logs where entity_type = 'attributes' and entity_id = 'colour' order by id`)).map(r => r.action);
  assert.deepEqual(acts, ['attribute.create', 'attribute.value_add', 'attribute.value_add', 'attribute.value_add', 'attribute.value_rename', 'attribute.value_status_update', 'attribute.value_status_update']);
});

test('bulk edit: several collections and attribute values at once; a one-value attribute is replaced, not doubled; audited once', async () => {
  const input = o => bulkEditInput.parse({productIds: [P[2], P[3]], ...o});
  const r = await bulkEditProducts(db, manager, input({action: 'collection_add', collectionIds: ['men', 'sale']}), ctx);
  assert.deepEqual(r.done.sort(), [P[2], P[3]].sort());
  for (const p of [P[2], P[3]]) assert.deepEqual((await getProductCollections(db, manager, p)).filter(c => c !== 'new-arrivals').sort(), ['men', 'sale']);
  await bulkEditProducts(db, manager, input({action: 'attribute_add', attributeValues: ['colour:black', 'colour:grey', 'fit:regular']}), ctx);
  await bulkEditProducts(db, manager, input({action: 'attribute_add', attributeValues: ['fit:oversized']}), ctx);
  for (const p of [P[2], P[3]]) assert.deepEqual((await getProductAttributes(db, manager, p)).sort(), ['colour:black', 'colour:grey', 'fit:oversized']);
  await bulkEditProducts(db, manager, input({action: 'attribute_remove', attributeValues: ['colour:grey']}), ctx);
  assert.deepEqual((await getProductAttributes(db, manager, P[2])).sort(), ['colour:black', 'fit:oversized']);
  assert.throws(() => bulkEditInput.parse({productIds: [P[2]], action: 'collection_add'}), /at least one collection/);
  await assert.rejects(bulkEditProducts(db, support, input({action: 'collection_add', collectionIds: ['men']}), ctx), ForbiddenError);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'product.bulk_edit'`))[0].n, 4);
  // Clean up the test's tags and memberships; no stock moved in this file.
  // New Arrivals membership is the catalogue's own: keep it.
  for (const p of P.slice(0, 4)) { await setProductCollections(db, manager, {productId: p, collectionIds: (await getProductCollections(db, manager, p)).filter(c => c === 'new-arrivals')}, ctx); await setProductAttributes(db, manager, {productId: p, values: []}, ctx); }
  assert.equal(await stockBefore(), units);
});
