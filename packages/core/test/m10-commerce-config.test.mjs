/* M10 commerce go-live configuration: typed settings (text / choice / money), company details, the settings-driven
   delivery charge through the existing pricing adapter, HSN codes, and what the website role may read.
   LOCAL test database only. Restores every value it changes; the catalogue and stock stay untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb, recordAudit} from '@kitsyuu/db';
import {acceptStaffInvite, issueStaffInvite, validateStaffSession} from '@kitsyuu/auth';
import {DomainError, ForbiddenError, settingUpdateInput, updateProductInput} from '@kitsyuu/contracts';
import {companyDetails, getProduct, listSettings, priceOrder, quoteFromSettings, settingsShipping, updateProduct, updateSetting} from '@kitsyuu/core';

const {ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL} = process.env;
if (!ADMIN_DATABASE_URL || !WEBSITE_DATABASE_URL || !KITSYUU_DB_URL) throw new Error('Run with the test env (apps/admin/tests/.output/test.env)');
for (const u of [ADMIN_DATABASE_URL, WEBSITE_DATABASE_URL, KITSYUU_DB_URL]) assert.ok(/@(localhost|127\.0\.0\.1)[:/]/.test(u), 'tests must only touch a local database');

const db = createDb({connectionString: ADMIN_DATABASE_URL, max: 4});
const web = createDb({connectionString: WEBSITE_DATABASE_URL, max: 2});
const owner = createDb({connectionString: KITSYUU_DB_URL, max: 1});
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const ctx = {ip: '127.0.0.1', userAgent: 'm10.test', requestId: 'test'};
const set = (who, key, value) => updateSetting(db, who, settingUpdateInput.parse({key, value}), ctx);

async function staff(email, role) {
  const token = await owner.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select('id').where('code', '=', role).executeTakeFirstOrThrow();
    const s = await tx.insertInto('staff_users').values({email, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: s.id, role_id: r.id}).execute();
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: s.id});
    return (await issueStaffInvite(tx, s.id, null)).token;
  });
  return validateStaffSession(db, (await acceptStaffInvite(db, {token, password: 'm10 test passphrase', fullName: role}, ctx)).token);
}

let root, manager;

test('nothing is pre-filled: no company, shipping or HSN values exist; shipping quotes "Not set up yet"', async () => {
  assert.deepEqual(await q(`select key from settings where key like 'company.%' or key like 'shipping.%'`), []);
  assert.deepEqual(await q(`select count(*)::int n from products where hsn_code is not null`), [{n: 0}]);
  const quote = await settingsShipping(() => db).quote({lines: [], subtotalPaise: 500_000, shipTo: null});
  assert.deepEqual(quote, {amountPaise: 0, method: 'none', label: 'Not set up yet', configured: false});
  assert.deepEqual(await companyDetails(db), {legalName: null, address: null, gstin: null, supportEmail: null, phone: null});
  root = await staff('m10.root@test.local', 'super_admin');
  manager = await staff('m10.manager@test.local', 'manager');          // settings.read only
});

test('typed settings: text/choice/money validated, optional values clear, audited; needs settings.manage; tax stays locked', async () => {
  await assert.rejects(set(manager, 'company.legal_name', 'X'), ForbiddenError);
  await set(root, 'company.legal_name', '  KITSYUU Test Pvt Ltd  ');
  await set(root, 'company.address', 'Line 1\r\nLine 2');
  await assert.rejects(set(root, 'company.gstin', 'not-a-gstin'), DomainError);
  await set(root, 'company.gstin', '29ABCDE1234F1Z5');
  await assert.rejects(set(root, 'company.support_email', 'nope'), DomainError);
  await set(root, 'company.support_email', 'help@test.local');
  await assert.rejects(set(root, 'shipping.method', 'teleport'), DomainError);
  await assert.rejects(set(root, 'shipping.flat_rate_paise', '12.345'), DomainError);
  await assert.rejects(set(root, 'shipping.flat_rate_paise', ''), DomainError, 'the flat rate is not optional');
  await set(root, 'shipping.flat_rate_paise', '₹ 99.50');
  await set(root, 'shipping.free_from_paise', '2,999');
  await assert.rejects(set(root, 'billing.prices_include_tax', 'true'), ForbiddenError);
  const v = Object.fromEntries((await q(`select key, value from settings where key like 'company.%' or key like 'shipping.%'`)).map(r => [r.key, r.value]));
  assert.deepEqual(v, {'company.legal_name': 'KITSYUU Test Pvt Ltd', 'company.address': 'Line 1\nLine 2', 'company.gstin': '29ABCDE1234F1Z5',
    'company.support_email': 'help@test.local', 'shipping.flat_rate_paise': 9950, 'shipping.free_from_paise': 299900});
  await set(root, 'company.gstin', '');
  assert.deepEqual(await q(`select value from settings where key = 'company.gstin'`), [{value: null}], 'optional text cleared');
  const audit = await q(`select entity_id, after_data from audit_logs where action = 'settings.update' and entity_id = 'shipping.flat_rate_paise'`);
  assert.deepEqual(audit.map(a => a.after_data), [{value: 9950}]);
  const listed = (await listSettings(db, manager)).groups.flatMap(g => g.items).find(i => i.key === 'shipping.method');
  assert.equal(listed.canEdit, false, 'managers see it but cannot change it');
  assert.equal((await companyDetails(db)).legalName, 'KITSYUU Test Pvt Ltd');
});

test('delivery charge: only once a method is chosen; flat rate, free-from threshold; plugs into priceOrder', async () => {
  const provider = settingsShipping(() => db);
  const line = [{productId: 'x', variantId: 'v', qty: 1, unitPaise: 150_000, lineTotalPaise: 150_000}];
  assert.equal((await provider.quote({lines: line, subtotalPaise: 150_000, shipTo: null})).configured, false, 'rate set but method still "none"');
  await set(root, 'shipping.method', 'flat');
  assert.deepEqual(await provider.quote({lines: line, subtotalPaise: 150_000, shipTo: null}), {amountPaise: 9950, method: 'flat', label: 'Delivery', configured: true});
  assert.deepEqual(await provider.quote({lines: line, subtotalPaise: 299_900, shipTo: null}), {amountPaise: 0, method: 'flat', label: 'Free delivery', configured: true});
  const t = await priceOrder(db, line, {config: {shipping: provider, discounts: []}});
  assert.equal(t.shippingPaise, 9950); assert.equal(t.totalPaise, t.subtotalPaise + t.taxPaise * (t.pricesIncludeTax ? 0 : 1) + 9950 - t.discountPaise);
  await set(root, 'shipping.free_from_paise', '');
  assert.equal((await provider.quote({lines: line, subtotalPaise: 10_000_000, shipTo: null})).amountPaise, 9950, 'no threshold: always charged');
  assert.equal(quoteFromSettings({method: 'flat', flatRatePaise: null, freeFromPaise: null}, 1), null, 'flat without a rate = not set up');
  await set(root, 'shipping.method', 'none');
  assert.equal((await provider.quote({lines: line, subtotalPaise: 150_000, shipTo: null})).configured, false);
});

test('website role reads shipping.* and the checkout limit, but not company or other private settings', async () => {
  const seen = (await web.selectFrom('settings').select('key').execute()).map(r => r.key);
  assert.ok(seen.includes('shipping.method') && seen.includes('shipping.flat_rate_paise') && seen.includes('security.checkout_orders_per_hour'), seen.join());
  assert.ok(!seen.some(k => k.startsWith('company.') || k === 'billing.invoice_prefix'), seen.join());
  const quote = await settingsShipping(() => web).quote({lines: [], subtotalPaise: 1, shipTo: null});
  assert.equal(quote.configured, false, 'the website role can run the provider');
});

test('HSN code: 4/6/8 digits, empty clears, omitted leaves it; audited; database refuses bad values', async () => {
  const [{id: PID}] = await q(`select id from products order by id limit 1`);
  const p = (await getProduct(db, root, PID)).product;
  const base = {productId: PID, name: p.name, description: p.description, categoryId: p.category_id, subcategoryId: p.subcategory_id ?? '',
    colourLabel: p.colour_label ?? '', material: p.material ?? '', care: p.care ?? '', origin: p.origin ?? '', features: p.features.join('\n'), isFeatured: p.is_featured ? 'on' : 'off'};
  assert.throws(() => updateProductInput.parse({...base, hsnCode: '12345'}));
  assert.deepEqual(await updateProduct(db, root, updateProductInput.parse({...base, hsnCode: '6109'}), ctx), {changed: 1});
  assert.equal((await getProduct(db, root, PID)).product.hsn_code, '6109');
  assert.deepEqual(await updateProduct(db, root, updateProductInput.parse(base), ctx), {changed: 0}, 'an older form without the field keeps it');
  const a = (await q(`select before_data, after_data from audit_logs where action = 'product.update' and entity_id = $1 order by id`, [PID])).at(-1);
  assert.deepEqual([a.before_data, a.after_data], [{hsn_code: null}, {hsn_code: '6109'}]);
  await assert.rejects(q(`update products set hsn_code = 'abc' where id = $1`, [PID]), /products_hsn_code_format/);
  assert.deepEqual(await updateProduct(db, root, updateProductInput.parse({...base, hsnCode: ''}), ctx), {changed: 1});
  assert.equal((await getProduct(db, root, PID)).product.hsn_code, null);
});

test.after(async () => {
  await q(`delete from settings where key like 'company.%' or key like 'shipping.%'`);
  await db.destroy(); await web.destroy(); await owner.destroy(); await pool.end();
});
