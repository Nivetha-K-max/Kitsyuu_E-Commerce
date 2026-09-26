/* Integration tests for product, price and stock administration, against the LOCAL test database only.
   Services run as the real kitsyuu_admin role; setup uses the owner connection. Every deliberate change is reversed
   at the end, so the prototype baseline (22 products, 110 variants, 10 units each = 1100) holds afterwards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDb, recordAudit, sql} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {adjustStockInput, ConflictError, DomainError, ForbiddenError, rupeesToPaise, paiseToRupees, updatePriceInput, updateProductInput} from '@kitsyuu/contracts';
import {adjustStock, getProduct, listAdjustmentReasons, listProducts, listStock, setProductStatus, updateProduct, updateProductPrice} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 3});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const ctx = {ip: '127.0.0.1', userAgent: 'catalogue.test', requestId: 'test'};
const PID = 'ky-proto-001';
const count = async (t, where = sql`true`) => (await sql`select count(*)::int n from ${sql.table(t)} where ${where}`.execute(owner)).rows[0].n;
const totalStock = async () => (await sql`select coalesce(sum(stock_qty),0)::int n from product_variants`.execute(owner)).rows[0].n;
const auditRows = async action => (await sql`select * from audit_logs where action = ${action} order by id`.execute(owner)).rows;

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  const r = await acceptStaffInvite(db, {token, password: 'catalogue test passphrase', fullName: role}, ctx);
  return validateStaffSession(db, r.token);
}

let root, support, invMgr, accountant, original;

test('baseline: 22 products, 110 variants, 22 images, 10 units per size, 1100 total', async () => {
  assert.equal(await count('products'), 22);
  assert.equal(await count('product_variants'), 110);
  assert.equal(await count('product_images'), 22);
  assert.equal(await totalStock(), 1100);
  assert.equal(await count('product_variants', sql`stock_qty <> 10`), 0, 'every size has 10 units');
  assert.equal(await count('orders'), 0);
  root = await staff('cat.root@test.local', 'super_admin');
  support = await staff('cat.support@test.local', 'support');                    // products.read + inventory.read only
  invMgr = await staff('cat.inventory@test.local', 'inventory_manager');         // + inventory.adjust, no products.write
  accountant = await staff('cat.accounts@test.local', 'accountant');             // no products.read
  original = (await owner.selectFrom('products').select(['id', 'price_paise', 'status', 'colour_label', 'name']).where('id', '=', PID).executeTakeFirstOrThrow());
});

test('product read: list, search, category and status filters, detail with images and sizes', async () => {
  assert.equal((await listProducts(db, support, {status: 'all'})).length, 22);
  assert.equal((await listProducts(db, support, {status: 'active'})).length, 22);
  assert.equal((await listProducts(db, support, {status: 'inactive'})).length, 0);
  const tops = await listProducts(db, support, {status: 'all', category: 'tops'});
  assert.equal(tops.length, await count('products', sql`category_id = 'tops'`));
  const jeans = await listProducts(db, support, {status: 'all', category: 'bottoms.jeans'});
  assert.ok(jeans.length > 0 && jeans.every(p => p.subcategoryId === 'bottoms.jeans'));
  const bySku = await listProducts(db, support, {status: 'all', q: original.id});
  assert.deepEqual(bySku.map(p => p.id), [PID]);
  const row = (await listProducts(db, support, {status: 'all'})).find(p => p.id === PID);
  assert.equal(row.pricePaise, original.price_paise); assert.equal(row.stockUnits, 50); assert.equal(row.variants, 5);
  const d = await getProduct(db, support, PID);
  assert.equal(d.product.id, PID); assert.equal(d.images.length, 1); assert.equal(d.variants.length, 5);
  assert.ok(d.variants.every(v => v.stock_qty === 10 && v.stock_status === 'in_stock'));
  assert.equal((await listStock(db, support, {status: 'all'})).rows.length, 110);
  assert.equal((await listStock(db, support, {status: 'all'})).totals.units, 1100);
});

test('permission denial: no products.read → cannot list or open products; no inventory.read → cannot list stock', async () => {
  await assert.rejects(listProducts(db, accountant, {status: 'all'}), ForbiddenError);
  await assert.rejects(getProduct(db, accountant, PID), ForbiddenError);
  await assert.rejects(listStock(db, accountant, {status: 'all'}), ForbiddenError);
});

const detailsInput = over => updateProductInput.parse({productId: PID, name: original.name, description: 'x', categoryId: 'tops', subcategoryId: 'tops.tops',
  colourLabel: original.colour_label ?? '', material: '', care: '', origin: '', features: 'A\nB', isFeatured: 'off', ...over});

test('authorized product update changes only the product and records before/after of changed fields', async () => {
  const before = await getProduct(db, root, PID);
  const input = updateProductInput.parse({productId: PID, name: before.product.name, description: before.product.description,
    categoryId: before.product.category_id, subcategoryId: before.product.subcategory_id ?? '', colourLabel: 'Test colour',
    material: before.product.material ?? '', care: before.product.care ?? '', origin: before.product.origin ?? '',
    features: before.product.features.join('\n'), isFeatured: before.product.is_featured ? 'on' : 'off'});
  assert.deepEqual(await updateProduct(db, root, input, ctx), {changed: 1});
  const a = (await auditRows('product.update')).at(-1);
  assert.equal(a.staff_id, root.staffId); assert.equal(a.entity_id, PID);
  assert.deepEqual(a.before_data, {colour_label: before.product.colour_label}); assert.deepEqual(a.after_data, {colour_label: 'Test colour'});
  assert.deepEqual(await updateProduct(db, root, {...input, colourLabel: before.product.colour_label}, ctx), {changed: 1}, 'restored');
  assert.deepEqual(await updateProduct(db, root, {...input, colourLabel: before.product.colour_label}, ctx), {changed: 0}, 'no-op writes nothing');
});

test('unauthorized product update is refused (and nothing is written)', async () => {
  const auditBefore = await count('audit_logs');
  await assert.rejects(updateProduct(db, support, detailsInput({}), ctx), ForbiddenError);
  await assert.rejects(updateProduct(db, invMgr, detailsInput({}), ctx), ForbiddenError);
  await assert.rejects(setProductStatus(db, invMgr, {productId: PID, status: 'archived'}, ctx), ForbiddenError);
  assert.equal(await count('audit_logs'), auditBefore);
});

test('a subcategory from another category is rejected', async () => {
  await assert.rejects(updateProduct(db, root, detailsInput({categoryId: 'tops', subcategoryId: 'bottoms.jeans'}), ctx), DomainError);
});

test('price input: rupees → integer paise without floating point; invalid, zero and negative prices rejected', async () => {
  assert.equal(rupeesToPaise('2499'), 249900); assert.equal(rupeesToPaise('2,599.50'), 259950); assert.equal(rupeesToPaise('₹ 0.1'), 10);
  assert.equal(rupeesToPaise('19.99'), 1999, '19.99 → 1999 exactly (a float would give 1998.9999…)');
  assert.equal(paiseToRupees(259950), '2,599.50');
  for (const bad of ['', 'abc', '-1', '-0.50', '0', '0.00', '12.345', '1e3', '99999999999', '1,00,00,001', 'NaN'])
    assert.equal(updatePriceInput.safeParse({productId: PID, price: bad, expectedPricePaise: original.price_paise}).success, false, `rejects "${bad}"`);
});

test('price update: authorized, audited with previous and new price, refused when stale or unauthorized', async () => {
  const input = updatePriceInput.parse({productId: PID, price: '2,599.50', expectedPricePaise: original.price_paise});
  assert.deepEqual(await updateProductPrice(db, root, input, ctx), {beforePaise: original.price_paise, afterPaise: 259950, changed: true});
  const a = (await auditRows('product.price_update')).at(-1);
  assert.deepEqual([a.before_data, a.after_data, a.staff_id], [{price_paise: original.price_paise}, {price_paise: 259950}, root.staffId]);
  await assert.rejects(updateProductPrice(db, root, input, ctx), ConflictError, 'stale expected price');
  await assert.rejects(updateProductPrice(db, invMgr, {...input, expectedPricePaise: 259950}, ctx), ForbiddenError);
  await updateProductPrice(db, root, {productId: PID, price: original.price_paise, expectedPricePaise: 259950}, ctx);
  assert.equal((await owner.selectFrom('products').select('price_paise').where('id', '=', PID).executeTakeFirstOrThrow()).price_paise, original.price_paise, 'restored');
  const tax = await sql`select count(*)::int n, max(rate_bp) bp from tax_rates`.execute(owner);
  assert.deepEqual(tax.rows[0], {n: 1, bp: 0}, 'tax configuration untouched');
});

test('status: deactivate hides from active list, audited, reactivated', async () => {
  await setProductStatus(db, root, {productId: PID, status: 'archived'}, ctx);
  assert.deepEqual((await listProducts(db, root, {status: 'inactive'})).map(p => p.id), [PID]);
  const a = (await auditRows('product.status_update')).at(-1);
  assert.deepEqual([a.before_data, a.after_data], [{status: 'active'}, {status: 'archived'}]);
  await setProductStatus(db, root, {productId: PID, status: 'active'}, ctx);
  assert.equal((await listProducts(db, root, {status: 'inactive'})).length, 0);
});

const firstVariant = async () => owner.selectFrom('product_variants').select(['id', 'sku', 'stock_qty']).where('product_id', '=', PID).orderBy('sort_order').executeTakeFirstOrThrow();
const adj = (v, over) => adjustStockInput.parse({variantId: v.id, direction: 'increase', quantity: '5', reason: 'restock', note: '', expectedQty: String(v.stock_qty), ...over});

test('stock increase goes through adjust_stock(): stock, ledger (reason, staff, balance after) and audit together', async () => {
  const v = await firstVariant();
  const movesBefore = await count('inventory_movements');
  const r = await adjustStock(db, invMgr, adj(v, {note: 'delivery 42'}), ctx);
  assert.deepEqual([r.before, r.after, r.delta], [10, 15, 5]);
  const m = (await sql`select * from inventory_movements where id = ${r.movementId}`.execute(owner)).rows[0];
  assert.deepEqual([m.delta, m.reason, m.staff_id, m.balance_after, m.note], [5, 'restock', invMgr.staffId, 15, 'delivery 42']);
  assert.equal(await count('inventory_movements'), movesBefore + 1);
  const a = (await auditRows('inventory.adjust')).at(-1);
  assert.deepEqual([a.staff_id, a.entity_type, a.entity_id, a.before_data, a.after_data], [invMgr.staffId, 'product_variants', v.id, {stock_qty: 10}, {stock_qty: 15}]);
  assert.equal(a.metadata.movement_id, r.movementId); assert.equal(a.metadata.reason, 'restock');
});

test('stock decrease', async () => {
  const v = await firstVariant();
  const r = await adjustStock(db, invMgr, adj(v, {direction: 'decrease', reason: 'correction'}), ctx);
  assert.deepEqual([r.before, r.after, r.delta], [15, 10, -5]);
});

test('negative stock is prevented and leaves no ledger or audit trace', async () => {
  const v = await firstVariant();
  const [moves, audits] = [await count('inventory_movements'), await count('audit_logs')];
  await assert.rejects(adjustStock(db, invMgr, adj(v, {direction: 'decrease', quantity: '11', reason: 'damage'}), ctx), ConflictError);
  assert.equal((await firstVariant()).stock_qty, 10);
  assert.deepEqual([await count('inventory_movements'), await count('audit_logs')], [moves, audits]);
});

test('a reason is required, must be a manual reason, and must match the direction', async () => {
  const v = await firstVariant();
  const missing = adjustStockInput.safeParse({variantId: v.id, direction: 'increase', quantity: '1', reason: '', note: '', expectedQty: '10'});
  assert.equal(missing.success, false); assert.equal(missing.error.issues[0].path[0], 'reason');
  await assert.rejects(adjustStock(db, invMgr, adj(v, {reason: 'seed'}), ctx), DomainError, 'system reasons are not for manual use');
  await assert.rejects(adjustStock(db, invMgr, adj(v, {reason: 'restock', direction: 'decrease', quantity: '1'}), ctx), DomainError, 'restock only increases');
  await assert.rejects(adjustStock(db, invMgr, adj(v, {reason: 'damage', direction: 'increase', quantity: '1'}), ctx), DomainError, 'damage only decreases');
  assert.deepEqual((await listAdjustmentReasons(db, invMgr)).map(r => r.code), ['restock', 'return', 'damage', 'correction', 'admin_adjust']);
  for (const bad of [{quantity: '0'}, {quantity: '-3'}, {quantity: '1.5'}, {quantity: 'x'}, {direction: 'sideways'}])
    assert.equal(adjustStockInput.safeParse({variantId: v.id, direction: 'increase', quantity: '1', reason: 'restock', note: '', expectedQty: '10', ...bad}).success, false);
});

test('stale quantity is refused; stock permission is enforced', async () => {
  const v = await firstVariant();
  await assert.rejects(adjustStock(db, invMgr, adj({...v, stock_qty: 9}), ctx), ConflictError);
  await assert.rejects(adjustStock(db, support, adj(v), ctx), ForbiddenError, 'support has inventory.read but not inventory.adjust');
  await assert.rejects(adjustStock(db, accountant, adj(v), ctx), ForbiddenError);
});

test('the database itself refuses a direct stock update from the admin role', async () => {
  const v = await firstVariant();
  await assert.rejects(sql`update product_variants set stock_qty = 99 where id = ${v.id}`.execute(db), /permission denied/);
});

test('baseline restored: 22 active products at original price, 110 sizes, 1100 units; no orders/customers created', async () => {
  assert.equal(await totalStock(), 1100);
  assert.equal(await count('product_variants', sql`stock_qty <> 10`), 0);
  assert.equal(await count('products', sql`status <> 'active'`), 0);
  assert.equal((await owner.selectFrom('products').select('price_paise').where('id', '=', PID).executeTakeFirstOrThrow()).price_paise, original.price_paise);
  assert.deepEqual([await count('products'), await count('product_variants'), await count('product_images'), await count('orders'), await count('customers')], [22, 110, 22, 0, 0]);
});

test.after(async () => { await db.destroy(); await owner.destroy(); });
