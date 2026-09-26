/* Product / price / stock browser tests for the Admin/ERP app, against a LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES (one-time links from the create-staff script
   for: root = super_admin, inventory = inventory_manager, support = support, accountant = accountant).
   Every deliberate change is reversed, so the catalogue baseline (1100 units, original prices) holds at the end. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'products e2e passphrase';
const PID = 'ky-proto-001';
const q = async (text, params) => { const c = new pg.Client({connectionString: KITSYUU_DB_URL}); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };

const b = await launch(9381);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr).catch(() => false)) return true; await w(100); } return false; };
/** Sets an input/select/textarea value the way typing would (works for uncontrolled React fields). */
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel.replace(/'/g, '')}');
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
/** Clicks the form's submit button and waits for THIS submission to start and finish. */
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  await ev(`(()=>{const btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});btn.click();return true})()`);
  await until(`!!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const message = formSel => ev(`document.querySelector(${JSON.stringify(formSel + ' [data-form-message]')})?.innerText ?? ''`);
const fieldError = (formSel, name) => ev(`document.querySelector(${JSON.stringify(`${formSel} [name=${name}]`)})?.closest('.field')?.querySelector('.field-error')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
let confirmQuestions = [];
const autoConfirm = () => ev(`window.__q=[];window.confirm=q=>{window.__q.push(q);return true};true`);
const confirmsSeen = async () => (confirmQuestions = await ev('window.__q ?? []'));

async function signInWithInvite(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}

try {
  await b.viewport(1440, 900);
  const [orig] = await q(`select price_paise, status, colour_label from products where id = $1`, [PID]);
  const variants = await q(`select id, sku, size, stock_qty from product_variants where product_id = $1 order by sort_order`, [PID]);
  const V = variants[0];

  // ================= super admin =================
  ok('super admin signs in', await signInWithInvite('root', 'Products Root'));
  const nav = await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
  ok('menu has Products, Categories and Inventory under Catalogue', nav.includes('Products|Categories|Inventory'), nav);

  // ---------- product list ----------
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  ok('product list shows all 22 products', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === 22);
  ok('list shows ID, SKU, category, price, stock and status', /ky-proto-001/.test(await ev(`document.querySelector('[data-product-row="${PID}"]').innerText`))
    && /₹\d/.test(await ev(`document.querySelector('[data-product-row="${PID}"] [data-price]').innerText`)));
  ok('product thumbnails load from the existing image storage', await until(`[...document.querySelectorAll('td.thumb img')].length===22 && [...document.querySelectorAll('td.thumb img')].every(i=>i.complete && i.naturalWidth>0)`, 20000));
  await visit('/products?q=jeans', '!!document.querySelector("[data-products-table],[data-empty]")');
  const jeans = await q(`select count(*)::int n from products where name ilike '%jeans%' or sku ilike '%jeans%'`);
  ok('search filters the list', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === jeans[0].n && jeans[0].n > 0, String(jeans[0].n));
  await visit('/products?category=bottoms.jeans');
  const [jc] = await q(`select count(*)::int n from products where subcategory_id = 'bottoms.jeans'`);
  ok('subcategory filter', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === jc.n);
  await visit('/products?category=outerwear');
  const [oc] = await q(`select count(*)::int n from products where category_id = 'outerwear'`);
  ok('category filter', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === oc.n);
  await visit('/products?status=inactive');
  ok('inactive filter: empty state when every product is active', await exists('[data-empty=products]'));

  // ---------- product detail ----------
  await visit(`/products/${PID}`, '!!document.querySelector("[data-product-facts]")');
  const fact = f => ev(`document.querySelector('[data-fact=${f}]')?.innerText ?? ''`);
  ok('detail shows product ID and SKU', (await fact('id')) === PID && /^KTS-/.test(await fact('sku')));
  ok('detail shows category / subcategory', /\//.test(await fact('category')), await fact('category'));
  ok('detail shows the current price', (await fact('price')).includes('₹'), await fact('price'));
  ok('detail shows the stock summary (50 units in 5 sizes)', /50 units in 5 sizes/.test(await fact('stock')), await fact('stock'));
  ok('detail shows the product image', await until(`[...document.querySelectorAll('[data-image] img')].some(i=>i.complete&&i.naturalWidth>0)`, 15000));
  ok('stock by size lists every size at 10', (await ev(`[...document.querySelectorAll('[data-variant] [data-qty]')].map(td=>td.innerText).join(',')`)) === '10,10,10,10,10');

  // ---------- product edit: validation, success, audit ----------
  await fill('#details-form [name=colourLabel]', 'Typed before the error');
  await fill('#details-form [name=name]', ' ');
  await submit('#details-form');
  ok('edit validation: empty name rejected with a field error', /Enter a product name/.test(await fieldError('#details-form', 'name')), await fieldError('#details-form', 'name'));
  ok('the other typed fields are kept after the error', (await ev(`document.querySelector('#details-form [name=colourLabel]').value`)) === 'Typed before the error');
  ok('nothing was saved by the rejected edit', (await q(`select colour_label from products where id=$1`, [PID]))[0].colour_label === orig.colour_label);
  await fill('#details-form [name=name]', (await q(`select name from products where id=$1`, [PID]))[0].name);
  await fill('#details-form [name=subcategoryId]', 'bottoms.jeans');
  await submit('#details-form');
  ok('edit: a subcategory of another category is refused', /does not belong/.test(await message('#details-form')), await message('#details-form'));
  await fill('#details-form [name=subcategoryId]', (await q(`select subcategory_id from products where id=$1`, [PID]))[0].subcategory_id ?? '');
  await fill('#details-form [name=colourLabel]', 'E2E Colour');
  await submit('#details-form');
  ok('edit: successful save message', (await message('#details-form')) === 'Saved 1 change.', await message('#details-form'));
  ok('edit: database updated', (await q(`select colour_label from products where id=$1`, [PID]))[0].colour_label === 'E2E Colour');
  const [ea] = await q(`select a.after_data, s.email from audit_logs a join staff_users s on s.id=a.staff_id where a.action='product.update' and a.entity_id=$1 order by a.id desc limit 1`, [PID]);
  ok('edit: audit record names the staff member and the change', ea?.email === 'prod.root@test.local' && ea?.after_data?.colour_label === 'E2E Colour');
  await fill('#details-form [name=colourLabel]', orig.colour_label ?? ''); await submit('#details-form');
  ok('edit: restored', (await q(`select colour_label from products where id=$1`, [PID]))[0].colour_label === orig.colour_label);

  // ---------- price ----------
  const priceNow = async () => (await q(`select price_paise from products where id=$1`, [PID]))[0].price_paise;
  for (const [bad, re] of [['abc', /Enter an amount/], ['0', /more than ₹0/], ['-5', /Enter an amount/], ['12.345', /Enter an amount/]]) {
    await fill('#price-form [name=price]', bad); await submit('#price-form');
    ok(`price "${bad}" rejected with a field error`, re.test(await fieldError('#price-form', 'price')) && (await priceNow()) === orig.price_paise, await fieldError('#price-form', 'price'));
  }
  await autoConfirm();
  await fill('#price-form [name=price]', '2599.50'); await submit('#price-form');
  await confirmsSeen();
  ok('price change asks for confirmation showing previous and new price', /from ₹[\d,]+\.\d\d to ₹2,599\.50/.test(confirmQuestions[0] ?? ''), confirmQuestions[0]);
  ok('price change success message shows previous and new price', /Price changed from ₹[\d,]+\.\d\d to ₹2,599\.50\./.test(await message('#price-form')), await message('#price-form'));
  ok('price stored as integer paise (259950)', (await priceNow()) === 259950);
  ok('page shows the new price', await until(`document.querySelector('[data-current-price]').innerText.includes('2,599.50')`));
  const [pa] = await q(`select before_data, after_data from audit_logs where action='product.price_update' and entity_id=$1 order by id desc limit 1`, [PID]);
  ok('price audit has previous and new price', pa?.before_data?.price_paise === orig.price_paise && pa?.after_data?.price_paise === 259950);
  await autoConfirm();
  await fill('#price-form [name=price]', String(orig.price_paise / 100)); await submit('#price-form');
  ok('price restored', (await priceNow()) === orig.price_paise);

  // ---------- status ----------
  await autoConfirm();
  await fill('#status-form [name=status]', 'archived'); await submit('#status-form');
  await confirmsSeen();
  ok('deactivating asks for confirmation', /hides this product/.test(confirmQuestions[0] ?? ''));
  ok('status: archived', (await q(`select status from products where id=$1`, [PID]))[0].status === 'archived' && /archived/.test(await message('#status-form')));
  await visit('/products?status=inactive');
  ok('inactive filter shows the archived product', (await ev(`[...document.querySelectorAll('[data-product-row]')].map(r=>r.dataset.productRow).join()`)) === PID);
  await visit(`/products/${PID}`, '!!document.querySelector("#status-form")');
  await fill('#status-form [name=status]', 'active'); await submit('#status-form');
  ok('status: reactivated', (await q(`select status from products where id=$1`, [PID]))[0].status === 'active');

  // ---------- stock view ----------
  await visit('/inventory', '!!document.querySelector("[data-stock-table]")');
  ok('stock list shows all 110 sizes', (await ev(`document.querySelectorAll('[data-stock-row]').length`)) === 110);
  // The eyebrow is shown in capitals by CSS (text-transform), so compare case-insensitively.
  ok('stock totals: 1,100 units across 110 sizes', /1,100 units across 110 sizes/i.test(await ev(`document.querySelector('.page-head').innerText`)));
  await visit('/inventory?status=attention');
  ok('low-stock view: empty state (nothing low in the baseline)', await exists('[data-empty=stock]'));

  // ---------- stock adjustment ----------
  const form = `[id="adjust-${V.sku}"]`;
  const qtyNow = async () => (await q(`select stock_qty from product_variants where id=$1`, [V.id]))[0].stock_qty;
  await visit(`/products/${PID}`, `!!document.querySelector('${form}')`);
  await fill(`${form} [name=quantity]`, '5'); await submit(form);
  ok('adjust: missing reason → field error, nothing changed', /Choose a reason/.test(await fieldError(form, 'reason')) && (await qtyNow()) === 10, await fieldError(form, 'reason'));
  await fill(`${form} [name=direction]`, 'increase'); await fill(`${form} [name=quantity]`, '5'); await fill(`${form} [name=reason]`, 'restock'); await fill(`${form} [name=note]`, 'e2e delivery');
  await submit(form);
  ok('adjust: increase by 5 (10 → 15)', (await message(form)).endsWith('10 → 15 (+5).') && (await qtyNow()) === 15, await message(form));
  ok('adjust: form cleared after success (a second click cannot repeat it)', (await ev(`document.querySelector('${form} [name=quantity]').value`)) === '');
  ok('adjust: table shows the new quantity', await until(`document.querySelector('[data-variant="${V.sku}"] [data-qty]').innerText==='15'`));
  const [mv] = await q(`select m.delta, m.balance_after, m.reason, m.note, s.email from inventory_movements m join staff_users s on s.id=m.staff_id where m.variant_id=$1 order by m.id desc limit 1`, [V.id]);
  ok('ledger row: +5, balance after 15, reason, staff member, note', mv?.delta === 5 && mv?.balance_after === 15 && mv?.reason === 'restock' && mv?.email === 'prod.root@test.local' && mv?.note === 'e2e delivery');
  ok('recent movements table shows it', /e2e delivery/.test(await ev(`document.querySelector('[data-movements-table]')?.innerText ?? ''`)));
  await fill(`${form} [name=direction]`, 'decrease'); await fill(`${form} [name=quantity]`, '16'); await fill(`${form} [name=reason]`, 'damage');
  await submit(form);
  ok('adjust: going below zero is refused', /below zero/.test(await message(form)) && (await qtyNow()) === 15, await message(form));
  await fill(`${form} [name=direction]`, 'decrease'); await fill(`${form} [name=quantity]`, '1'); await fill(`${form} [name=reason]`, 'restock');
  await submit(form);
  ok('adjust: reason that does not match the direction is refused', /only be used to increase/.test(await message(form)) && (await qtyNow()) === 15, await message(form));
  // Confirmation rule (CatalogueForms): a decrease that removes at least half the stock AND at least 5 units.
  await autoConfirm();
  await fill(`${form} [name=direction]`, 'decrease'); await fill(`${form} [name=quantity]`, '10'); await fill(`${form} [name=reason]`, 'correction');
  await submit(form);
  await confirmsSeen();
  ok('adjust: a large decrease (10 of 15) asks for confirmation', /Remove 10 of 15 units/.test(confirmQuestions[0] ?? ''), confirmQuestions[0]);
  ok('adjust: decrease by 10 (15 → 5)', (await message(form)).endsWith('15 → 5 (-10).') && (await qtyNow()) === 5, await message(form));
  await autoConfirm();
  await fill(`${form} [name=direction]`, 'increase'); await fill(`${form} [name=quantity]`, '5'); await fill(`${form} [name=reason]`, 'restock');
  await submit(form);
  await confirmsSeen();
  ok('adjust: an increase does not ask for confirmation', confirmQuestions.length === 0);
  ok('adjust: increase by 5 back to the baseline (5 → 10)', (await message(form)).endsWith('5 → 10 (+5).') && (await qtyNow()) === 10, await message(form));
  const [aa] = await q(`select count(*)::int n from audit_logs where action='inventory.adjust' and entity_id=$1`, [V.id]);
  const [lg] = await q(`select count(*)::int n from inventory_movements where variant_id=$1 and staff_id is not null`, [V.id]);
  ok('each successful adjustment has exactly one audit record and one ledger row (failed ones have none)', aa.n === 3 && lg.n === 3, `audit ${aa.n}, ledger ${lg.n}`);
  await b.shot('products-detail.png', true);

  // ---------- keyboard ----------
  await visit(`/products/${PID}`, '!!document.querySelector("#price-form")');
  await ev(`document.querySelector('#price-form [name=price]').focus(),true`);
  ok('keyboard: price field is focusable and labelled', await ev(`document.activeElement.name==='price' && !!document.querySelector('label[for="'+document.activeElement.id+'"]')`));
  await b.key('Tab', 'Tab', 9);
  ok('keyboard: Tab reaches the Change price button', await ev(`document.activeElement.type==='submit' && /Change price/.test(document.activeElement.innerText)`));

  // ================= inventory manager: stock yes, price/details no =================
  ok('inventory manager signs in', await signInWithInvite('inventory', 'Inventory E2E'));
  await visit(`/products/${PID}`, '!!document.querySelector("[data-section=price]")');
  ok('inventory manager: no price, status or details forms (read-only notes instead)', !(await exists('#price-form')) && !(await exists('#status-form')) && !(await exists('#details-form')) && (await exists('[data-readonly=price]')));
  ok('inventory manager: can adjust stock', await exists(`${form}`));

  // ================= support: read-only =================
  ok('support signs in', await signInWithInvite('support', 'Support E2E'));
  await visit(`/products/${PID}`, '!!document.querySelector("[data-section=stock]")');
  ok('support (read-only): sees product and stock, no mutation forms', (await exists('[data-product-facts]')) && (await exists('[data-variants-table]'))
    && !(await exists('#price-form')) && !(await exists('[data-stock-forms]')) && (await exists('[data-readonly=stock]')));

  // ================= accountant: no catalogue access =================
  ok('accountant signs in', await signInWithInvite('accountant', 'Accounts E2E'));
  const accNav = await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
  ok('accountant menu has no Products / Inventory', !/Products|Inventory/.test(accNav), accNav);
  for (const p of ['/products', `/products/${PID}`, '/inventory']) {
    await visit(p);
    ok(`accountant gets "not permitted" on ${p} (server-side, no data rendered)`, (await exists('[data-gate=forbidden]')) && !(await exists('[data-products-table],[data-product-facts],[data-stock-table]')));
  }

  // ================= baseline preserved =================
  const [base] = await q(`select (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select count(*)::int from product_variants where stock_qty<>10) not_ten,
    (select price_paise from products where id=$1) price, (select status from products where id=$1) status`, [PID]);
  ok('baseline preserved after the run: 1100 units, every size at 10, original price and status', base.units === 1100 && base.not_ten === 0 && base.price === orig.price_paise && base.status === 'active', JSON.stringify(base));

  await b.viewport(390, 844, true);
  for (const p of ['/products', `/products/${PID}`, '/inventory']) {
    await visit(p);
    ok(`no horizontal page scroll at 390px: ${p}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
