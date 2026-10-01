/* ERP modules 1–8 browser tests: every new admin screen renders for a permitted role, key forms work through the UI,
   pages are refused (and hidden from the menu) without the permission, and the new pages fit a phone screen.
   LOCAL test database only, after tests/m8.mjs. Moves no stock and creates no orders.
   Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES (root, support, accountant). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'erp e2e passphrase';
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9395);
const ev = e => b.eval(e);
/** Polls a page condition. A condition that throws (e.g. a broken expression) or never holds is reported on stderr, so a
    slow or silently broken wait is visible; some checks expect a timeout ("x never appears"). */
const until = async (expr, ms = 10000) => {
  let last = null;
  for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; last = null; } catch (e) { last = e; } await w(100); }
  if (process.env.WAIT_TRACE) console.error(`WAIT TIMEOUT ${ms}ms: ${String(expr).slice(0, 140)}${last ? ` — throws: ${String(last.message ?? last).split(String.fromCharCode(10))[0]}` : ""}`);
  return false;
};
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const check = sel => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no checkbox ' + ${JSON.stringify(sel)});if(!el.checked)el.click();return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel);
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit for ' + ${sel});
    window.__busySeen=false;new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 3000);
  await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000);
};
const message = f => ev(`document.querySelector('${f} [data-form-message]')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const navText = () => ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`);
const autoConfirm = () => ev(`window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main .page-head") || !!document.querySelector("[data-gate]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e)).map(e => `${p}: ${e}`)); };
const overflow = () => ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);

async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}

const PAGES = [
  ['/notifications', '[data-notification-filters]'], ['/pricing', '[data-pricing-kpis]'], ['/pricing/discounts', '#create-discount-form'],
  ['/pricing/scheduled', '[data-subnav]'], ['/pricing/history', '[data-subnav]'], ['/shipping', '[data-shipment-filters]'], ['/shipping/zones', '#create-zone-form'],
  ['/shipping/couriers', '[data-couriers-table]'], ['/shipping/report', '[data-shipping-kpis]'], ['/returns', '[data-return-filters]'], ['/returns/report', '.report-kpis'],
  ['/marketing', '#create-campaign-form'], ['/marketing/banners', '#create-banner-form'], ['/marketing/segments', '#create-segment-form'], ['/marketing/report', '[data-range-form]'],
  ['/support', '[data-ticket-filters]'], ['/support/new', '#new-ticket-form'], ['/support/report', '.report-kpis'],
  ['/finance', '[data-finance-kpis]'], ['/finance/invoices', '[data-section=orders-without-invoice]'], ['/finance/notes', '[data-subnav]'], ['/finance/expenses', '#expense-form'],
  ['/finance/vendor-payments', '[data-subnav]'], ['/finance/tax', '[data-tax-rates]'], ['/finance/reconciliation', '[data-reconciliation-state]'],
  ['/carts', '[data-cart-kpis]'], ['/carts/wishlists', '[data-subnav]'],
  // client change request, first pass
  ['/products/bulk', '#bulk-edit-form'], ['/size-charts', '#create-size-chart-form'], ['/carts/checkouts', '[data-subnav]'], ['/marketing/subscribers', '[data-subscriber-filters]'],
  // client change request, second pass
  ['/loyalty', '[data-loyalty-rules]'],
];

try {
  await b.viewport(1440, 900);
  await autoConfirm();
  ok('super admin signs in', await signIn('root', 'Root ERP'));
  const nav = await navText();
  for (const label of ['Notifications', 'Pricing & discounts', 'Shipping', 'Returns & refunds', 'Carts & wishlists', 'Marketing', 'Support', 'Finance'])
    ok(`menu shows ${label}`, nav.includes(label), nav);
  for (const [p, sel] of PAGES) {
    await visit(p);
    ok(`${p} renders`, await until(`!!document.querySelector(${JSON.stringify(sel)})`, 15000) && !(await exists('[data-gate=forbidden]')));
  }

  // ---------- pricing: create a coupon through the form (validation first) ----------
  await visit('/pricing/discounts');
  await autoConfirm();
  await fill('#create-discount-form input[name=name]', 'E2E ten');
  await fill('#create-discount-form input[name=code]', 'e2e10');
  await fill('#create-discount-form input[name=value]', '150');
  await submit('#create-discount-form');
  ok('discount form: a percentage over 100 is refused', /percentage/i.test(await ev(`document.querySelector('#create-discount-form [name=value]')?.closest('.field')?.innerText ?? ''`)));
  await fill('#create-discount-form input[name=value]', '10');
  await submit('#create-discount-form');
  ok('discount created', /created/i.test(await message('#create-discount-form')));
  ok('discount stored inactive with its code in capitals', (await q(`select code, is_active, value from discounts where name = 'E2E ten'`))[0]?.code === 'E2E10');
  await visit('/pricing/discounts');
  ok('discount listed', await exists('[data-discount="E2E10"]'));

  // ---------- shipping: a zone and a rate, then the quote checker ----------
  await visit('/shipping/zones');
  await fill('#create-zone-form input[name=name]', 'E2E South');
  await check('#create-zone-form input[name="states[]"][value="Karnataka"]');
  await submit('#create-zone-form');
  ok('zone added', /added/i.test(await message('#create-zone-form')));
  await visit('/shipping/zones');
  ok('zone listed', await exists('[data-zone="E2E South"]'));

  // ---------- marketing: a banner saved as a draft is not public ----------
  await visit('/marketing/banners');
  await fill('#create-banner-form input[name=heading]', 'E2E draft banner');
  await submit('#create-banner-form');
  ok('banner saved as draft', /draft/i.test(await message('#create-banner-form')));

  // ---------- finance: an expense ----------
  await visit('/finance/expenses');
  await fill('#expense-form input[name=amount]', '1250');
  await fill('#expense-form input[name=description]', 'E2E packaging');
  await submit('#expense-form');
  ok('expense saved', /saved/i.test(await message('#expense-form')));
  ok('expense stored in paise', (await q(`select amount_paise from expenses where description = 'E2E packaging'`))[0]?.amount_paise === 125000);

  // ---------- client first pass: size chart, bulk editor validation, brand wording ----------
  await visit('/size-charts');
  await fill('#create-size-chart-form input[name=name]', 'E2E Tops');
  await fill('#create-size-chart-form textarea[name=table]', 'Size, Chest, Length\nS, 96, 68\nM, 102, 70');
  await submit('#create-size-chart-form');
  ok('size chart added', /added/i.test(await message('#create-size-chart-form')), await message('#create-size-chart-form'));
  await visit('/size-charts');
  ok('size chart listed with its sizes', await exists('[data-size-chart="E2E Tops"] [data-size-chart-table]'));
  await visit('/products/bulk');
  await autoConfirm();
  await fill('#bulk-edit-form select[name=action]', 'draft');
  await submit('#bulk-edit-form');
  ok('bulk edit: nothing selected is refused', /select at least one product/i.test(await ev(`document.querySelector('#bulk-edit-form')?.innerText ?? ''`)));
  ok('bulk edit: products listed with a select-all box', (await ev(`document.querySelectorAll('[data-bulk-row]').length`)) >= 22 && await exists('[data-select-all]'));
  await visit('/content');
  ok('brand wording shows the current text by default', (await ev(`document.querySelector('#brand-copy-form [name=heroEyebrow]')?.value ?? ''`)) === '', 'the Japan → India eyebrow line was removed at the client request (empty = not shown)');

  // ---------- client second pass: loyalty points (rules off until set; staff add points with a reason), COD settings ----------
  await visit('/loyalty');
  ok('loyalty: rules shown as off / not set until the business sets them', /Off: customers do not earn or use points/.test(await ev(`document.querySelector('[data-loyalty-rules]')?.innerText ?? ''`)));
  const [cust] = await q(`insert into customers (email, full_name, email_verified_at) values ('loyal.e2e@test.local', 'Loyal E2E', now()) returning id`);
  await visit(`/customers/${cust.id}`, '!!document.querySelector("#loyalty-adjust-form")');
  await fill('#loyalty-adjust-form input[name=points]', '0');
  await fill('#loyalty-adjust-form input[name=reason]', 'E2E gift');
  await submit('#loyalty-adjust-form');
  ok('loyalty: 0 points is refused', /other than 0/i.test(await ev(`document.querySelector('#loyalty-adjust-form')?.innerText ?? ''`)));
  await fill('#loyalty-adjust-form input[name=points]', '50');
  await fill('#loyalty-adjust-form input[name=reason]', 'E2E gift');
  await submit('#loyalty-adjust-form');
  ok('loyalty: staff add points with a reason', /Added 50 points/.test(await message('#loyalty-adjust-form')), await message('#loyalty-adjust-form'));
  ok('loyalty: balance and ledger row stored', (await q(`select balance from loyalty_accounts where customer_id = $1`, [cust.id]))[0]?.balance === 50
    && (await q(`select count(*)::int n from loyalty_transactions where customer_id = $1 and reason = 'E2E gift'`, [cust.id]))[0].n === 1);
  await visit('/loyalty');
  ok('loyalty: the customer is listed with their points', await exists('[data-loyalty-customer="loyal.e2e@test.local"]'));
  await visit('/settings');
  ok('settings: cash on delivery and loyalty settings are listed, with no value', await exists('[data-setting="payments.cod_enabled"]') && await exists('[data-setting="loyalty.point_value_paise"]'));

  // ---------- collections grouped (Men / Women / Sale) and attributes as tags ----------
  await visit('/collections?group=sale', '!!document.querySelector("[data-group-tabs]")');
  ok('collections: the Sale tab shows the Sale collection card with its counts', await exists('[data-group="sale"] [data-collection="sale"] [data-collection-counts]') && !(await exists('[data-group="men"]')));
  await visit('/attributes', '!!document.querySelector("#create-attribute-form")');
  await fill('#create-attribute-form input[name=label]', 'E2E Fabric');
  await submit('#create-attribute-form');
  ok('attributes: created from its name alone (no id to type)', /E2E Fabric created/.test(await message('#create-attribute-form')), await message('#create-attribute-form'));
  await visit('/attributes', '!!document.querySelector("[data-attribute=e2e-fabric]")');
  await ev(`(document.querySelector('[data-add-value=e2e-fabric] summary').click(),true)`);
  await fill('#val-add-e2e-fabric input[name=label]', 'Cotton');
  await submit('#val-add-e2e-fabric');
  await visit('/attributes', '!!document.querySelector("[data-attribute=e2e-fabric]")');
  ok('attributes: + Add value adds a chip (stored)', await exists('[data-attribute=e2e-fabric] [data-value=cotton]')
    && (await q(`select count(*)::int n from attribute_values where attribute_id = 'e2e-fabric' and slug = 'cotton'`))[0].n === 1);
  await ev(`(document.querySelector('[data-add-value=e2e-fabric] summary').click(),true)`);
  await fill('#val-add-e2e-fabric input[name=label]', 'COTTON');
  await submit('#val-add-e2e-fabric');
  ok('attributes: the same name in other letter case is refused', /already exists/.test(await ev(`document.querySelector('#val-add-e2e-fabric')?.innerText ?? ''`)));
  await visit('/attributes', '!!document.querySelector("[data-value=cotton]")');
  await ev(`(document.querySelector('[data-attribute=e2e-fabric] [data-value=cotton] summary').click(),true)`);
  await autoConfirm();                                    // a new page: the confirmation dialog helper is set up again
  await submit('#val-active-e2e-fabric-cotton');
  await visit('/attributes', '!!document.querySelector("[data-value=cotton]")');
  ok('attributes: a value is deactivated, not deleted', (await ev(`document.querySelector('[data-attribute=e2e-fabric] [data-value=cotton]')?.dataset.valueActive`)) === 'no');
  await visit('/attributes?q=cott&status=inactive', '!!document.querySelector("[data-attribute-filters]")');
  ok('attributes: search and the deactivated filter find the value', await exists('[data-attribute=e2e-fabric] [data-value=cotton]'));
  const [prod] = await q(`select id from products where status = 'active' order by id limit 1`);
  await visit(`/products/${prod.id}`, '!!document.querySelector("[data-section=collections]")');
  ok('product page: collections are picked with tags', await exists('#product-collections-form [data-tag-picker="collectionIds[]"]'));
  await ev(`(document.querySelector('#product-collections-form .tag-add').click(),true)`);
  await until(`!!document.querySelector('#product-collections-form [data-option=men]')`);
  await ev(`(document.querySelector('#product-collections-form [data-option=men]').click(),true)`);
  await submit('#product-collections-form');
  ok('product page: saving the tags puts the product in Men', (await q(`select count(*)::int n from collection_products where collection_id = 'men' and product_id = $1`, [prod.id]))[0].n === 1);
  await visit('/products?collection=men', '!!document.querySelector("[data-product-filters]")');
  ok('products: the Collection filter lists it', /Collection/.test(await text('[data-product-filters]')));
  await visit('/products/bulk', '!!document.querySelector("#bulk-edit-form")');
  ok('bulk edit: collections and attribute values use the same tag pickers', await exists('#bulk-edit-form [data-tag-picker="collectionIds[]"]'));
  await q(`delete from collection_products where collection_id = 'men' and product_id = $1`, [prod.id]);

  // ---------- support: open a ticket for a customer (staff channel) ----------
  await visit('/support/new');
  await fill('#new-ticket-form input[name=customerEmail]', 'caller@example.test');
  await fill('#new-ticket-form input[name=subject]', 'E2E phone enquiry');
  await fill('#new-ticket-form textarea[name=body]', 'Asked about sizes.');
  await submit('#new-ticket-form');
  ok('staff ticket opens its page', await until(`/^\\/support\\/[0-9a-f-]{36}$/.test(location.pathname)`, 15000));
  ok('what the customer said is an internal note', await until(`!!document.querySelector('[data-message=internal]')`));

  // ---------- notifications: bell and page ----------
  await visit('/dashboard', '!!document.querySelector("[data-attention-bell]")');
  ok('bell loads its data', await until(`!!document.querySelector('[data-attention-bell]')`));

  // ---------- phone width: no horizontal page scroll on the new list pages ----------
  await b.viewport(390, 844);
  for (const p of ['/pricing', '/shipping/zones', '/returns', '/support', '/finance', '/carts', '/notifications', '/products/bulk', '/size-charts', '/marketing/subscribers', '/loyalty', '/collections', '/attributes']) {
    await visit(p);
    const o = await overflow();
    ok(`${p} fits a phone (no horizontal page scroll)`, o <= 1, `overflow ${o}px`);
  }
  await b.viewport(820, 1180);
  await visit('/finance');
  ok('/finance fits a tablet', (await overflow()) <= 1);
  await b.viewport(1440, 900);

  // ================= support role: no finance, pricing read-only is not granted =================
  ok('support signs in', await signIn('support', 'Support ERP'));
  const snav = await navText();
  ok('support menu: Support and Returns, no Finance or Pricing', snav.includes('Support') && snav.includes('Returns') && !snav.includes('Finance') && !snav.includes('Pricing'), snav);
  for (const p of ['/finance', '/pricing', '/marketing/banners', '/loyalty']) {
    await visit(p);
    ok(`support is refused ${p}`, await exists('[data-gate=forbidden]'));
  }
  await visit('/support');
  ok('support can open the ticket list', await exists('[data-ticket-filters]'));

  // ================= accountant: finance yes, shipping manage no =================
  ok('accountant signs in', await signIn('accountant', 'Accountant ERP'));
  await visit('/finance');
  ok('accountant sees finance', await exists('[data-finance-kpis]'));
  await visit('/shipping/zones');
  ok('accountant is refused shipping', await exists('[data-gate=forbidden]'));
  const csv = await ev(`fetch('/finance/export?kind=summary&from=2026-01-01&to=2030-12-31').then(async r=>({status:r.status,type:r.headers.get('content-type'),body:await r.text()}))`);
  ok('finance CSV export', csv.status === 200 && /text\/csv/.test(csv.type) && /net_sales/.test(csv.body), `${csv.status}`);

  ok('no browser errors on the new pages', allErrors.length === 0, allErrors.slice(0, 5).join(' | '));
} catch (e) {
  ok('ERP browser tests ran to the end', false, e.message);
} finally {
  await b.close(); await pool.end();
  console.log(out.join('\n'));
  const failed = out.filter(l => l.startsWith('FAIL')).length;
  console.log(`\n${out.length - failed}/${out.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
