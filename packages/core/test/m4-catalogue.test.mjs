/* M4 integration tests: product creation, sizes, categories (+ storefront visibility via RLS), New Arrivals, images.
   LOCAL test database only; uploads go to a LOCAL folder (never the live bucket). Services run as kitsyuu_admin. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, DomainError, ForbiddenError, addVariantInput, createCategoryInput, createProductInput, updateVariantInput} from '@kitsyuu/contracts';
import {
  addVariant, adjustStock, createCategory, createProduct, getProduct, listCategoryTree, localStorage, moveCategory, moveImage, moveNewArrival, moveVariant,
  processImage, removeImage, setCategoryActive, setNewArrival, setPrimaryImage, setProductStatus, updateCategory, updateImageAlt, updateProduct, updateVariant, uploadProductImage,
} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const n = async text => (await q(text))[0].n;
const ctx = {ip: '127.0.0.1', userAgent: 'm4.test', requestId: 'test'};
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsyuu-m4-storage-'));
const store = localStorage(DIR);
const png = (w, h) => sharp({create: {width: w, height: h, channels: 3, background: '#b62b43'}}).png().toBuffer();

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm4 test passphrase', fullName: role}, ctx)).token);
}
/** Reads the category rows the storefront (anon, public key) would see, via the real RLS policy. */
async function anonCategoryIds() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    // Supabase grants anon table privileges on public tables by default (seen on the live project); the plain local test
    // database does not, so reproduce that grant inside this rolled-back transaction. RLS then decides the visible rows.
    await c.query('grant select on public.categories to anon');
    await c.query('set local role anon');
    return (await c.query('select id from public.categories order by id')).rows.map(r => r.id);
  }
  finally { await c.query('rollback'); c.release(); }
}
const originalFingerprint = () => q(`select md5(string_agg(row(id, sku, slug, name, price_paise, status, category_id, subcategory_id)::text, '|' order by id)) h from products where id like 'ky-proto-%'`);

let root, manager, invMgr, support, baseline, P;

test('baseline and migration 1300: 22 products, 10 categories all active and visible to the storefront', async () => {
  assert.deepEqual([await n(`select count(*)::int n from products`), await n(`select count(*)::int n from product_variants`), await n(`select count(*)::int n from product_images`)], [22, 110, 22]);
  assert.equal(await n(`select count(*)::int n from categories where is_active`), 10);
  assert.equal((await anonCategoryIds()).length, 10);
  baseline = (await originalFingerprint())[0].h;
  root = await staff('m4.root@test.local', 'super_admin');
  manager = await staff('m4.manager@test.local', 'manager');           // products.write + categories.write
  invMgr = await staff('m4.inventory@test.local', 'inventory_manager');// products.read, categories.read, inventory.adjust; no writes to products/categories
  support = await staff('m4.support@test.local', 'support');           // products.read; no categories.read
});

test('create product: draft, generated id, audited; duplicates and bad input refused; permission enforced', async () => {
  const input = createProductInput.parse({name: 'Test Utility Vest', sku: 'kts-out-900', categoryId: 'outerwear', subcategoryId: 'outerwear.jackets', price: '3,499.00', description: 'Test', colourLabel: 'Black'});
  assert.equal(input.sku, 'KTS-OUT-900', 'SKU normalised to upper case');
  const r = await createProduct(db, manager, input, ctx);
  assert.match(r.productId, /^kts-[0-9a-f]{8}$/); assert.equal(r.slug, 'test-utility-vest');
  P = r.productId;
  const [row] = await q(`select status, price_paise, category_id, subcategory_id from products where id = $1`, [P]);
  assert.deepEqual(row, {status: 'draft', price_paise: 349900, category_id: 'outerwear', subcategory_id: 'outerwear.jackets'});
  const [a] = await q(`select staff_id, action, after_data from audit_logs where entity_id = $1 and action = 'product.create'`, [P]);
  assert.equal(a.staff_id, manager.staffId); assert.equal(a.after_data.sku, 'KTS-OUT-900');
  await assert.rejects(createProduct(db, manager, {...input, sku: 'KTS-TOP-001'}, ctx), ConflictError, 'existing product SKU');
  const vsku = (await q(`select sku from product_variants limit 1`))[0].sku;
  await assert.rejects(createProduct(db, manager, {...input, sku: vsku, slug: 'other-x'}, ctx), ConflictError, 'existing size SKU');
  await assert.rejects(createProduct(db, manager, {...input, sku: 'KTS-OUT-901'}, ctx), ConflictError, 'slug already used');
  await assert.rejects(createProduct(db, manager, {...input, sku: 'KTS-OUT-902', slug: 'x-902', subcategoryId: 'tops.hoodies'}, ctx), DomainError, 'subcategory of another category');
  await assert.rejects(createProduct(db, invMgr, {...input, sku: 'KTS-OUT-903', slug: 'x-903'}, ctx), ForbiddenError);
  for (const bad of [{sku: 'kts out'}, {price: '0'}, {price: '-1'}, {name: ''}, {slug: 'Not A Slug'}])
    assert.equal(createProductInput.safeParse({name: 'N', sku: 'KTS-X-1', categoryId: 'tops', price: '1', ...bad}).success, false, JSON.stringify(bad));
});

test('a product can only be activated with an offered size and a primary image', async () => {
  await assert.rejects(setProductStatus(db, manager, {productId: P, status: 'active'}, ctx), /offered size/);
  const v = await addVariant(db, manager, addVariantInput.parse({productId: P, size: 'm'}), ctx);
  assert.equal(v.sku, 'KTS-OUT-900-M');
  await assert.rejects(setProductStatus(db, manager, {productId: P, status: 'active'}, ctx), /image/);
});

test('sizes: added at 0 units (stock only via the ledger), unique per product, audited', async () => {
  const [v] = await q(`select id, stock_qty, sort_order, stock_source from product_variants where product_id = $1`, [P]);
  assert.deepEqual([v.stock_qty, v.sort_order, v.stock_source], [0, 0, 'manual']);
  assert.equal(await n(`select count(*)::int n from inventory_movements where variant_id = '${v.id}'`), 0);
  await assert.rejects(addVariant(db, manager, {productId: P, size: 'M'}, ctx), ConflictError, 'duplicate size');
  assert.equal(addVariantInput.safeParse({productId: P, size: 'X L'}).success, false);
  await addVariant(db, manager, {productId: P, size: 'L'}, ctx);
  const r = await adjustStock(db, invMgr, {variantId: v.id, direction: 'increase', quantity: 5, reason: 'restock', note: 'first delivery', expectedQty: 0}, ctx);
  assert.equal(r.after, 5);
  await assert.rejects(addVariant(db, invMgr, {productId: P, size: 'XL'}, ctx), ForbiddenError);
  assert.equal(await n(`select count(*)::int n from audit_logs where action = 'product.variant_create'`), 2);
});

test('size settings: price override in paise, reorder level, offered flag; stale and unsafe changes refused', async () => {
  const [v] = await q(`select id, (extract(epoch from updated_at) * 1000000)::bigint::text version from product_variants where product_id = $1 and size = 'M'`, [P]);
  const input = updateVariantInput.parse({variantId: v.id, isActive: 'on', price: '1,999.50', reorderLevel: '2', expectedVersion: v.version});
  assert.deepEqual([input.price, input.reorderLevel], [199950, 2]);
  assert.equal((await updateVariant(db, manager, input, ctx)).changed, 2);
  await assert.rejects(updateVariant(db, manager, input, ctx), ConflictError, 'stale version');
  const [after] = await q(`select price_paise, reorder_level, (extract(epoch from updated_at) * 1000000)::bigint::text version from product_variants where id = $1`, [v.id]);
  assert.deepEqual([after.price_paise, after.reorder_level], [199950, 2]);
  const clear = updateVariantInput.parse({variantId: v.id, isActive: 'on', price: '', reorderLevel: '', expectedVersion: after.version});
  assert.deepEqual([clear.price, clear.reorderLevel], [null, null]);
  await updateVariant(db, manager, clear, ctx);
  for (const bad of [{price: '0'}, {price: 'abc'}, {reorderLevel: '-1'}, {reorderLevel: '1.5'}])
    assert.equal(updateVariantInput.safeParse({variantId: v.id, isActive: 'on', price: '', reorderLevel: '', expectedVersion: '1', ...bad}).success, false, JSON.stringify(bad));
  const [a] = await q(`select before_data, after_data from audit_logs where action = 'product.variant_update' order by id limit 1`);
  assert.deepEqual([a.before_data.price_paise, a.after_data.price_paise], [null, 199950]);
});

test('concurrent size edits with the same version: exactly one wins', async () => {
  const [v] = await q(`select id, (extract(epoch from updated_at) * 1000000)::bigint::text version from product_variants where product_id = $1 and size = 'L'`, [P]);
  const mk = lvl => updateVariantInput.parse({variantId: v.id, isActive: 'on', price: '', reorderLevel: lvl, expectedVersion: v.version});
  const rs = await Promise.allSettled([updateVariant(db, manager, mk('4'), ctx), updateVariant(db, manager, mk('7'), ctx)]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(rs.find(r => r.status === 'rejected').reason instanceof ConflictError);
});

test('size order can be changed', async () => {
  const [m] = await q(`select id from product_variants where product_id = $1 and size = 'M'`, [P]);
  await moveVariant(db, manager, {variantId: m.id, direction: 'down'}, ctx);
  assert.deepEqual((await q(`select size from product_variants where product_id = $1 order by sort_order`, [P])).map(r => r.size), ['L', 'M']);
});

test('image checks: content-sniffed type, 5 MB limit, corrupt files, re-encoding to WebP with size cap and no metadata', async () => {
  for (const [label, bytes] of [
    ['empty', Buffer.alloc(0)],
    ['text renamed .png', Buffer.from('this is not an image')],
    ['html', Buffer.from('<html><script>alert(1)</script></html>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['gif', Buffer.from('GIF89a' + 'x'.repeat(40))],
    ['png header, corrupt body', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage'.repeat(20))])],
    ['over 5 MB', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024 + 10)])],
  ]) await assert.rejects(processImage(bytes), DomainError, label);
  const big = await processImage(await png(3000, 1000));
  assert.deepEqual([big.width, big.height], [2400, 800], 'capped at 2400 px, aspect kept');
  assert.equal((await sharp(big.data).metadata()).format, 'webp');
  const withExif = await sharp({create: {width: 400, height: 300, channels: 3, background: '#222'}}).jpeg().withExif({IFD0: {Copyright: 'secret-gps-owner'}}).toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, 'fixture has EXIF');
  assert.equal((await sharp((await processImage(withExif)).data).metadata()).exif, undefined, 'EXIF stripped');
});

test('images: upload to local storage, first is primary, primary switch, order, alt, removal rules', async () => {
  const a = await uploadProductImage(db, store, manager, {productId: P, alt: 'Front'}, await png(1200, 1600), ctx);
  assert.ok(a.isPrimary); assert.match(a.storagePath, new RegExp(`^products/${P}-[0-9a-f]{16}\\.webp$`));
  assert.ok(fs.existsSync(path.join(DIR, a.storagePath)), 'file written to the LOCAL storage folder');
  const b = await uploadProductImage(db, store, manager, {productId: P, alt: 'Back'}, await png(800, 800), ctx);
  assert.equal(b.isPrimary, false);
  await assert.rejects(uploadProductImage(db, store, invMgr, {productId: P, alt: ''}, await png(10, 10), ctx), ForbiddenError);
  await setPrimaryImage(db, manager, b.imageId, ctx);
  assert.deepEqual((await q(`select storage_path from product_images where product_id = $1 and is_primary`, [P])).map(r => r.storage_path), [b.storagePath], 'exactly one primary');
  await moveImage(db, manager, {imageId: b.imageId, direction: 'up'}, ctx);
  assert.deepEqual((await q(`select id from product_images where product_id = $1 order by sort_order`, [P])).map(r => r.id), [b.imageId, a.imageId]);
  await updateImageAlt(db, manager, {imageId: a.imageId, alt: 'Front view'}, ctx);
  await setProductStatus(db, manager, {productId: P, status: 'active'}, ctx);
  assert.equal((await q(`select status from products where id = $1`, [P]))[0].status, 'active', 'activation succeeds with size + primary image');
  await removeImage(db, store, manager, b.imageId, ctx);
  assert.equal(fs.existsSync(path.join(DIR, b.storagePath)), false, 'file removed');
  assert.deepEqual((await q(`select id from product_images where product_id = $1 and is_primary`, [P])).map(r => r.id), [a.imageId], 'next image promoted to primary');
  await assert.rejects(removeImage(db, store, manager, a.imageId, ctx), ConflictError, 'last image of an active product');
  const [v] = await q(`select id, (extract(epoch from updated_at) * 1000000)::bigint::text version from product_variants where product_id = $1 and size = 'M'`, [P]);
  await updateVariant(db, manager, updateVariantInput.parse({variantId: v.id, isActive: 'off', price: '', reorderLevel: '', expectedVersion: v.version}), ctx);
  const [l] = await q(`select id, (extract(epoch from updated_at) * 1000000)::bigint::text version from product_variants where product_id = $1 and size = 'L'`, [P]);
  await assert.rejects(updateVariant(db, manager, updateVariantInput.parse({variantId: l.id, isActive: 'off', price: '', reorderLevel: '', expectedVersion: l.version}), ctx),
    ConflictError, 'an active product keeps at least one offered size');
});

test('concurrent primary changes leave exactly one primary image', async () => {
  const c = await uploadProductImage(db, store, manager, {productId: P, alt: 'Side'}, await png(600, 800), ctx);
  const [a] = await q(`select id from product_images where product_id = $1 and is_primary`, [P]);
  await Promise.allSettled([setPrimaryImage(db, manager, c.imageId, ctx), setPrimaryImage(db, manager, a.id, ctx)]);
  assert.equal(await n(`select count(*)::int n from product_images where product_id = '${P}' and is_primary`), 1);
});

test('categories: create (2 levels, fixed ids), rename (stale-safe), reorder, activate/deactivate rules, storefront visibility', async () => {
  const top = await createCategory(db, manager, createCategoryInput.parse({slug: 'Accessories', label: 'Accessories'}), ctx);
  assert.deepEqual(top, {id: 'accessories', isActive: true});
  const bags = await createCategory(db, manager, createCategoryInput.parse({parentId: 'accessories', slug: 'bags', label: 'Bags'}), ctx);
  assert.equal(bags.id, 'accessories.bags');
  await assert.rejects(createCategory(db, manager, {parentId: 'accessories.bags', slug: 'x', label: 'X', description: ''}, ctx), DomainError, 'only two levels');
  await assert.rejects(createCategory(db, manager, {slug: 'accessories', label: 'Dup', description: ''}, ctx), ConflictError, 'id exists');
  await assert.rejects(createCategory(db, invMgr, {slug: 'nope', label: 'Nope', description: ''}, ctx), ForbiddenError);
  await updateCategory(db, manager, {categoryId: 'accessories', label: 'Accessories & Bags', description: 'Small goods', expectedLabel: 'Accessories'}, ctx);
  await assert.rejects(updateCategory(db, manager, {categoryId: 'accessories', label: 'Again', description: '', expectedLabel: 'Accessories'}, ctx), ConflictError, 'stale');
  await assert.rejects(setCategoryActive(db, manager, {categoryId: 'tops', active: false, expectedActive: true}, ctx), /active products use/);
  await assert.rejects(setCategoryActive(db, manager, {categoryId: 'accessories', active: false, expectedActive: true}, ctx), /subcategories first/);
  await setCategoryActive(db, manager, {categoryId: 'accessories.bags', active: false, expectedActive: true}, ctx);
  await setCategoryActive(db, manager, {categoryId: 'accessories', active: false, expectedActive: true}, ctx);
  const anon = await anonCategoryIds();
  assert.ok(!anon.includes('accessories') && !anon.includes('accessories.bags') && anon.includes('tops'), 'inactive categories hidden from the storefront (RLS)');
  await assert.rejects(setCategoryActive(db, manager, {categoryId: 'accessories.bags', active: true, expectedActive: false}, ctx), /parent category first/);
  await assert.rejects(setCategoryActive(db, manager, {categoryId: 'accessories', active: true, expectedActive: true}, ctx), ConflictError, 'stale active flag');
  const d = await getProduct(db, manager, P);
  const move = {productId: P, name: d.product.name, description: d.product.description, categoryId: 'accessories', subcategoryId: undefined, colourLabel: d.product.colour_label,
    material: null, care: null, origin: null, features: [], isFeatured: false};
  await assert.rejects(updateProduct(db, manager, move, ctx), /inactive/, 'an active product cannot move into an inactive category');
  await setCategoryActive(db, manager, {categoryId: 'accessories', active: true, expectedActive: false}, ctx);
  const before = (await listCategoryTree(db, manager)).map(c => c.id);
  await moveCategory(db, manager, {categoryId: 'accessories', direction: 'up'}, ctx);
  const after = (await listCategoryTree(db, manager)).map(c => c.id);
  assert.equal(after.indexOf('accessories'), before.indexOf('accessories') - 1);
  await assert.rejects(listCategoryTree(db, support), ForbiddenError, 'support has no categories.read');
});

test('New Arrivals: add at the end, reorder, remove; needs categories.write', async () => {
  const count0 = await n(`select count(*)::int n from collection_products where collection_id = 'new-arrivals'`);
  await setNewArrival(db, manager, {productId: P, member: true}, ctx);
  const d = await getProduct(db, manager, P);
  assert.deepEqual(d.newArrival, {member: true, rank: count0 + 1, count: count0 + 1});
  await moveNewArrival(db, manager, {productId: P, direction: 'up'}, ctx);
  assert.equal((await getProduct(db, manager, P)).newArrival.rank, count0);
  await assert.rejects(setNewArrival(db, invMgr, {productId: P, member: false}, ctx), ForbiddenError);
  await setNewArrival(db, manager, {productId: P, member: false}, ctx);
  assert.equal(await n(`select count(*)::int n from collection_products where collection_id = 'new-arrivals'`), count0);
});

test('audit and consistency: every change audited, original catalogue untouched, stock equals ledger', async () => {
  for (const [action, min] of [['product.create', 1], ['product.variant_create', 2], ['product.variant_update', 3], ['product.variant_reorder', 1], ['product.image_add', 3],
    ['product.image_primary', 2], ['product.image_reorder', 1], ['product.image_update', 1], ['product.image_remove', 1], ['product.status_update', 1],
    ['category.create', 2], ['category.update', 1], ['category.status_update', 3], ['category.reorder', 1], ['collection.add', 1], ['collection.remove', 1], ['collection.reorder', 1]])
    assert.ok(await n(`select count(*)::int n from audit_logs where action = '${action}'`) >= min, `${action} audited`);
  assert.equal(await n(`select count(*)::int n from audit_logs where staff_id = '${invMgr.staffId}' and action <> 'staff.invite_accept' and action <> 'inventory.adjust'`), 0, 'refused attempts left no audit');
  assert.equal((await originalFingerprint())[0].h, baseline, 'the 22 original products are unchanged');
  assert.equal(await n(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(delta),0) from inventory_movements m where m.variant_id = v.id)`), 0);
  assert.deepEqual([await n(`select count(*)::int n from products`), await n(`select count(*)::int n from orders`), await n(`select count(*)::int n from customers`)], [23, 0, 0]);
});

test.after(async () => { await db.destroy(); await owner.destroy(); await pool.end(); fs.rmSync(DIR, {recursive: true, force: true}); });
