/* POS billing browser tests (2026-10-02), LOCAL test database only, after tests/workflows.mjs:
   - a cashier (sales) opens a session at Chennai Store 1, searches by SKU, picks a size, scans a barcode, cannot go above
     the branch stock, takes cash (change shown), prints the bill; UPI needs its reference; a customer is picked by phone;
   - the cashier sees no discount and no void; a manager at Chennai Store 2 gives a 10% discount with a reason and voids
     a Store 1 sale (stock back to Store 1); support has no POS;
   - the cashier closes the session (expected cash, counted cash, variance); the manager sees the POS report and the order
     page shows the POS bill. Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES (root, manager, sales, support). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'pos e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9397);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; } catch {} await w(100); } return false; };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const hydrated = sel => until(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return !!e && Object.keys(e).some(k=>k.startsWith('__reactProps'))})()`, 20000);
const click = async sel => { await hydrated(sel); return ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('no ' + ${JSON.stringify(sel)});e.click();return true})()`); };
const submit = async formSel => {
  const sel = JSON.stringify(formSel);
  await hydrated(formSel);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit for ' + ${sel});
    window.__busySeen=false;new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || !document.querySelector(${sel})`, 3000);
  await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000);
};
const message = f => ev(`document.querySelector('${f} [data-form-message]')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const autoConfirm = () => ev(`window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main .page-head") || !!document.querySelector("[data-gate]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]|\/favicon\.ico/.test(e)).map(e => `${p}: ${e}`)); };
const locQty = async (code, sku) => (await q(`select coalesce((select s.qty from location_stock s join locations l on l.id = s.location_id join product_variants v on v.id = s.variant_id where l.code = $1 and v.sku = $2), 0)::int n`, [code, sku]))[0].n;

const accepted = new Set();
async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  if (accepted.has(key)) {
    await visit('/login', '!!document.querySelector("main input[name=password]")');
    await fill('main input[name=email]', `pos.${key}@test.local`); await fill('main input[name=password]', PW);
    await submit('main form');
    return until(`location.pathname==='/dashboard'`);
  }
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  const done = await until(`location.pathname==='/dashboard'`);
  if (done) accepted.add(key);
  return done;
}
/** Adds a size from the search results (types into the search box first). */
async function addBySearch(term, sku) {
  await hydrated('[data-pos-search]');
  await fill('[data-pos-search]', term);
  await until(`!!document.querySelector('[data-pos-variant="${sku}"]')`, 10000);
  await click(`[data-pos-variant="${sku}"]`);
  return until(`!!document.querySelector('[data-pos-line="${sku}"]')`, 5000);
}
const chargeReady = () => until(`(()=>{const b=document.querySelector('[data-pos-charge]');return !!b && !b.disabled})()`, 10000);

try {
  await b.viewport(1440, 900);
  // Fixtures (local test DB): two branches with their own stock (through the stock ledger), a 10% staff-discount maximum, a
  // barcode on one size, and a customer who will buy at the counter.
  await q(`insert into settings (key, value) values ('discounts.staff_max_percent', '10') on conflict (key) do update set value = excluded.value`);
  for (const [code, name] of [['POS-S1', 'POS Store 1'], ['POS-S2', 'POS Store 2']])
    await q(`insert into locations (code, name, kind, address, is_online, is_active) values ($1, $2, 'retail', 'Chennai', false, true) on conflict (code) do nothing`, [code, name]);
  for (const [code, sku, n] of [['POS-S1', 'KTS-TOP-003-M', 2], ['POS-S1', 'KTS-TOP-003-L', 5], ['POS-S1', 'KTS-BTM-003-M', 4], ['POS-S2', 'KTS-TOP-003-M', 3]])
    await q(`select public.adjust_location_stock((select id from product_variants where sku = $2), (select id from locations where code = $1), $3, 'restock', null, 'POS e2e stock')`, [code, sku, n]);
  await q(`update product_variants set barcode = '8901000000017' where sku = 'KTS-BTM-003-M'`);
  await q(`insert into customers (email, full_name, phone, email_verified_at) values ('pos.kavya@test.local', 'Kavya POS', '9840099887', now()) on conflict (email) do nothing`);

  // ---------- support: no POS ----------
  ok('support signs in', await signIn('support', 'POS Support'));
  await visit('/pos');
  ok('support: POS is forbidden (pos.access)', /pos\.access/.test(await text('main')) && !(await exists('[data-pos]')));
  ok('support: no POS link in the menu', !(await exists('nav a[href="/pos"]')));

  // ---------- cashier (sales): open a session at Store 1 ----------
  ok('cashier signs in', await signIn('sales', 'POS Cashier'));
  ok('cashier: POS link in the menu', await exists('nav a[href="/pos"]'));
  await visit('/pos', '!!document.querySelector("#pos-open-form") || !!document.querySelector("[data-pos]")');
  ok('no session yet: the open-session form lists the branches', await exists('#pos-open-form') && /POS Store 1/.test(await text('#pos-open-form select')));
  const s1 = (await q(`select id from locations where code = 'POS-S1'`))[0].id;
  // Open-session screen: choosing a store in the list shows what is available there, before the session is opened.
  {
    const stockOf = id => q(`select v.sku, s.qty::int qty from location_stock s join product_variants v on v.id = s.variant_id where s.location_id = $1 and s.qty > 0 and v.is_active`, [id]);
    const shows = async id => {
      const want = await stockOf(id);
      const ready = await until(`document.querySelector('[data-pos-preview]')?.dataset.posPreview === ${JSON.stringify(id)} && !document.querySelector('[data-pos-preview][aria-busy]')`, 15000);
      const got = await ev(`[...document.querySelectorAll('[data-pos-preview-variant]')].map(e => [e.dataset.posPreviewVariant, e.innerText.replace(/\\s+/g, ' ')])`);
      return {ok: ready && got.length === want.length && want.every(w => got.some(([sku, label]) => sku === w.sku && label.includes(w.qty + ' in stock'))), want: want.length, got: got.length};
    };
    const stores = await q(`select id, name from locations where is_online = false and is_active order by sort_order, name`);
    const options = await ev(`[...document.querySelectorAll('#pos-open-form select[name=locationId] option')].map(o => o.value)`);
    ok('open session: the list offers every active retail store, and no other location', options.length === stores.length && stores.every(x => options.includes(x.id)), JSON.stringify({options: options.length, stores: stores.length}));
    const first = await ev(`document.querySelector('#pos-open-form select[name=locationId]').value`);
    const r1 = await shows(first);
    ok('open session: the products available at the selected store are listed with their quantities', r1.ok, JSON.stringify(r1));
    const other = stores.find(x => x.id !== first);
    await fill('#pos-open-form select[name=locationId]', other.id);
    const r2 = await shows(other.id);
    ok('open session: selecting another store lists that store\'s stock instead', r2.ok && (await text('#pos-preview-h')).includes(other.name), JSON.stringify(r2));
    ok('open session: looking at stock opens no session', (await q(`select count(*)::int n from pos_sessions`))[0].n === 0);
  }
  await fill('#pos-open-form select[name=locationId]', s1); await fill('#pos-open-form input[name=openingCash]', '1000');
  await submit('#pos-open-form');
  ok('session opened → the counter screen', await until('!!document.querySelector("[data-pos]")', 15000), await message('#pos-open-form'));
  ok('header shows branch and session', /POS Store 1 · session POSS\//.test(await text('.page-head')));
  ok('cashier: no discount field (no orders.discount)', !(await exists('[data-pos-discount]')));

  // ---------- store selector and the branch's stock (client request, 2026-10-09) ----------
  ok('the counter shows the store it bills at, chosen in a selector that lists the branches', (await ev(`document.querySelector('[data-pos-store-select]').value`)) === s1
    && (await ev(`document.querySelectorAll('[data-pos-store-select] option').length`)) >= 2);
  ok('the stock at this store is listed without searching', await until(`/^In stock at POS Store 1/.test(document.querySelector('[data-pos-stock-head]')?.innerText || '') && document.querySelectorAll('[data-pos-listing=stock] [data-pos-variant]').length > 0`, 15000),
    await text('[data-pos-stock-head]'));
  {
    const shown = await ev(`[...document.querySelectorAll('[data-pos-listing=stock] [data-pos-variant]')].map(b => [b.dataset.posVariant, b.innerText.replace(/\\s+/g, ' '), b.disabled])`);
    const inDb = await q(`select v.sku, s.qty::int qty from location_stock s join locations l on l.id = s.location_id join product_variants v on v.id = s.variant_id where l.code = 'POS-S1' and s.qty > 0 and v.is_active`);
    ok('it lists exactly the sizes with stock at this store, each with its quantity, all selectable', shown.length === inDb.length
      && inDb.every(r => shown.some(([sku, label, disabled]) => sku === r.sku && label.includes(r.qty + ' in stock') && !disabled)), JSON.stringify({shown: shown.length, inDb: inDb.length}));
    const other = (await q(`select id, name from locations where is_online = false and is_active and id <> $1 order by sort_order, name limit 1`, [s1]))[0];
    await ev(`(()=>{const el=document.querySelector('[data-pos-store-select]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(other.id)});el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    ok('choosing another store explains that this session bills at its own store, with the way to close it', await until(`!!document.querySelector('[data-pos-store-switch] a[href="/pos/sessions#close"]')`, 5000)
      && (await text('[data-pos-store-switch]')).includes(other.name) && /POS Store 1/.test(await text('[data-pos-store-switch]')));
    ok('nothing changed: the same session is open at the same store, and the list is still this store\'s', (await q(`select count(*)::int n from pos_sessions s where s.status = 'open' and s.location_id = $1`, [s1]))[0].n === 1
      && /^In stock at POS Store 1/.test(await text('[data-pos-stock-head]')));
    await click('[data-pos-store-stay]');
    ok('"Stay" puts the selector back on this store', await until(`!document.querySelector('[data-pos-store-switch]') && document.querySelector('[data-pos-store-select]').value === ${JSON.stringify(s1)}`, 5000));
  }

  // ---------- search, size, quantity limits, scan ----------
  ok('search by SKU shows the sizes with Store 1 stock', await addBySearch('KTS-TOP-003', 'KTS-TOP-003-M'));
  ok('size button shows branch stock', /2 in stock/.test(await text('[data-pos-variant="KTS-TOP-003-M"]')));
  await click('[data-pos-line="KTS-TOP-003-M"] [data-pos-plus]');
  ok('+ raises the quantity to 2', await until(`document.querySelector('[data-pos-line="KTS-TOP-003-M"] [data-pos-qty]')?.innerText === '2'`));
  ok('cannot go above the branch stock (+ disabled at 2)', await ev(`document.querySelector('[data-pos-line="KTS-TOP-003-M"] [data-pos-plus]').disabled`));
  await hydrated('[data-pos-search]');
  await fill('[data-pos-search]', '8901000000017');
  await ev(`document.querySelector('[data-pos-search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  ok('scanning a barcode + Enter adds that size', await until(`!!document.querySelector('[data-pos-line="KTS-BTM-003-M"]')`, 8000));
  await click('[data-pos-line="KTS-BTM-003-M"] [data-pos-remove]');
  ok('× removes the line', await until(`!document.querySelector('[data-pos-line="KTS-BTM-003-M"]')`));
  ok('server total shown', await until('Number(document.querySelector("[data-pos-total]")?.dataset.posTotal) > 0'));
  const total = Number(await ev('document.querySelector("[data-pos-total]").dataset.posTotal'));
  const [{p}] = await q(`select coalesce(v.price_paise, pr.price_paise) p from product_variants v join products pr on pr.id = v.product_id where v.sku = 'KTS-TOP-003-M'`);
  ok('total = 2 × price (tax inclusive, no delivery)', total === 2 * p, `${total} vs ${2 * p}`);

  // ---------- cash payment ----------
  // 2026-10-12, anonymous counter sale (regression check for Customer Management Phase A): this sale is made with NO customer.
  const [before] = await q(`select (select count(*)::int from customers) customers, (select count(*)::int from loyalty_transactions) points`);
  ok('anonymous sale: no customer is chosen at the counter and none is asked for', (await exists('[data-pos-customer-search]')) && !(await exists('[data-pos-customer-clear]')), await text('[data-pos-customer]'));
  ok('charge disabled until cash ≥ total', await ev('document.querySelector("[data-pos-charge]").disabled'));
  await fill('[data-pos-tendered]', String(total / 100 + 100));
  ok('change preview', /₹100\.00/.test(await text('[data-pos-change-preview]')));
  await chargeReady(); await click('[data-pos-charge]');
  ok('payment recorded: POS number and change to give', await until('!!document.querySelector("[data-pos-done]")', 15000) && /POS\/\d{2}-\d{2}\/\d{5}/.test(await text('[data-pos-done]')) && /₹100\.00/.test(await text('[data-pos-change]')),
    await text('[data-pos-error]'));
  const [sale1] = await q(`select o.id, o.pos_number, o.channel, o.status, o.payment_status, o.payment_method, o.total_paise, l.code from orders o join locations l on l.id = o.location_id where pos_number is not null order by o.created_at desc limit 1`);
  ok('order: retail at Store 1, delivered, paid in cash', sale1?.channel === 'retail' && sale1.code === 'POS-S1' && sale1.status === 'delivered' && sale1.payment_status === 'paid' && sale1.payment_method === 'cash' && sale1.total_paise === total);
  ok('stock taken from Store 1 only (Store 2 unchanged)', await locQty('POS-S1', 'KTS-TOP-003-M') === 0 && await locQty('POS-S2', 'KTS-TOP-003-M') === 3);
  const [anon] = await q(`select o.order_number, o.customer_id, o.user_id, coalesce(o.contact->>'email', '') as email, (select count(*)::int from payments p where p.order_id = o.id and p.status = 'captured') as paid,
    (select count(*)::int from customers) as customers, (select count(*)::int from loyalty_transactions) as points from orders o where o.id = $1`, [sale1.id]);
  ok('anonymous sale: completed and paid with no customer; the order names nobody; no customer account and no points were created',
    anon.customer_id === null && anon.user_id === null && anon.email === '' && anon.paid === 1 && anon.customers === before.customers && anon.points === before.points, JSON.stringify(anon));
  ok('print link opens the bill', (await ev('document.querySelector("[data-pos-print]").getAttribute("href")')) === `/pos/sale/${sale1.id}?print=1`);
  await visit(`/pos/sale/${sale1.id}`, '!!document.querySelector("[data-pos-receipt]")');
  const receipt = await text('[data-pos-receipt]');
  ok('bill: KITSYUU, branch, bill no., cashier, SKU, size, qty, total, payment', /KITSYUU/.test(receipt) && /POS Store 1/.test(receipt) && receipt.includes(sale1.pos_number) && /pos\.sales@test\.local|POS Cashier/.test(receipt)
    && /KTS-TOP-003-M/.test(receipt) && /Size M/.test(receipt) && /Cash/.test(await text('[data-receipt-method]')), receipt.slice(0, 300));
  ok('bill: print button; no void for a cashier', await exists('[data-print]') && !(await exists('#pos-void-form')));

  // ---------- UPI with reference, customer picked by phone ----------
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  await addBySearch('KTS-TOP-003', 'KTS-TOP-003-L');
  await hydrated('[data-pos-customer-search]');
  await fill('[data-pos-customer-search]', '98400998');
  ok('customer found by phone', await until(`!!document.querySelector('[data-pos-customer-pick="pos.kavya@test.local"]')`, 8000));
  await click('[data-pos-customer-pick="pos.kavya@test.local"]');
  ok('customer selected', /Kavya POS/.test(await text('[data-pos-customer]')));
  await click('[data-pos-method="upi"]');
  await until('Number(document.querySelector("[data-pos-total]")?.dataset.posTotal) > 0');
  ok('UPI: charge disabled without the reference', await ev('document.querySelector("[data-pos-charge]").disabled'));
  await fill('[data-pos-reference]', 'UTR 5566 7788 99');
  await chargeReady(); await click('[data-pos-charge]');
  ok('UPI sale recorded', await until('!!document.querySelector("[data-pos-done]")', 15000), await text('[data-pos-error]'));
  const [sale2] = await q(`select o.id, o.customer_id, p.method, p.raw->>'reference' ref from orders o join payments p on p.order_id = o.id where o.pos_number is not null order by o.created_at desc limit 1`);
  const [kavya] = await q(`select id from customers where email = 'pos.kavya@test.local'`);
  ok('UPI sale: customer and reference stored', sale2.customer_id === kavya.id && sale2.method === 'upi' && sale2.ref === 'UTR 5566 7788 99');
  // 2026-10-12: the anonymous sale belongs to no customer anywhere in Customer Management; the sale with a customer is hers alone.
  const [named] = await q(`select order_number from orders where id = $1`, [sale2.id]);
  await visit(`/customers/${kavya.id}?tab=orders`, '!!document.querySelector("[data-customer-orders]")');
  const hers = await ev(`[...document.querySelectorAll('[data-customer-orders] tbody tr')].map(r=>r.dataset.orderRow).join()`);
  ok('customer page: the customer who bought at the counter has that sale only, not the anonymous one', hers === named.order_number && (await text('[data-kpi="Orders"]')) === '1'
    && !(await ev('document.documentElement.outerHTML')).includes(anon.order_number), hers);
  await visit('/customers', '!!document.querySelector("[data-customers-table]")');
  ok('customers list: the anonymous sale added no customer and is counted for nobody', (await ev(`document.querySelectorAll('[data-customer-row]').length`)) === before.customers
    && (await ev(`[...document.querySelectorAll('[data-customer-row] [data-orders-count]')].reduce((n,e)=>n+Number(e.innerText),0)`)) === (await q(`select count(*)::int n from orders where customer_id is not null`))[0].n);
  ok('anonymous sale: still in the POS sales and Orders, with no customer', (await q(`select count(*)::int n from orders where id = $1 and pos_number is not null and customer_id is null`, [sale1.id]))[0].n === 1);
  await visit(`/orders/${sale1.id}`, '!!document.querySelector("[data-entity=order]")');
  ok('anonymous sale: its order page opens and links no customer account', (await exists('[data-entity=order]')) && !(await exists('[data-customer-link]')));
  await visit('/pos', '!!document.querySelector("[data-pos]")');

  // ---------- manager: own session at Store 2, discount; void the cashier's sale ----------
  ok('manager signs in', await signIn('manager', 'POS Manager'));
  await visit('/pos', '!!document.querySelector("#pos-open-form") || !!document.querySelector("[data-pos]")');
  const s2 = (await q(`select id from locations where code = 'POS-S2'`))[0].id;
  await fill('#pos-open-form select[name=locationId]', s2); await fill('#pos-open-form input[name=openingCash]', '0');
  await submit('#pos-open-form');
  ok('manager session at Store 2', await until('!!document.querySelector("[data-pos]")', 15000) && /POS Store 2/.test(await text('.page-head')));
  // Client change request (2026-10-03): the only discount UI is the staff discount, and only when it can be used.
  ok('manager: staff discount row shown (a maximum is set); no coupon or promotion field', await exists('[data-pos-discount]')
    && !(await ev(`[...document.querySelectorAll('[data-pos] input, [data-pos] label')].some(el => /coupon|promo/i.test((el.name || '') + (el.placeholder || '') + el.textContent))`)));
  await q(`delete from settings where key = 'discounts.staff_max_percent'`);
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  ok('manager: no discount row while no staff-discount maximum is set', !(await exists('[data-pos-discount]')));
  await q(`insert into settings (key, value) values ('discounts.staff_max_percent', '10') on conflict (key) do update set value = excluded.value`);
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  await addBySearch('KTS-TOP-003', 'KTS-TOP-003-M');
  ok('Store 2 stock shown (3)', /3 in stock/.test(await text('[data-pos-line="KTS-TOP-003-M"]')));
  await fill('[data-pos-discount-pct]', '15');
  ok('discount above the maximum refused with the reason', await until(`/above the maximum/.test(document.querySelector('[data-pos-quote-error]')?.innerText ?? '')`, 8000));
  await fill('[data-pos-discount-pct]', '10');
  ok('10% discount shown in the totals', await until('!!document.querySelector("[data-pos-discount-amount]")', 8000));
  ok('charge waits for the discount reason', await ev('document.querySelector("[data-pos-charge]").disabled'));
  await fill('[data-pos-discount-reason]', 'Festival offer');
  await click('[data-pos-method="card"]'); await fill('[data-pos-reference]', 'APPR-77421');
  await chargeReady(); await click('[data-pos-charge]');
  ok('discounted card sale recorded', await until('!!document.querySelector("[data-pos-done]")', 15000), await text('[data-pos-error]'));
  const [sale3] = await q(`select staff_discount_bp, staff_discount_reason, l.code from orders o join locations l on l.id = o.location_id where o.pos_number is not null order by o.created_at desc limit 1`);
  ok('staff discount stored (10%, reason) at Store 2', sale3.staff_discount_bp === 1000 && sale3.staff_discount_reason === 'Festival offer' && sale3.code === 'POS-S2');
  await visit(`/pos/sale/${sale1.id}`, '!!document.querySelector("[data-pos-receipt]")');
  ok('manager: void form on the open-session sale', await exists('#pos-void-form'));
  await autoConfirm();
  await fill('#pos-void-form input[name=reason]', 'Customer changed their mind');
  await submit('#pos-void-form');
  ok('voided: the bill says so and the stock is back at Store 1', await until('!!document.querySelector("[data-pos-voided]")', 15000) && !(await exists('#pos-void-form')) && await locQty('POS-S1', 'KTS-TOP-003-M') === 2, await message('#pos-void-form'));
  ok('voided order cancelled, payment refunded', (await q(`select status, payment_status from orders where id = $1`, [sale1.id]))[0].payment_status === 'refunded');
  await visit(`/orders/${sale1.id}`, '!!document.querySelector("[data-order-origin]")');
  ok('order page: POS · Offline · branch with the bill link', /POS · Offline · POS Store 1/.test(await text('[data-order-origin]')) && await exists('[data-order-pos]'));
  await visit('/pos/report', '!!document.querySelector("[data-pos-report]")');
  ok('POS report: transactions, methods, by cashier and branch', /3/.test(await text('[data-kpi=transactions]')) && /UPI/.test(await text('[data-pos-methods]'))
    && /POS Store 1/.test(await text('[data-pos-group=byLocation]')) && /pos\.sales@test\.local/.test(await text('[data-pos-group=byCashier]')), await text('[data-pos-report]'));

  // ---------- 2026-10-12, unified billing: a coupon and the customer's loyalty points on a counter bill ----------
  // Discounts and loyalty are switched on in this LOCAL test database only, with test values, and switched off again below.
  await q(`insert into settings (key, value) values ('discounts.enabled', '"on"'), ('loyalty.enabled', '"on"'), ('loyalty.point_value_paise', '100') on conflict (key) do update set value = excluded.value`);
  await q(`insert into discounts (name, code, kind, value, scope, is_active) values ('POS e2e coupon', 'POSE2E10', 'percent', 1000, 'order', true)`);
  await q(`insert into loyalty_accounts (customer_id, balance) values ($1, 50) on conflict (customer_id) do update set balance = 50`, [kavya.id]);
  await q(`insert into loyalty_transactions (customer_id, points, kind, reason, remaining) values ($1, 50, 'adjust', 'POS e2e', 50)`, [kavya.id]);
  const posTotal = () => ev('Number(document.querySelector("[data-pos-total]")?.dataset.posTotal ?? 0)');
  const billKinds = () => ev(`[...document.querySelectorAll('[data-pos-totals] [data-pos-bill-line]')].map(e=>e.dataset.posBillLine).join()`);
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  await addBySearch('KTS-TOP-003', 'KTS-TOP-003-M');
  await until('Number(document.querySelector("[data-pos-total]")?.dataset.posTotal) > 0');
  const full = await posTotal();
  await click('[data-pos-method="card"]'); await fill('[data-pos-reference]', 'APPR-E2E-9911');
  await chargeReady();
  await fill('[data-pos-coupon-code]', 'nope1');
  ok('coupon that is not valid: the reason is shown, nothing is taken off, payment is blocked until it is removed', await until(`document.querySelector('[data-pos-coupon-state]')?.dataset.posCouponState === 'rejected'`, 8000)
    && /not valid/.test(await text('[data-pos-coupon-state]')) && (await posTotal()) === full && await ev('document.querySelector("[data-pos-charge]").disabled'), await text('[data-pos-coupon]'));
  await fill('[data-pos-coupon-code]', 'pose2e10');
  const couponOff = Math.floor(full / 10);
  ok('valid coupon: applied by the server, on its own line of the bill', await until(`document.querySelector('[data-pos-coupon-state]')?.dataset.posCouponState === 'applied'`, 8000)
    && await until(`Number(document.querySelector("[data-pos-total]")?.dataset.posTotal) === ${full - couponOff}`, 8000) && /Coupon POSE2E10/.test(await text('[data-pos-bill-line=coupon]')), await text('[data-pos-totals]'));
  ok('no customer on the bill: no points are offered', !(await exists('[data-pos-loyalty]')));
  await fill('[data-pos-customer-search]', '98400998');
  await until(`!!document.querySelector('[data-pos-customer-pick="pos.kavya@test.local"]')`, 8000);
  await click('[data-pos-customer-pick="pos.kavya@test.local"]');
  ok('customer on the bill: the cashier sees their points and what they can take off; nothing is used until ticked', await until(`document.querySelector('[data-pos-points-balance]')?.innerText === '50'`, 8000)
    && /Use 50 points/.test(await text('[data-pos-loyalty]')) && (await posTotal()) === full - couponOff && !(await exists('[data-pos-bill-line=loyalty]')), await text('[data-pos-loyalty]'));
  await click('[data-pos-use-points]');
  ok('points: taken off after the coupon, each on its own line; total = subtotal − coupon − points', await until(`Number(document.querySelector("[data-pos-total]")?.dataset.posTotal) === ${full - couponOff - 5000}`, 8000)
    && (await billKinds()).startsWith('coupon,loyalty'), `${await billKinds()} ${await posTotal()}`);
  await chargeReady(); await click('[data-pos-charge]');
  ok('sale with coupon and points recorded', await until('!!document.querySelector("[data-pos-done]")', 15000), await text('[data-pos-error]'));
  const [sale4] = await q(`select o.id, o.total_paise, o.discount_paise, o.loyalty_points_used, o.loyalty_discount_paise, o.pricing->>'coupon' coupon, o.customer_id,
    (select count(*)::int from discount_redemptions r where r.order_id = o.id and r.code = 'POSE2E10') redemptions, (select balance from loyalty_accounts where customer_id = o.customer_id) balance
    from orders o where o.pos_number is not null order by o.created_at desc limit 1`);
  ok('stored: the discount, the coupon and its use, the points used and the customer\'s new balance', sale4.total_paise === full - couponOff - 5000 && sale4.discount_paise === couponOff + 5000 && sale4.loyalty_points_used === 50
    && sale4.loyalty_discount_paise === 5000 && sale4.coupon === 'POSE2E10' && sale4.redemptions === 1 && sale4.balance === 0 && sale4.customer_id === kavya.id, JSON.stringify(sale4));
  await visit(`/pos/sale/${sale4.id}`, '!!document.querySelector("[data-pos-receipt]")');
  ok('bill: the same lines (coupon, points) and total as the counter showed', (await ev(`[...document.querySelectorAll('[data-receipt-bill]')].map(e=>e.dataset.receiptBill).join()`)).startsWith('subtotal,coupon,loyalty')
    && /50/.test(await text('[data-receipt-points]')) && (await text('[data-receipt-total]')).replace(/[^0-9]/g, '') === String(full - couponOff - 5000), await text('[data-pos-receipt]'));
  await visit(`/orders/${sale4.id}?tab=items`, '!!document.querySelector("[data-order-total]")');
  ok('order page (Items tab): the same bill breakdown', (await ev(`[...document.querySelectorAll('[data-bill-line]')].map(e=>e.dataset.billLine).join()`)).startsWith('subtotal,coupon,loyalty')
    && (await text('[data-order-total]')).replace(/[^0-9]/g, '') === String(full - couponOff - 5000),
    `${await ev(`[...document.querySelectorAll('[data-bill-line]')].map(e=>e.dataset.billLine).join()`)} ${await text('[data-order-total]')} ${await ev('location.pathname + location.search')}`);
  await q(`delete from settings where key in ('discounts.enabled', 'loyalty.enabled', 'loyalty.point_value_paise')`);
  await q(`update discounts set is_active = false where code = 'POSE2E10'`);

  // ---------- cashier closes the session ----------
  ok('cashier signs in again', await signIn('sales', 'POS Cashier'));
  await visit('/pos/sessions', '!!document.querySelector("[data-session-current]")');
  const expected = await text('[data-session-expected]');
  ok('session summary: 2 transactions (1 voided), expected cash = opening only (cash sale voided)', /2/.test(await text('[data-session-count]')) && /1,000\.00/.test(expected), expected);
  await autoConfirm();
  await fill('#pos-close-form input[name=countedCash]', '990');
  await submit('#pos-close-form');
  ok('variance needs a note', /note/i.test(await message('#pos-close-form')), await message('#pos-close-form'));
  await fill('#pos-close-form textarea[name=note]', 'Short ₹10');
  await submit('#pos-close-form');
  ok('session closed → history with variance', await until('!!document.querySelector("[data-session-closed]")', 15000) && /-₹10\.00|−₹10\.00|-10/.test(await text('[data-session-history]')), await text('[data-session-history]'));
  await visit('/pos', '!!document.querySelector("#pos-open-form") || !!document.querySelector("[data-pos]")');
  ok('after closing, the counter asks to open a new session', await exists('#pos-open-form'));
  // Ledger: every branch stock equals its ledger rows.
  const [{bad}] = await q(`select count(*)::int bad from location_stock s where s.qty <> (select coalesce(sum(m.delta), 0) from inventory_movements m
    where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)`);
  ok('branch stock equals the ledger', bad === 0);
  {   // its own scope: the names below do not meet the ones used earlier in this suite
  // ---------- POS phase 2 (2026-10-13): customer panel, several tenders, store credit, credit bill and repayment, order lookup, exchange ----------
  // Fixtures (local test DB, owner connection): stock for the manager's till, ₹500 of store credit for Kavya (ledger + balance
  // together, as the service writes them), returns switched on. Credit permissions are NOT given to a manager by the
  // migration; the business grants them, which is what the two inserts further down stand for.
  const LOC = (await q(`select l.code from pos_sessions s join locations l on l.id = s.location_id join staff_users u on u.id = s.staff_id where u.email = 'pos.manager@test.local' and s.status = 'open'`))[0]?.code ?? 'POS-S1';
  for (const [sku, n] of [['KTS-TOP-003-L', 8], ['KTS-TOP-003-M', 8], ['KTS-BTM-003-M', 6]])
    await q(`select public.adjust_location_stock((select id from product_variants where sku = $1), (select id from locations where code = '${LOC}'), $2, 'restock', null, 'POS phase 2 e2e stock')`, [sku, n]);
  const [kavya] = await q(`select id from customers where email = 'pos.kavya@test.local'`);
  await q(`insert into store_credit_accounts (customer_id, balance_paise) values ($1, 50000) on conflict (customer_id) do update set balance_paise = 50000`, [kavya.id]);
  await q(`insert into store_credit_entries (customer_id, amount_paise, balance_after, kind, reason, idempotency_key) values ($1, 50000, 50000, 'adjustment', 'E2E opening store credit', 'e2e-fixture-kavya-0001')`, [kavya.id]);
  await q(`insert into settings (key, value) values ('returns.enabled', '"on"'), ('returns.window_days', '7') on conflict (key) do update set value = excluded.value`);
  ok('manager signs in for phase 2', await signIn('manager', 'POS Manager'));
  await visit('/pos', '!!document.querySelector("#pos-open-form") || !!document.querySelector("[data-pos]")');
  if (await exists('#pos-open-form')) { await fill('#pos-open-form select[name=locationId]', (await q(`select id from locations where code = '${LOC}'`))[0].id); await fill('#pos-open-form input[name=openingCash]', '0'); await submit('#pos-open-form'); }
  ok('phase 2: the manager has an open session at the counter', await until(`!!document.querySelector('[data-pos]')`, 20000));
  const pickKavya = async () => { await fill('[data-pos-customer-search]', 'Kavya'); await until(`!!document.querySelector('[data-pos-customer-pick="pos.kavya@test.local"]')`); await click('[data-pos-customer-pick="pos.kavya@test.local"]'); return until(`!!document.querySelector('[data-pos-profile]')`, 10000); };

  // 1. customer panel: three separate balances and the earlier counter purchase
  ok('customer panel opens for the chosen customer', await pickKavya());
  ok('customer panel: store credit ₹500, no credit account, earlier orders listed', (await ev(`document.querySelector('[data-pos-profile-store-credit]').dataset.posProfileStoreCredit`)) === '50000'
    && /No credit account/.test(await text('[data-pos-profile]')) && (await ev(`document.querySelectorAll('[data-pos-profile-orders] li').length`)) >= 1, await text('[data-pos-profile]'));

  // 2. store credit + cash on one bill
  ok('phase 2: item added', await addBySearch('KTS-TOP-003', 'KTS-TOP-003-L'));
  await until(`!!document.querySelector('[data-pos-total]')`);
  const total1 = Number(await ev(`document.querySelector('[data-pos-total]').dataset.posTotal`));
  await click('[data-pos-split-toggle]');
  ok('several ways of paying: store credit is offered for this customer, credit is not (no account)', await until(`!!document.querySelector('[data-pos-split-amount=store_credit]')`) && !(await exists('[data-pos-split-amount=credit]')));
  await fill('[data-pos-split-amount=store_credit]', '500');
  ok('the screen says what is still to be paid, and Charge waits', await until(`document.querySelector('[data-pos-split-left]')?.dataset.posSplitLeft === '${total1 - 50000}'`) && (await ev(`document.querySelector('[data-pos-charge]').disabled`)) === true);
  await click('[data-pos-split-rest=cash]');
  ok('Rest fills cash with the remainder; the payments add up', await until(`document.querySelector('[data-pos-split-left]')?.dataset.posSplitLeft === '0'`) && await chargeReady());
  await click('[data-pos-charge]');
  ok('split sale completes', await until(`!!document.querySelector('[data-pos-done]')`, 15000), await text('[data-pos-error]'));
  const [sale1] = await q(`select o.id, o.pos_number, o.payment_method, o.payment_status from orders o where o.customer_id = $1 order by o.created_at desc limit 1`, [kavya.id]);
  const pay1 = await q(`select provider, method, amount_paise from payments where order_id = $1 order by provider`, [sale1.id]);
  ok('split sale stored: one bill, a cash row and a store-credit row; the balance is spent', sale1.payment_method === 'split' && sale1.payment_status === 'paid' && pay1.length === 2
    && pay1.some(p => p.provider === 'store_credit' && p.amount_paise === 50000) && pay1.some(p => p.provider === 'pos' && p.method === 'cash' && p.amount_paise === total1 - 50000)
    && (await q(`select balance_paise from store_credit_accounts where customer_id = $1`, [kavya.id]))[0].balance_paise === 0, JSON.stringify(pay1));
  await visit(`/pos/sale/${sale1.id}`, '!!document.querySelector("[data-pos-receipt]")');
  ok('bill: each tender on its own line, with share buttons', (await exists('[data-receipt-tender=store_credit]')) && (await exists('[data-receipt-tender=cash]')) && /wa\.me/.test(await ev(`document.querySelector('[data-receipt-share=whatsapp]').href`))
    && /^mailto:pos\.kavya@test\.local/.test(await ev(`document.querySelector('[data-receipt-share=email]').href`)));

  // 3. credit bill: refused until the business approves an account and grants the permission
  await q(`insert into role_permissions (role_id, permission_code) select id, 'pos.credit_sell' from roles where code = 'manager' on conflict do nothing`);
  await q(`insert into credit_accounts (customer_id, limit_paise, due_days, approved_by) values ($1, 1000000, 15, (select id from staff_users where email = 'pos.manager@test.local'))`, [kavya.id]);
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  await pickKavya();
  await addBySearch('KTS-BTM-003', 'KTS-BTM-003-M');
  await until(`!!document.querySelector('[data-pos-total]')`);
  const total2 = Number(await ev(`document.querySelector('[data-pos-total]').dataset.posTotal`));
  await click('[data-pos-split-toggle]');
  ok('credit is now offered, with what is available', await until(`!!document.querySelector('[data-pos-split-amount=credit]')`) && /10,000\.00 available/.test(await text('[data-pos-split]')));
  await click('[data-pos-split-rest=credit]');
  await chargeReady(); await click('[data-pos-charge]');
  ok('credit sale: saved, and the screen says when it is due', await until(`!!document.querySelector('[data-pos-credit-due]')`, 15000), await text('[data-pos-error]'));
  const [bill] = await q(`select b.id, b.order_id, b.amount_paise, b.outstanding_paise, b.status, o.payment_status, (b.due_on - (now() at time zone 'Asia/Kolkata')::date) days from credit_bills b join orders o on o.id = b.order_id where b.customer_id = $1`, [kavya.id]);
  ok('credit sale stored: a receivable due in 15 days, the order unpaid, no payment row', bill?.amount_paise === total2 && bill.outstanding_paise === total2 && bill.payment_status === 'unpaid' && bill.days === 15
    && (await q(`select count(*)::int n from payments where order_id = $1`, [bill.order_id]))[0].n === 0, JSON.stringify(bill));
  await visit(`/pos/sale/${bill.order_id}`, '!!document.querySelector("[data-pos-receipt]")');
  ok('bill: says TO PAY and by when', /TO PAY by \d{4}-\d{2}-\d{2}/.test(await text('[data-receipt-credit]')), await text('[data-receipt-credit]'));
  await visit('/pos/credit', '!!document.querySelector("[data-section=credit-bills]")');
  ok('credit page: the open bill and the outstanding total', (await ev(`document.querySelectorAll('[data-credit-bills] tbody tr').length`)) === 1 && (await text('[data-credit-outstanding]')).replace(/[^0-9.]/g, '') === (total2 / 100).toFixed(2), await text('[data-credit-outstanding]'));
  await visit(`/pos/credit/${bill.id}`, '!!document.querySelector("[data-credit-statement]")');
  ok('repayment needs its own permission: a manager without it gets no form', !(await exists('#credit-repay-form')) && /credit: repay/.test(await ev(`document.querySelector('main').innerText`)));
  await q(`insert into role_permissions (role_id, permission_code) select id, 'credit.repay' from roles where code = 'manager' on conflict do nothing`);
  await visit(`/pos/credit/${bill.id}`, '!!document.querySelector("#credit-repay-form")');
  await autoConfirm();
  await fill('#credit-repay-form input[name=amount]', String(total2 / 100 + 1));
  await submit('#credit-repay-form');
  ok('a repayment above what is owed is refused', /is owed on this bill/.test(await message('#credit-repay-form')), await message('#credit-repay-form'));
  await fill('#credit-repay-form input[name=amount]', '1000');
  await submit('#credit-repay-form');
  ok('part repayment recorded; the statement shows what is left', await until(`document.querySelector('[data-credit-owed]')?.dataset.creditOwed === '${total2 - 100000}'`, 15000) && (await ev(`document.querySelectorAll('[data-credit-repayment]').length`)) === 1, await message('#credit-repay-form'));
  await visit(`/pos/credit/${bill.id}`, '!!document.querySelector("#credit-repay-form")');
  await autoConfirm();
  await fill('#credit-repay-form input[name=amount]', String((total2 - 100000) / 100));
  await submit('#credit-repay-form');
  ok('full repayment: the bill is paid in full and the order is paid', await until(`document.querySelector('[data-credit-owed]')?.dataset.creditOwed === '0'`, 15000)
    && (await q(`select o.payment_status from orders o where o.id = $1`, [bill.order_id]))[0].payment_status === 'paid' && (await q(`select outstanding_paise from credit_accounts where customer_id = $1`, [kavya.id]))[0].outstanding_paise === 0);

  // 4. order lookup → exchange for another size of equal value
  await visit(`/pos/orders?q=${encodeURIComponent(sale1.pos_number)}`, '!!document.querySelector("[data-pos-order-results]") || !!document.querySelector("[data-pos-order-search]")');
  ok('order lookup finds the bill by its number and offers a return', (await ev(`document.querySelectorAll('[data-pos-order-results] tbody tr').length`)) === 1 && await exists('[data-pos-order-exchange]'));
  await visit(`/pos/exchange/${sale1.id}`, '!!document.querySelector("[data-exchange]")');
  const before = [await locQty(LOC, 'KTS-TOP-003-L'), await locQty(LOC, 'KTS-TOP-003-M')];
  await click('[data-exchange-line="KTS-TOP-003-L"] [data-exchange-plus]');
  ok('exchange: the value of the return is shown, and store credit is the default for a return only', await until(`document.querySelector('[data-exchange-return-value]')?.dataset.exchangeReturnValue === '${total1}'`, 10000)
    && /Issue store credit/.test(await text('[data-exchange-outcome-label]')), await text('[data-exchange-outcome-label]'));
  await fill('[data-exchange-search]', 'KTS-TOP-003');
  await until(`!!document.querySelector('[data-exchange-variant="KTS-TOP-003-M"]')`);
  await click('[data-exchange-variant="KTS-TOP-003-M"]');
  ok('exchange: another size of the same price is Even', await until(`/Even/.test(document.querySelector('[data-exchange-outcome-label]')?.innerText ?? '')`, 10000), await text('[data-exchange-totals]'));
  await click('[data-exchange-confirm]');
  ok('exchange saved', await until(`!!document.querySelector('[data-exchange-done]')`, 15000) && (await ev(`document.querySelector('[data-exchange-outcome]').dataset.exchangeOutcome`)) === 'even', await text('[data-exchange-error]'));
  const [ret] = await q(`select r.status, r.settlement, r.exchange_order_id, x.pos_number, x.exchange_return_id = r.id linked from return_requests r left join orders x on x.id = r.exchange_order_id where r.order_id = $1`, [sale1.id]);
  ok('exchange stored: return completed, linked replacement bill, one size back and one out', ret?.status === 'completed' && ret.settlement === 'even' && ret.linked === true
    && (await locQty(LOC, 'KTS-TOP-003-L')) === before[0] + 1 && (await locQty(LOC, 'KTS-TOP-003-M')) === before[1] - 1, JSON.stringify(ret));
  await visit(`/pos/exchange/${sale1.id}`, '!!document.querySelector("[data-exchange-nothing]") || !!document.querySelector("[data-exchange]")');
  ok('what was returned cannot be returned again', await exists('[data-exchange-nothing]'));
  await visit(`/pos/sale/${ret.exchange_order_id}`, '!!document.querySelector("[data-pos-receipt]")');
  ok('replacement bill names the original bill and the return', new RegExp(sale1.pos_number.replace(/[/]/g, '\\/')).test(await text('[data-receipt-exchange-of]')));

  // a damaged piece comes back with no replacement: store credit for its value, and it does NOT go back on sale
  await visit(`/pos/exchange/${bill.order_id}`, '!!document.querySelector("[data-exchange]")');
  const shelf = await locQty(LOC, 'KTS-BTM-003-M');
  await click('[data-exchange-line="KTS-BTM-003-M"] [data-exchange-plus]');
  await until(`!!document.querySelector('[data-exchange-damaged]')`);
  await click('[data-exchange-damaged]');
  await until(`/Issue store credit/.test(document.querySelector('[data-exchange-outcome-label]')?.innerText ?? '')`, 10000);
  await click('[data-exchange-confirm]');
  ok('damaged return: saved as store credit', await until(`!!document.querySelector('[data-exchange-done]')`, 15000) && (await ev(`document.querySelector('[data-exchange-outcome]').dataset.exchangeOutcome`)) === 'store_credit', await text('[data-exchange-error]'));
  ok('damaged return stored: not restocked, store credit equals what was paid, the ledger agrees with the balance', (await locQty(LOC, 'KTS-BTM-003-M')) === shelf
    && (await q(`select balance_paise from store_credit_accounts where customer_id = $1`, [kavya.id]))[0].balance_paise === total2
    && (await q(`select (select coalesce(sum(amount_paise), 0) from store_credit_entries where customer_id = $1)::int n`, [kavya.id]))[0].n === total2
    && (await q(`select i.restock, i.restocked_qty from return_items i join return_requests r on r.id = i.return_id where r.order_id = $1`, [bill.order_id]))[0].restocked_qty === 0);

  // 5. reports and the customer record keep the three things apart
  await visit('/pos/report', '!!document.querySelector("[data-pos-settled]")');
  ok('POS report: money, store credit, exchange value and credit on separate lines', (await text('[data-settled=store_credit]')).includes('500.00') && (await text('[data-settled=credit]')).replace(/[^0-9.]/g, '').endsWith((total2 / 100).toFixed(2))
    && (await text('[data-pos-repayments]')).replace(/,/g, '').includes((total2 / 100).toFixed(2)), await text('[data-pos-settled]'));
  await visit(`/customers/${kavya.id}?tab=payments`, '!!document.querySelector("[data-section=store-credit]")');
  ok('customer record: store credit and the credit account shown apart; a manager gets no adjustment or terms form', (await exists('[data-store-credit-balance]')) && (await exists('[data-credit-owed]'))
    && !(await exists('#store-credit-adjust-form')) && !(await exists('#credit-account-form')));
  await b.viewport(390, 844, true);
  await visit('/pos', '!!document.querySelector("[data-pos]")');
  ok('phone width: the new counter has no sideways scrolling', (await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth')) <= 1);
  await b.viewport(1440, 900);
  }
  // Phone width: the counter stacks, no sideways scrolling.
  await b.viewport(390, 844, true);
  await visit('/pos/sessions');
  ok('phone width: no horizontal overflow on POS pages', (await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth')) <= 1);
  ok('no browser errors on POS pages', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('POS browser tests ran to the end', false, e.message);
} finally {
  b.close(); await pool.end();
  console.log(out.join('\n'));
  const failed = out.filter(l => l.startsWith('FAIL')).length;
  console.log(`\n${out.length - failed}/${out.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
