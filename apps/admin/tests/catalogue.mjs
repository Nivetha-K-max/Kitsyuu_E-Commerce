/* M4 browser tests: product creation, sizes, images, categories, New Arrivals — LOCAL test database and LOCAL image
   storage only (never Supabase). Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL, INVITES (root = super_admin,
   support, inventory = inventory_manager), STORAGE_DIR (the server's local storage folder) and OUT_DIR. */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, KITSYUU_DB_URL, STORAGE_DIR, OUT_DIR} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'catalogue e2e passphrase';
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

// Test upload files: a real PNG and a text file pretending to be a PNG.
const realPng = path.join(OUT_DIR, 'upload-real.png'), fakePng = path.join(OUT_DIR, 'upload-fake.png'), secondPng = path.join(OUT_DIR, 'upload-second.png');
fs.writeFileSync(realPng, await sharp({create: {width: 1200, height: 1600, channels: 3, background: '#2c2c29'}}).png().toBuffer());
fs.writeFileSync(secondPng, await sharp({create: {width: 900, height: 900, channels: 3, background: '#b62b43'}}).png().toBuffer());
fs.writeFileSync(fakePng, '<html><script>alert(1)</script></html>');

const b = await launch(9401);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr).catch(() => false)) return true; await w(100); } return false; };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  await ev(`(()=>{const btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});btn.click();return true})()`);
  await until(`!!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 30000))) throw new Error(`submission of ${formSel} did not finish`);
};
const message = sel => ev(`document.querySelector(${JSON.stringify(sel + ' [data-form-message]')})?.innerText ?? ''`);
const fieldError = (sel, name) => ev(`document.querySelector(${JSON.stringify(`${sel} [name=${name}]`)})?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const setFile = async (sel, file) => {
  const {root} = await b.send('DOM.getDocument', {depth: -1});
  const {nodeId} = await b.send('DOM.querySelector', {nodeId: root.nodeId, selector: sel});
  if (!nodeId) throw new Error('no file input ' + sel);
  await b.send('DOM.setFileInputFiles', {nodeId, files: [file]});
};
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
const autoConfirm = () => ev(`window.__q=[];window.confirm=q=>{window.__q.push(q);return true};true`);

async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}

try {
  await b.viewport(1440, 900);
  const [base] = await q(`select (select count(*)::int from products) products, (select md5(string_agg(row(id, sku, price_paise, status)::text, '|' order by id)) from products) fp`);

  // ================= super admin =================
  ok('super admin signs in', await signIn('root', 'M4 Root'));
  ok('menu has Categories under Catalogue', /Products\|Categories\|Inventory/.test(await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`)));

  // ---------- create product ----------
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  ok('products list offers "New product"', await exists('[data-new-product]'));
  await visit('/products/new', '!!document.querySelector("#create-product-form")');
  const F = '#create-product-form';
  await fill(`${F} [name=sku]`, 'bad sku'); await fill(`${F} [name=price]`, '0');
  await submit(F);
  ok('create: validation errors for name, SKU and price', /product name/.test(await fieldError(F, 'name')) && /capital letters/.test(await fieldError(F, 'sku')) && /more than ₹0/.test(await fieldError(F, 'price')),
    [await fieldError(F, 'name'), await fieldError(F, 'sku'), await fieldError(F, 'price')].join(' | '));
  await fill(`${F} [name=sku]`, 'KTS-TOP-001'); await fill(`${F} [name=name]`, 'E2E Field Jacket'); await fill(`${F} [name=price]`, '4,299');
  await fill(`${F} [name=categoryId]`, 'outerwear'); await fill(`${F} [name=subcategoryId]`, 'outerwear.jackets');
  await submit(F);
  ok('create: duplicate SKU refused', /already used/.test(await message(F)), await message(F));
  await fill(`${F} [name=sku]`, 'kts-out-950');
  await submit(F);
  ok('create: redirects to the new draft product', await until(`/^\\/products\\/kts-[0-9a-f]{8}$/.test(location.pathname) && !!document.querySelector('[data-notice=created]')`));
  const P = (await ev('location.pathname')).split('/').pop();
  const [created] = await q(`select sku, slug, status, price_paise, category_id, subcategory_id from products where id = $1`, [P]);
  ok('create: saved as draft with SKU, slug, price in paise and category', created?.sku === 'KTS-OUT-950' && created.slug === 'e2e-field-jacket' && created.status === 'draft' && created.price_paise === 429900 && created.subcategory_id === 'outerwear.jackets', JSON.stringify(created));
  ok('create: generated product ID shown', (await ev(`document.querySelector('[data-fact=id]').innerText`)) === P);

  // ---------- activation needs a size and an image ----------
  await fill('#status-form [name=status]', 'active'); await submit('#status-form');
  ok('activation refused without a size', /offered size/.test(await message('#status-form')), await message('#status-form'));

  // ---------- sizes ----------
  await fill('#add-size-form [name=size]', 'm'); await submit('#add-size-form');
  ok('add size: SKU derived, starts at 0', /Size added: KTS-OUT-950-M, 0 in stock/.test(await message('#add-size-form')), await message('#add-size-form'));
  ok('new size appears with 0 in stock', await until(`document.querySelector('[data-variant="KTS-OUT-950-M"] [data-qty]')?.innerText === '0'`));
  await fill('#add-size-form [name=size]', 'M'); await submit('#add-size-form');
  ok('add size: duplicate refused', /already exists/.test(await message('#add-size-form')), await message('#add-size-form'));
  const adj = '[id="adjust-KTS-OUT-950-M"]';
  await fill(`${adj} [name=direction]`, 'increase'); await fill(`${adj} [name=quantity]`, '6'); await fill(`${adj} [name=reason]`, 'restock'); await submit(adj);
  ok('stock arrives through the ledger (0 → 6)', (await message(adj)).endsWith('0 → 6 (+6).'), await message(adj));

  await fill('#status-form [name=status]', 'active'); await submit('#status-form');
  ok('activation refused without an image', /Upload an image/.test(await message('#status-form')), await message('#status-form'));

  // ---------- images ----------
  await setFile('#upload-image-form input[type=file]', fakePng); await submit('#upload-image-form');
  ok('upload: a disguised non-image is refused by content', /Only JPEG, PNG or WebP/.test(await message('#upload-image-form')), await message('#upload-image-form'));
  await setFile('#upload-image-form input[type=file]', realPng); await fill('#upload-image-form [name=alt]', 'Front view'); await submit('#upload-image-form');
  ok('upload: converted to WebP and set as primary', /Image uploaded \(1200×1600, WebP\) and set as the primary image/.test(await message('#upload-image-form')), await message('#upload-image-form'));
  const [img1] = await q(`select storage_path, is_primary, width from product_images where product_id = $1`, [P]);
  ok('upload: stored in the LOCAL storage folder under a random name', /^products\/kts-[0-9a-f]{8}-[0-9a-f]{16}\.webp$/.test(img1?.storage_path ?? '') && fs.existsSync(path.join(STORAGE_DIR, img1.storage_path)));
  ok('uploaded image displays', await until(`[...document.querySelectorAll('[data-image] img')].some(i=>i.complete && i.naturalWidth>0 && i.src.includes('/media/'))`, 15000));
  await fill('#status-form [name=status]', 'active'); await submit('#status-form');
  ok('activation succeeds with a size and a primary image', /active and visible/.test(await message('#status-form')) && (await q(`select status from products where id=$1`, [P]))[0].status === 'active', await message('#status-form'));

  // second image: make primary, reorder, remove the first
  await setFile('#upload-image-form input[type=file]', secondPng); await submit('#upload-image-form');
  ok('second upload is not primary', /Image uploaded \(900×900, WebP\)\.$/.test(await message('#upload-image-form')), await message('#upload-image-form'));
  await until(`document.querySelectorAll('[data-image-tools]').length === 2`);
  const second = (await q(`select id from product_images where product_id = $1 and not is_primary`, [P]))[0].id;
  await submit(`[data-image-tools="${second}"] form[aria-label^="Make image"]`);
  ok('make primary: exactly one primary, the new one', (await q(`select id from product_images where product_id = $1 and is_primary`, [P])).map(r => r.id).join() === second);
  const first = (await q(`select id, storage_path from product_images where product_id = $1 and not is_primary`, [P]))[0];
  await autoConfirm();
  await submit(`[data-image-tools="${first.id}"] form[aria-label^="Remove image"]`);
  ok('remove image: asks for confirmation, row and file removed', (await ev('window.__q?.length')) === 1 && (await q(`select count(*)::int n from product_images where id = $1`, [first.id]))[0].n === 0 && !fs.existsSync(path.join(STORAGE_DIR, first.storage_path)));
  await autoConfirm();
  await submit(`[data-image-tools="${second}"] form[aria-label^="Remove image"]`);
  ok('the last image of an active product cannot be removed', /needs an image/.test(await ev(`document.querySelector('[data-image-tools="${second}"] form[aria-label^="Remove image"] [data-form-message]')?.innerText ?? ''`)));

  // ---------- size settings, stale protection ----------
  const S = '[id="size-KTS-OUT-950-M"]';
  await fill(`${S} [name=price]`, '4,099.50'); await fill(`${S} [name=reorderLevel]`, '3'); await submit(S);
  ok('size settings saved (price override in paise, reorder level)', /KTS-OUT-950-M: saved/.test(await message(S)) && JSON.stringify(await q(`select price_paise, reorder_level from product_variants where sku = 'KTS-OUT-950-M'`)) === '[{"price_paise":409950,"reorder_level":3}]', await message(S));
  await q(`update product_variants set sort_order = sort_order where sku = 'KTS-OUT-950-M'`);           // another session touches the row (LOCAL test DB)
  await fill(`${S} [name=reorderLevel]`, '4'); await submit(S);
  ok('size settings: stale change refused', /changed by someone else/.test(await message(S)), await message(S));
  await visit(`/products/${P}`, `!!document.querySelector('${S}')`);
  await fill(`${S} [name=price]`, 'abc'); await submit(S);
  ok('size settings: invalid price shows a field error', /Enter an amount/.test(await fieldError(S, 'price')));

  // ---------- New Arrivals ----------
  const count0 = (await q(`select count(*)::int n from collection_products where collection_id = 'new-arrivals'`))[0].n;
  await submit('#new-arrival-form');
  ok('New Arrivals: added at the end', await until(`document.querySelector('[data-new-arrival]')?.dataset.newArrival === 'yes'`) && new RegExp(`position ${count0 + 1} of ${count0 + 1}`).test(await ev(`document.querySelector('[data-new-arrival]').innerText`)));
  await submit('#na-up');
  ok('New Arrivals: moved earlier', await until(`/position ${count0} of ${count0 + 1}/.test(document.querySelector('[data-new-arrival]')?.innerText ?? '')`));
  await submit('#new-arrival-form');
  ok('New Arrivals: removed', await until(`document.querySelector('[data-new-arrival]')?.dataset.newArrival === 'no'`) && (await q(`select count(*)::int n from collection_products where collection_id = 'new-arrivals'`))[0].n === count0);

  // ---------- categories ----------
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  ok('categories page lists the 10 existing categories', (await ev(`document.querySelectorAll('[data-category-row]').length`)) === 10);
  const C = '#create-category-form';
  await fill(`${C} [name=slug]`, 'accessories'); await fill(`${C} [name=label]`, 'Accessories'); await submit(C);
  ok('create top-level category', /Category accessories created/.test(await message(C)), await message(C));
  await until(`!!document.querySelector('${C} [name=parentId] option[value=accessories]')`);
  await fill(`${C} [name=parentId]`, 'accessories'); await fill(`${C} [name=slug]`, 'bags'); await fill(`${C} [name=label]`, 'Bags'); await submit(C);
  ok('create subcategory (id accessories.bags)', /Category accessories\.bags created/.test(await message(C)) && await until(`!!document.querySelector('[data-category-row="accessories.bags"]')`), await message(C));
  await fill('#cat-edit-accessories [name=label]', 'Accessories & Bags'); await submit('#cat-edit-accessories');
  ok('rename category', (await q(`select label from categories where id = 'accessories'`))[0].label === 'Accessories & Bags');
  await autoConfirm();
  await submit('#cat-active-tops');
  ok('deactivating a category used by active products is refused', /active products use this category/.test(await message('#cat-active-tops')) && (await q(`select is_active from categories where id = 'tops'`))[0].is_active, await message('#cat-active-tops'));
  await autoConfirm();
  await submit('[id="cat-active-accessories.bags"]');
  ok('deactivate an unused subcategory', await until(`document.querySelector('[data-category-row="accessories.bags"]')?.dataset.active === 'no'`));
  const orderBefore = (await q(`select id from categories where parent_id is null order by sort_order`)).map(r => r.id);
  await submit('#cat-up-accessories');
  const orderAfter = (await q(`select id from categories where parent_id is null order by sort_order`)).map(r => r.id);
  ok('reorder category among its siblings', orderAfter.indexOf('accessories') === orderBefore.indexOf('accessories') - 1, orderAfter.join(','));
  await b.shot('m4-categories.png', true);

  // ================= support: read-only, no categories =================
  ok('support signs in', await signIn('support', 'M4 Support'));
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  ok('support: no "New product" button', !(await exists('[data-new-product]')));
  await visit('/products/new');
  ok('support: /products/new is not permitted (server-side)', (await exists('[data-gate=forbidden]')) && !(await exists('#create-product-form')));
  await visit(`/products/${P}`, '!!document.querySelector("[data-section=images]")');
  ok('support: no image, size or New Arrivals controls', (await exists('[data-readonly=images]')) && !(await exists('#upload-image-form')) && !(await exists('#add-size-form')) && !(await exists('[data-image-tools]')) && !(await exists('[data-section=new-arrivals]')));
  await visit('/categories');
  ok('support: categories not permitted (no categories.read)', (await exists('[data-gate=forbidden]')) && !(await exists('[data-categories-table]')));

  // ================= inventory manager: categories read-only; stock yes, products no =================
  ok('inventory manager signs in', await signIn('inventory', 'M4 Inventory'));
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  ok('inventory manager: categories visible, read-only', (await exists('[data-readonly=categories]')) && !(await exists('#create-category-form')) && !(await exists('[id^=cat-edit-]')));
  await visit(`/products/${P}`, '!!document.querySelector("[data-section=images]")');
  ok('inventory manager: can adjust stock but not sizes, images or New Arrivals', (await exists('[id="adjust-KTS-OUT-950-M"]')) && !(await exists('[data-section=sizes]')) && !(await exists('#upload-image-form'))
    && (await exists('[data-readonly=new-arrivals]')));

  // ================= consistency =================
  const [after] = await q(`select (select md5(string_agg(row(id, sku, price_paise, status)::text, '|' order by id)) from products where id <> $1) fp,
    (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)) mismatch`, [P]);
  ok('existing products untouched; stock equals ledger everywhere', after.fp === base.fp && after.mismatch === 0);
  const actions = (await q(`select distinct action from audit_logs where staff_id = (select id from staff_users where email = 'm4.root@test.local')`)).map(r => r.action);
  const need = ['product.create', 'product.variant_create', 'product.variant_update', 'product.image_add', 'product.image_primary', 'product.image_remove', 'product.status_update', 'inventory.adjust',
    'collection.add', 'collection.reorder', 'collection.remove', 'category.create', 'category.update', 'category.status_update', 'category.reorder'];
  ok('every M4 change is in the audit log', need.every(a => actions.includes(a)), need.filter(a => !actions.includes(a)).join(',') || 'all present');

  await b.viewport(390, 844, true);                         // still signed in as the inventory manager
  for (const p of [`/products/${P}`, '/categories', '/products']) {
    await visit(p);
    ok(`no horizontal page scroll at 390px: ${p.replace(P, ':id')}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
