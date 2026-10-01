/* New product with its sizes and opening stock (2026-10-01, client request), against the LOCAL test database: one
   transaction (product, sizes, stock through the ledger as "Opening stock"), or nothing; sizes validated and unique;
   opening stock needs inventory.adjust; a slug made from the name gets -2 when taken. */
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {ConflictError, ForbiddenError, createProductInput} from '@kitsyuu/contracts';
import {createProduct} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');
const admin = createDb({connectionString: ADMIN_DATABASE_URL, max: 2});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'new-product-sizes.test', requestId: 'test'};

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(admin, (await acceptStaffInvite(admin, {token, password: 'new product test passphrase', fullName: role}, ctx)).token);
}
const form = extra => createProductInput.parse({name: 'Utility Cargo Jacket', sku: 'KTS-OUT-960', categoryId: 'outerwear', price: '4,999', description: '', colourLabel: 'Olive', ...extra});

let root, support;
before(async () => { root = await staff('np.root@test.local', 'super_admin'); support = await staff('np.support@test.local', 'support'); });
after(async () => { await admin.destroy(); await owner.destroy(); await pool.end(); });

test('sizes in the form: validated, upper-cased, unique; empty rows ignored', () => {
  assert.deepEqual(form({sizes: ['m', 'L', ''], qtys: ['3', '', '7']}).sizes, [{size: 'M', qty: 3}, {size: 'L', qty: 0}]);
  assert.throws(() => form({sizes: ['M', 'm'], qtys: ['1', '1']}), /listed twice/);
  assert.throws(() => form({sizes: ['TOO-LONG-SIZE'], qtys: ['1']}), /1–8 letters or digits/);
  assert.throws(() => form({sizes: ['M'], qtys: ['-2']}), /whole quantity/);
});

test('product + sizes + opening stock in one go, through the ledger; all-or-nothing; permissions', async () => {
  await assert.rejects(createProduct(admin, support, form({sizes: ['M'], qtys: ['3']}), ctx), ForbiddenError);
  // A product SKU already in use: refused, and nothing is created.
  const [{sku: taken}] = await q(`select sku from products order by sku limit 1`);
  await assert.rejects(createProduct(admin, root, {...form({sizes: ['M'], qtys: ['3']}), sku: taken}, ctx), ConflictError);
  assert.equal((await q(`select count(*)::int n from products where name = 'Utility Cargo Jacket'`))[0].n, 0, 'nothing half-created');

  const r = await createProduct(admin, root, form({sizes: ['M', 'L'], qtys: ['3', '']}), ctx);
  assert.equal(r.sizes, 2); assert.equal(r.slug, 'utility-cargo-jacket');
  const sizes = await q(`select size, sku, stock_qty from product_variants where product_id = $1 order by sort_order`, [r.productId]);
  assert.deepEqual(sizes, [{size: 'M', sku: 'KTS-OUT-960-M', stock_qty: 3}, {size: 'L', sku: 'KTS-OUT-960-L', stock_qty: 0}]);
  const [m] = await q(`select reason, delta, note, staff_id from inventory_movements where variant_id = (select id from product_variants where sku = 'KTS-OUT-960-M')`);
  assert.deepEqual([m.reason, m.delta, m.note, m.staff_id], ['restock', 3, 'Opening stock', root.staffId]);
  const [p] = await q(`select status, colour_label, price_paise from products where id = $1`, [r.productId]);
  assert.deepEqual([p.status, p.colour_label, p.price_paise], ['draft', 'Olive', 499900]);
  // Same name again, slug left to the server: -2.
  const r2 = await createProduct(admin, root, form({sku: 'KTS-OUT-962', sizes: [], qtys: []}), ctx);
  assert.equal(r2.slug, 'utility-cargo-jacket-2');
  // Test clean-up for the database check (every product active, no extra products): the second one is removed, the first shown.
  await q(`delete from products where id = $1`, [r2.productId]);
  await q(`update products set status = 'active' where id = $1`, [r.productId]);
});
