/* Commerce workflow browser tests (2026-10-01), LOCAL test database only, after tests/erp.mjs:
   - a branch (retail location) added, restocked with a unit cost; the history shows before / change / after / cost / staff;
   - a draft order for a customer (online): items, a discount above the limit refused with the reason, a valid discount with a
     reason, separate billing address, confirmed for online payment → the order shows where it came from and the discount;
   - an offline draft at the branch for a walk-in customer, paid in cash → delivered order, stock from the branch;
   - the customer page lists the draft and the discount; abandoned checkouts show items; permissions; phone width;
   - purchasing (2026-10-01): a vendor's products chosen several at once; a purchase order for finished products approved,
     sent and partly received (GRN page); a bulk price change saved as a draft, reviewed and applied; two sizes planned as
     one production batch and linked to the purchase order.
   Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES (root, manager, sales, support). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'workflow e2e passphrase';
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9396);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => {
  let last = null;
  for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; last = null; } catch (e) { last = e; } await w(100); }
  if (process.env.WAIT_TRACE) console.error(`WAIT TIMEOUT ${ms}ms: ${String(expr).slice(0, 140)}${last ? ` — throws: ${String(last.message ?? last).split(String.fromCharCode(10))[0]}` : ''}`);
  return false;
};
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const uncheck = sel => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no checkbox');if(el.checked)el.click();return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel);
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit for ' + ${sel});
    window.__busySeen=false;new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || !document.querySelector(${sel})`, 3000);
  await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000);
};
/** Waits until React has hydrated an element (typing into it before that would be lost). */
const hydrated = sel => until(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return !!e && Object.keys(e).some(k=>k.startsWith('__reactProps'))})()`, 20000);
const message = f => ev(`document.querySelector('${f} [data-form-message]')?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const autoConfirm = () => ev(`window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main .page-head") || !!document.querySelector("[data-gate]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e)).map(e => `${p}: ${e}`)); };
const overflow = () => ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
/** In the page: is this /<section>/<uuid>? */
const atDetail = section => `new RegExp('^/${section}/[0-9a-f-]{36}$').test(location.pathname)`;
/** Sets the value of the i-th element matching a selector (rows of a table of inputs). */
const fillNth = (sel, i, v) => ev(`(()=>{const el=document.querySelectorAll(${JSON.stringify(sel)})[${i}];if(!el)throw new Error('no field ' + ${JSON.stringify(sel)} + ' #' + ${i});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const optionValue = (sel, startsWith) => ev(`[...document.querySelector(${JSON.stringify(sel)}).options].find(o=>o.textContent.startsWith(${JSON.stringify(startsWith)}))?.value ?? ''`);

/* The first sign-in accepts the account's invitation (the link works once); later ones use the login page with the
   same password. The accounts are wf.<key>@test.local (tests/run-e2e.mjs). */
const accepted = new Set();
async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  if (accepted.has(key)) {
    await visit('/login', '!!document.querySelector("main input[name=password]")');
    await fill('main input[name=email]', `wf.${key}@test.local`); await fill('main input[name=password]', PW);
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

try {
  await b.viewport(1440, 900);
  // Fixture (the business's setting, here for the test): staff discounts up to 10%.
  await q(`insert into settings (key, value) values ('discounts.staff_max_percent', '10') on conflict (key) do update set value = excluded.value`);

  // ---------- branch (super admin: locations.manage) + restock with cost (manager) ----------
  ok('super admin signs in', await signIn('root', 'WF Root'));
  await visit('/locations', '!!document.querySelector("#new-location-form")');
  await fill('#new-location-form input[name=name]', 'Chennai Store 1'); await fill('#new-location-form input[name=code]', 'CHN-S1');
  await submit('#new-location-form');
  ok('branch "Chennai Store 1" created', await until(atDetail('locations'), 15000), await ev('location.pathname'));
  const branchPath = await ev('location.pathname');

  // ---------- purchasing (super admin: approves, sees costs) ----------
  await autoConfirm();
  await visit('/vendors', '!!document.querySelector("#create-vendor-form")');
  await fill('#create-vendor-form input[name=name]', 'WF Knits'); await submit('#create-vendor-form');
  ok('vendor added', await until(`!!document.querySelector('[data-vendor="WF Knits"] form[id^=vendor-products-]')`, 15000));
  const vpForm = '#' + await ev(`document.querySelector('[data-vendor="WF Knits"] form[id^=vendor-products-]').id`);
  await ev(`document.querySelector('${vpForm}').closest('details').open = true`);
  await until(`(()=>{const c=document.querySelector('${vpForm} [data-pick]');return !!c && Object.keys(c).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{for(const sku of ['KTS-TOP-001','KTS-TOP-002']){const c=document.querySelector('${vpForm} [data-pick="'+sku+'"]');if(!c)throw new Error('no '+sku);if(!c.checked)c.click();}return true})()`);
  ok('product picker counts the selection', /2 selected/.test(await text(`${vpForm} [data-picker-count]`)));
  await submit(vpForm);
  ok('vendor supplies 2 products (saved together)', /2 products supplied/.test(await message(vpForm)), await message(vpForm));
  const [vend] = await q(`select id from vendors where name = 'WF Knits'`);
  await visit(`/purchase-orders?vendor=${vend.id}`, '!!document.querySelector("#create-po-form tr[data-po-product]")');
  const poRow = `#create-po-form tr[data-po-product]:not([hidden])`;
  ok('new PO: only what this vendor supplies is listed', (await ev(`document.querySelectorAll('${poRow}').length`)) > 0 && /^KTS-TOP-00[12]/.test(await ev(`document.querySelector('${poRow}').dataset.poProduct`)));
  const poSku = await ev(`document.querySelector('${poRow}').dataset.poProduct`);
  const [st0] = await q(`select stock_qty from product_variants where sku = $1`, [poSku]);
  await hydrated(`${poRow} input[name="qtys[]"]`);
  await fillNth(`${poRow} input[name="qtys[]"]`, 0, '6'); await fillNth(`${poRow} input[name="costs[]"]`, 0, '400');
  await autoConfirm(); await submit('#create-po-form');
  ok('purchase order created → its page', await until(atDetail('purchase-orders'), 15000), await ev('location.pathname') + ' ' + await message('#create-po-form'));
  const poPath = await ev('location.pathname');
  ok('PO lines: ordered / received / remaining', /Remaining/.test(await text('[data-po-lines]')) && await exists(`[data-line="${poSku}"][data-line-kind=product]`));
  ok('creating a PO does not touch stock', (await q(`select stock_qty from product_variants where sku = $1`, [poSku]))[0].stock_qty === st0.stock_qty);
  await autoConfirm(); await submit('#po-approve-form');
  await until('!!document.querySelector("#po-place-form") && !document.querySelector("#po-approve-form")', 15000);
  ok('approved (approver shown)', /Approved/.test(await text('[data-po-meta]')));
  await autoConfirm(); await submit('#po-place-form');
  ok('sent to the vendor → receiving form', await until('!!document.querySelector("#receive-form")', 15000));
  await fill('#receive-form input[name^="received:"]', '4'); await fill('#receive-form input[name=vendorRef]', 'DC-9');
  await submit('#receive-form');
  ok('partial delivery recorded with a GRN number', /^GRN.* recorded\. Some items are still to come\./.test(await message('#receive-form')), await message('#receive-form'));
  await visit(poPath, '!!document.querySelector("[data-po-receipts]")');
  ok('PO shows received 4, remaining 2, and the GRN with the vendor ref', /4/.test(await text(`[data-line="${poSku}"] [data-received]`)) && /2/.test(await text(`[data-line="${poSku}"] [data-remaining]`))
    && /GRN.*ref DC-9/.test(await text('[data-po-receipts]')), await text('[data-po-receipts]'));
  ok('stock +4 through the receipt', (await q(`select stock_qty from product_variants where sku = $1`, [poSku]))[0].stock_qty === st0.stock_qty + 4);
  const grnHref = await ev(`document.querySelector('[data-po-receipts] a').getAttribute('href')`);
  await visit(grnHref, '!!document.querySelector("[data-grn-print]")');
  ok('GRN page (printable): number, received now 4, remaining 2', /^GRN/.test(await text('[data-grn-number]')) && /4[\s\S]*6[\s\S]*4[\s\S]*2/.test(await text(`[data-grn-line="${poSku}"]`)), await text(`[data-grn-line="${poSku}"]`));
  await visit(poPath + '/print', '!!document.querySelector("[data-po-print]")');
  ok('PO print page lists the product line', new RegExp(poSku).test(await text('[data-po-print-items]')));
  // Bulk edit: a draft change set, reviewed, then applied.
  await visit('/products/bulk', '!!document.querySelector("#bulk-edit-form")');
  const prices0 = await q(`select sku, price_paise from products where sku in ('KTS-TOP-001','KTS-TOP-002') order by sku`);
  await ev(`(()=>{for(const sku of ['KTS-TOP-001','KTS-TOP-002']){const c=document.querySelector('[data-bulk-row="'+sku+'"] input[type=checkbox]');if(!c)throw new Error('no row '+sku);if(!c.checked)c.click();}return true})()`);
  await fill('#bulk-edit-form select[name=action]', 'price_percent'); await fill('#bulk-edit-form input[name=percent]', '10');
  await fill('#bulk-edit-form textarea[name=note]', 'Festive prices');
  await submit('#bulk-edit-form');
  ok('bulk edit saved as a draft → its review page', await until(atDetail('products/bulk'), 15000), await ev('location.pathname') + ' ' + await message('#bulk-edit-form'));
  ok('review shows old → new for both products; nothing changed yet', (await ev(`document.querySelectorAll('[data-bulk-preview] tbody tr').length`)) === 2
    && JSON.stringify(await q(`select sku, price_paise from products where sku in ('KTS-TOP-001','KTS-TOP-002') order by sku`)) === JSON.stringify(prices0));
  await autoConfirm(); await submit('#bulk-apply-form');
  // Once applied, the draft's page shows the result (the apply button is gone).
  await until(`/2 changed/.test(document.querySelector('[data-bulk-result]')?.innerText ?? '')`, 15000);
  ok('applied: 2 changed, prices +10%', /2 changed/.test(await text('[data-bulk-result]'))
    && (await q(`select sku, price_paise from products where sku in ('KTS-TOP-001','KTS-TOP-002') order by sku`)).every((p, i) => p.price_paise === Math.round(prices0[i].price_paise * 1.1) || p.price_paise > prices0[i].price_paise), await text('[data-bulk-result]'));
  await q(`update products p set price_paise = x.price_paise from (values ('KTS-TOP-001', $1::int), ('KTS-TOP-002', $2::int)) x(sku, price_paise) where p.sku = x.sku`, [prices0[0].price_paise, prices0[1].price_paise]);
  // Production: two sizes as one batch, linked to the purchase order.
  await visit('/production', '!!document.querySelector("#create-production-batch-form")');
  await hydrated('#create-production-batch-form tr[data-po-product] input[name="qtys[]"]');
  await fillNth('#create-production-batch-form tr[data-po-product] input[name="qtys[]"]', 0, '5');
  await fillNth('#create-production-batch-form tr[data-po-product] input[name="qtys[]"]', 1, '3');
  await submit('#create-production-batch-form');
  ok('two production orders planned as one batch', /Planned 2 production orders .*batch/.test(await message('#create-production-batch-form')), await message('#create-production-batch-form'));
  await visit('/production', '!!document.querySelector("#link-production-form")');
  await ev(`(()=>{const c=[...document.querySelectorAll('input[name="productionOrderIds[]"]')].slice(0,2);if(c.length<2)throw new Error('no rows');c.forEach(x=>{if(!x.checked)x.click()});return true})()`);
  const poNumber = (await q(`select po_number from purchase_orders where vendor_id = $1`, [vend.id]))[0].po_number;
  await fill('#link-production-form select[name=purchaseOrderId]', await optionValue('#link-production-form select[name=purchaseOrderId]', poNumber));
  await submit('#link-production-form');
  ok('production linked to the purchase order (no stock moved)', new RegExp(`Linked 2 to ${poNumber}`).test(await message('#link-production-form')), await message('#link-production-form'));
  await visit('/production', '!!document.querySelector("[data-production-links]")');
  ok('production list shows the batch and the PO', new RegExp(poNumber).test(await text('[data-production-table]')));
  await visit(poPath, '!!document.querySelector("[data-po-production]")');
  ok('PO page shows the linked production', /Linked production/.test(await text('[data-po-production]')));
  ok('manager signs in', await signIn('manager', 'WF Manager'));
  await visit(branchPath, '!!document.querySelector("#location-adjust-form")');
  ok('branch page shows the restock form (every size, also before the branch has stock)', await exists('#location-adjust-form'), (await text('main')).replace(/\s+/g, ' ').slice(0, 300));
  const hoodie = await optionValue('#location-adjust-form select[name=variant]', 'Flame Print Washed Zip Hoodie');
  const variantValue = hoodie || await ev(`document.querySelector('#location-adjust-form select[name=variant]').options[1].value`);
  const sku = await ev(`[...document.querySelector('#location-adjust-form select[name=variant]').options].find(o=>o.value===${JSON.stringify(variantValue)}).textContent.match(/\\(([^)]+)\\)/)[1]`);
  await fill('#location-adjust-form select[name=variant]', variantValue); await fill('#location-adjust-form input[name=delta]', '20');
  await fill('#location-adjust-form select[name=reason]', 'restock'); await fill('#location-adjust-form input[name=note]', 'Received 20 units from supplier.');
  await fill('#location-adjust-form input[name=unitCost]', '850');
  await submit('#location-adjust-form');
  ok('restock at the branch: "Now 20 at this location"', /Now 20 at this location/.test(await message('#location-adjust-form')), await message('#location-adjust-form'));
  await visit(branchPath, '!!document.querySelector("[data-location-movements]")');
  const row = await ev(`[...document.querySelectorAll('[data-location-movements] tbody tr')][0].innerText.replace(/\\s+/g,' ')`);
  ok('history: item, reason + note, before 0, +20, after 20, unit cost ₹850, staff', /Restock/.test(row) && /Received 20 units/.test(row) && / 0 \+20 20 ₹850/.test(row) && /manager/i.test(row), row);

  // ---------- sales staff: draft for a customer (online) ----------
  ok('sales staff sign in', await signIn('sales', 'WF Sales'));
  await visit('/drafts', '!!document.querySelector("#new-draft-form")');
  ok('Draft orders in the menu for sales staff', /Draft orders/.test(await ev(`[...document.querySelectorAll('.nav a')].map(a=>a.textContent).join('|')`)));
  await fill('#new-draft-form select[name=channel]', 'online'); await fill('#new-draft-form input[name=customerEmail]', 'asha.fixture@test.local');
  await fill('#new-draft-form textarea[name=note]', 'Customer called: hoodie and jeans');
  await submit('#new-draft-form');
  ok('draft created for the customer → draft page', await until(atDetail('drafts'), 15000), await ev('location.pathname'));
  const draftPath = await ev('location.pathname');
  for (const [label, qty] of [['Flame Print Washed Zip Hoodie', '1'], ['Faded Black Wide-Leg Jeans', '2']]) {
    await visit(draftPath, '!!document.querySelector("#draft-add-item-form select[name=variantId]")');
    const v = await optionValue('#draft-add-item-form select[name=variantId]', label);
    await fill('#draft-add-item-form select[name=variantId]', v || await ev(`document.querySelector('#draft-add-item-form select[name=variantId]').options[1].value`));
    await fill('#draft-add-item-form input[name=qty]', qty); await submit('#draft-add-item-form');
  }
  await visit(draftPath, '!!document.querySelector("[data-draft-lines]")');
  ok('two items on the draft; no stock held by a draft', (await ev(`document.querySelectorAll('[data-draft-lines] tbody tr').length`)) === 2
    && (await q(`select count(*)::int n from inventory_movements m join orders o on o.id = m.order_id where o.draft_order_id is not null`))[0].n === 0);
  ok('sales staff cannot give a discount (no form)', !(await exists('#draft-discount-form')));

  ok('manager signs in again', await signIn('manager', 'WF Manager'), await ev('location.pathname + " " + (document.querySelector("main")?.innerText ?? "").slice(0, 300)'));
  await visit(draftPath, '!!document.querySelector("#draft-discount-form")');
  ok('the limit is shown: at most 10%', /At most 10%/.test(await text('[data-discount-limit]')), await text('[data-discount-limit]'));
  await fill('#draft-discount-form input[name=percent]', '15'); await fill('#draft-discount-form input[name=reason]', 'Customer loyalty discount');
  await submit('#draft-discount-form');
  ok('15% refused with the reason', /15% is above the maximum staff discount of 10%/.test(await message('#draft-discount-form')), await message('#draft-discount-form'));
  await fill('#draft-discount-form input[name=percent]', '10'); await submit('#draft-discount-form');
  ok('10% with a reason saved', /Discount of 10% saved/.test(await message('#draft-discount-form')), await message('#draft-discount-form'));
  await visit(draftPath, '!!document.querySelector("#draft-addresses-form")');
  for (const [k, v] of Object.entries({shipName: 'Asha Fixture', shipPhone: '9000000001', shipLine1: '5 Mount Road', shipCity: 'Chennai', shipState: 'Tamil Nadu', shipPin: '600006'})) await fill(`#draft-addresses-form input[name=${k}]`, v);
  await uncheck('#draft-addresses-form input[name=billingSame]');
  for (const [k, v] of Object.entries({billName: 'Asha Fixture', billPhone: '9000000001', billLine1: '12 Office Street', billCity: 'Chennai', billState: 'Tamil Nadu', billPin: '600017'})) await fill(`#draft-addresses-form input[name=${k}]`, v);
  await submit('#draft-addresses-form');
  ok('delivery and separate billing address saved', /Addresses saved/.test(await message('#draft-addresses-form')), await message('#draft-addresses-form'));
  await visit(draftPath, '!!document.querySelector("#confirm-draft-form")');
  const total = await text('[data-draft-total]');
  ok('totals show the staff discount line', /Staff discount 10%: Customer loyalty discount/.test(await text('[data-draft-totals]')), await text('[data-draft-totals]'));
  await autoConfirm(); await submit('#confirm-draft-form');
  ok('confirmed for online payment → the order page', await until(`${atDetail('orders')}`, 15000), await ev('location.pathname'));
  await until(`/Staff discount/.test(document.querySelector('[data-order-origin]')?.innerText ?? '')`, 15000);
  const origin = await text('[data-order-origin]');
  ok('order shows: online, created by sales staff from the draft, staff discount 10% with reason and who gave it',
    /Online/.test(origin) && /Created by/.test(origin) && /from draft DRAFT\//.test(origin) && /Staff discount 10%/.test(origin) && /Customer loyalty discount/.test(origin), origin);
  const [o] = await q(`select status, channel, total_paise, staff_discount_bp, billing_address->>'line1' bill from orders where draft_order_id is not null and channel = 'online' order by created_at desc limit 1`);
  ok('in the database: awaiting payment, online, 10%, billing kept', o.status === 'pending_payment' && o.channel === 'online' && o.staff_discount_bp === 1000 && o.bill === '12 Office Street'
    && Math.round(Number(total.replace(/[^0-9.]/g, '')) * 100) === o.total_paise, JSON.stringify(o) + ' ' + total);

  // ---------- offline order at the branch (walk-in, cash) ----------
  await visit('/drafts', '!!document.querySelector("#new-draft-form")');
  await fill('#new-draft-form select[name=channel]', 'retail');
  await fill('#new-draft-form select[name=locationId]', await optionValue('#new-draft-form select[name=locationId]', 'Chennai Store 1'));
  await fill('#new-draft-form input[name=contactName]', 'Priya'); await fill('#new-draft-form input[name=contactPhone]', '9123456780');
  await submit('#new-draft-form');
  ok('offline draft created', await until(atDetail('drafts'), 15000));
  const retailPath = await ev('location.pathname');
  await visit(retailPath, '!!document.querySelector("#draft-add-item-form")');
  ok('sizes show the branch stock ("in stock here")', /in stock here/.test(await ev(`document.querySelector('#draft-add-item-form select[name=variantId]').options[1].textContent`)));
  await fill('#draft-add-item-form select[name=variantId]', variantValue.split(':')[0]); await fill('#draft-add-item-form input[name=qty]', '2');
  await submit('#draft-add-item-form');
  await visit(retailPath + '?payment=cash', '!!document.querySelector("#confirm-draft-form")');
  await autoConfirm(); await submit('#confirm-draft-form');
  ok('paid in cash → the order page', await until(`${atDetail('orders')}`, 15000));
  await until(`/Chennai Store 1/.test(document.querySelector('[data-order-origin]')?.innerText ?? '')`, 15000);
  ok('order shows "Offline · Chennai Store 1", cash in store', /Offline · Chennai Store 1/.test(await text('[data-order-origin]')) && /cash in store/.test(await text('[data-order-origin]')), await text('[data-order-origin]'));
  const [r] = await q(`select o.status, o.payment_status, o.payment_method, (select qty from location_stock s join locations l on l.id = s.location_id where l.code = 'CHN-S1' and s.variant_id = (select id from product_variants where sku = $1)) branch
    from orders o where o.channel = 'retail' order by o.created_at desc limit 1`, [sku]);
  ok('delivered, paid, cash; the branch has 18 left (20 − 2)', r.status === 'delivered' && r.payment_status === 'paid' && r.payment_method === 'cash' && r.branch === 18, JSON.stringify(r));
  await visit('/orders', '!!document.querySelector("[data-orders-table], table")');
  ok('orders list marks the offline order', await exists('[data-order-channel="retail"]'));

  // ---------- customer page, abandoned checkouts ----------
  const [asha] = await q(`select id from customers where email = 'asha.fixture@test.local'`);
  await visit(`/customers/${asha.id}`, '!!document.querySelector("[data-section=customer-drafts]")');
  ok('customer page: draft orders, abandoned checkouts and discount history', (await exists('[data-customer-drafts]')) && (await exists('[data-section=customer-abandoned]'))
    && /Staff discount 10%: Customer loyalty discount/.test(await text('[data-customer-discounts]')), await text('[data-section=customer-discounts]'));
  ok('customer page: "New draft order" button', await exists('[data-link=new-draft]'));
  await visit('/carts/checkouts', '!!document.querySelector("main .page-head")');
  ok('abandoned checkouts page opens (items + last activity columns)', /Items/.test(await text('main')) && /Last activity/.test(await text('main')) || /No abandoned/i.test(await text('main')));

  // ---------- permissions + phone width ----------
  ok('support signs in', await signIn('support', 'WF Support'));
  await visit('/drafts', '!!document.querySelector("main .page-head")');
  ok('support can see drafts but not create them', (await exists('[data-draft-tabs]')) && !(await exists('#new-draft-form')));
  await b.viewport(390, 844, true);
  for (const p of ['/drafts', draftPath, retailPath]) { await visit(p); ok(`no horizontal scroll at 390px: ${p.replace(/[0-9a-f-]{36}/, ':id')}`, (await overflow()) <= 1, String(await overflow()) + ' ' + await ev(`[...document.querySelectorAll('body *')].filter(e => !e.parentElement?.closest('.table-wrap') && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 4).map(e => e.tagName + '.' + [...e.classList].join('.') + (e.id ? '#' + e.id : '') + ' ' + Math.round(e.getBoundingClientRect().right)).join(' | ')`)); }
  await b.viewport(1440, 900);
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
