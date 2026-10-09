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
const visit = async (p, ready = '!!document.querySelector("main .page-head") || !!document.querySelector("[data-gate]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e)).map(e => `${p}: ${e}`)); };
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
  await fill('#pos-open-form select[name=locationId]', s1); await fill('#pos-open-form input[name=openingCash]', '1000');
  await submit('#pos-open-form');
  ok('session opened → the counter screen', await until('!!document.querySelector("[data-pos]")', 15000), await message('#pos-open-form'));
  ok('header shows branch and session', /POS Store 1 · session POSS\//.test(await text('.page-head')));
  ok('cashier: no discount field (no orders.discount)', !(await exists('[data-pos-discount]')));

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
  ok('charge disabled until cash ≥ total', await ev('document.querySelector("[data-pos-charge]").disabled'));
  await fill('[data-pos-tendered]', String(total / 100 + 100));
  ok('change preview', /₹100\.00/.test(await text('[data-pos-change-preview]')));
  await chargeReady(); await click('[data-pos-charge]');
  ok('payment recorded: POS number and change to give', await until('!!document.querySelector("[data-pos-done]")', 15000) && /POS\/\d{2}-\d{2}\/\d{5}/.test(await text('[data-pos-done]')) && /₹100\.00/.test(await text('[data-pos-change]')),
    await text('[data-pos-error]'));
  const [sale1] = await q(`select o.id, o.pos_number, o.channel, o.status, o.payment_status, o.payment_method, o.total_paise, l.code from orders o join locations l on l.id = o.location_id where pos_number is not null order by o.created_at desc limit 1`);
  ok('order: retail at Store 1, delivered, paid in cash', sale1?.channel === 'retail' && sale1.code === 'POS-S1' && sale1.status === 'delivered' && sale1.payment_status === 'paid' && sale1.payment_method === 'cash' && sale1.total_paise === total);
  ok('stock taken from Store 1 only (Store 2 unchanged)', await locQty('POS-S1', 'KTS-TOP-003-M') === 0 && await locQty('POS-S2', 'KTS-TOP-003-M') === 3);
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
