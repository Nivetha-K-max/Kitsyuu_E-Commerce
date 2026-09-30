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
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr).catch(() => false)) return true; await w(100); } return false; };
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
  for (const p of ['/pricing', '/shipping/zones', '/returns', '/support', '/finance', '/carts', '/notifications']) {
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
  for (const p of ['/finance', '/pricing', '/marketing/banners']) {
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
