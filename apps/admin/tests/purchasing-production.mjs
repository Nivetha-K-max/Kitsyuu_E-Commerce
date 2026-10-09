/* Phase 9 browser tests: Purchasing & Production (2026-10-08), against the LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs after every other suite, with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin, inventory = inventory_manager: receives goods and records the quality check, nothing else here,
   support = neither purchasing nor production).
   What it changes, all through the existing actions: one vendor, one material, purchase orders received at a BRANCH
   (so the online stock is not touched by purchasing), material used on a production order, and one production order
   completed with 3 passed pieces (+3 online units; run-e2e.mjs expects exactly that). Every stock is compared with its
   ledger before and after. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'purchasing e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9407);
const ev = e => b.eval(e);
const allErrors = [];
const until = async (expr, ms = 10000) => {
  let last = null;
  for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; last = null; } catch (e) { last = e; } await w(100); }
  if (process.env.WAIT_TRACE) console.error(`WAIT TIMEOUT ${ms}ms: ${String(expr).slice(0, 140)}${last ? ` — throws: ${String(last.message ?? last).split(String.fromCharCode(10))[0]}` : ''}`);
  return false;
};
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const hydrated = sel => until(`(()=>{const f=document.querySelector(${JSON.stringify(sel)});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  await hydrated(formSel);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});
    window.__busySeen=false;if(f)new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const message = formSel => ev(`document.querySelector(${JSON.stringify(formSel + ' [data-form-message]')})?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const attr = (sel, name) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? ''`);
const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const list = (sel, expr) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>${expr})`);
const READY = '!!document.querySelector("main") && !document.querySelector("[data-loading]")';
const visit = async (p, ready = READY) => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e)).map(e => `${p}: ${e}`)); };
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const asked = () => ev('(window.__q ?? []).join(" | ")');
const click = async sel => { await hydrated(sel); await ev(`document.querySelector(${JSON.stringify(sel)}).click(),true`); };
/** The form is sent as an out-of-date page would send it: `name` carries `value` (null: the field is absent). */
const sendAs = (formSel, name, value) => ev(`(()=>{const f=document.querySelector(${JSON.stringify(formSel)});if(!f)throw new Error('no form');f.addEventListener('formdata',e=>{${value === null ? `e.formData.delete(${JSON.stringify(name)})` : `e.formData.set(${JSON.stringify(name)},${JSON.stringify(value)})`}});return true})()`);
const openDrawer = async (name, form) => { await click(`[data-drawer-open=${name}]`); return until(`!!document.querySelector(${JSON.stringify(`[data-drawer=${name}] ${form}`)})`); };
const noOverflow = () => ev('document.documentElement.scrollWidth <= innerWidth + 1');
const tabs = () => ev(`[...document.querySelectorAll('[data-entity-tab]')].map(a=>a.dataset.entityTab).join('|')`);
const moduleViews = () => ev(`[...document.querySelectorAll('[data-module-views=purchasing] [data-view]')].map(a=>a.dataset.view).join('|')`);
const VIEWS = '/purchase-orders|/vendors|/materials';
const actions = () => list('[data-activity] li', 'e.dataset.action');
const totals = async () => (await q(`select (select count(*)::int from inventory_movements) rows, (select count(*)::int from material_movements) material_rows,
  (select coalesce(sum(stock_qty),0)::int from product_variants) online_units, (select coalesce(sum(qty),0)::int from location_stock) located,
  (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online))))
  + (select count(*)::int from location_stock s where s.qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)) mismatch,
  (select count(*)::int from materials t where t.stock_qty <> (select coalesce(sum(m.delta),0) from material_movements m where m.material_id = t.id)) material_mismatch,
  (select count(*)::int from purchase_order_lines where qty_received > qty_ordered) over_received,
  (select count(*)::int from location_stock where qty < 0) + (select count(*)::int from product_variants where stock_qty < 0) + (select count(*)::int from materials where stock_qty < 0) negative`))[0];

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
  const before = await totals();
  ok('before: every stock equals its ledger (products at every location, materials); nothing negative', before.mismatch === 0 && before.material_mismatch === 0 && before.negative === 0, JSON.stringify(before));
  const findBranch = async () => (await q(`select id, name from locations where not is_online and is_active order by sort_order, name limit 1`))[0];
  // In the full run earlier suites have added branches. Run on its own (ONLY=purchasing-production) there is none yet: one empty branch is added as a fixture.
  if (!(await findBranch())) await q(`insert into locations (code, name, kind, is_active, sort_order) values ('P9-E2E', 'Purchasing Test Branch', 'retail', true, (select coalesce(max(sort_order), 0) + 1 from locations))`);
  const branch = await findBranch();
  const [online] = await q(`select id, name from locations where is_online`);
  const [product] = await q(`select p.id, p.sku, p.name from products p where p.status = 'active' order by p.sku limit 1`);
  const [size] = await q(`select id, sku, size, stock_qty from product_variants where product_id = $1 order by sort_order limit 1`, [product.id]);
  const heldAt = async (loc, variant = size.id) => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [loc, variant]))[0].n;
  const onlineQty = async () => (await q(`select stock_qty from product_variants where id = $1`, [size.id]))[0].stock_qty;
  const branch0 = await heldAt(branch.id), online0 = await onlineQty();

  // ================= super admin =================
  ok('super admin signs in', await signIn('root', 'Purchasing Root'));

  // ---------- Vendors ----------
  await visit('/vendors', '!!document.querySelector("[data-workspace=vendors]")');
  ok('vendors: on the workspace frame with the Purchasing views (Purchase orders · Vendors · Materials)', (await exists('[data-workspace=vendors] h1')) && (await moduleViews()) === VIEWS, await moduleViews());
  ok('vendors: adding one is in a drawer (no form on the page until it is opened)', !(await exists('#create-vendor-form')) && (await openDrawer('new-vendor', '#create-vendor-form')));
  await fill('#create-vendor-form input[name=name]', 'P9 Textiles'); await fill('#create-vendor-form input[name=contact]', 'Meena'); await fill('#create-vendor-form input[name=phone]', '+91 98400 00009');
  await submit('#create-vendor-form');
  ok('vendors: the new vendor appears in the list at once', (await until(`!!document.querySelector('[data-vendor="P9 Textiles"]')`, 15000)) && /Vendor added/.test(await message('#create-vendor-form')), await message('#create-vendor-form'));
  await fill('#create-vendor-form input[name=name]', 'p9 textiles'); await submit('#create-vendor-form');
  const [vendor] = await q(`select id from vendors where name = 'P9 Textiles'`);
  ok('vendors: the same name is refused, not added twice', /already exists/.test(await message('#create-vendor-form')) && (await q(`select count(*)::int n from vendors where lower(name) = 'p9 textiles'`))[0].n === 1);
  await visit('/vendors?q=p9+tex', '!!document.querySelector("[data-vendors-table]")');
  ok('vendors: search finds it; its row opens the vendor', (await count('[data-vendor]')) === 1 && (await attr('[data-vendor="P9 Textiles"] a.row-link', 'href')) === `/vendors/${vendor.id}`);
  await visit('/vendors?q=zzzz-nothing', '!!document.querySelector("[data-empty=vendors]")');
  ok('vendors: no match shows an empty state with a way back', /No matching vendors/.test(await text('[data-empty=vendors]')) && (await exists('[data-empty=vendors] a[href="/vendors"]')));

  // ---------- Vendor page ----------
  await visit(`/vendors/${vendor.id}`, '!!document.querySelector("[data-entity=vendor]")');
  ok('vendor: on the entity frame; tabs Overview · Purchase orders · Products supplied · Activity', (await text('[data-entity=vendor] h1')).startsWith('P9 Textiles') && (await tabs()) === 'overview|orders|products|activity', await tabs());
  ok('vendor: details and nothing open yet', /Meena/.test(await text('[data-vendor-details]')) && (await exists('[data-empty=vendor-open]')) && (await text('[data-fact=open-orders]')).trim() === '0');
  await visit(`/vendors/${vendor.id}?tab=products`, '!!document.querySelector("form[id^=vendor-products-]")');
  const vp = `#vendor-products-${vendor.id}`;
  await hydrated(`${vp} [data-pick="${product.sku}"]`);
  await ev(`document.querySelector('${vp} [data-pick="${product.sku}"]').click(),true`);
  await submit(vp);
  ok('vendor: a product it supplies is chosen and saved; it is listed and opens the product', /1 product supplied/.test(await message(vp))
    && (await until(`!!document.querySelector('[data-supplied="${product.sku}"]')`, 15000)) && (await attr(`[data-supplied="${product.sku}"] a.row-link`, 'href')) === `/products/${product.id}`, await message(vp));
  await visit(`/vendors/${vendor.id}?tab=activity`, '!!document.querySelector("[data-activity=vendor]")');
  ok('vendor: activity lists the creation and the product change', JSON.stringify(await actions()) === JSON.stringify(['vendor.products', 'vendor.create']), JSON.stringify(await actions()));

  // ---------- Materials ----------
  await visit('/materials', '!!document.querySelector("[data-workspace=materials]")');
  ok('materials: on the workspace frame; adding one is in a drawer', (await moduleViews()) === VIEWS && !(await exists('#create-material-form')) && (await openDrawer('new-material', '#create-material-form')));
  await fill('#create-material-form input[name=code]', 'P9-FABRIC'); await fill('#create-material-form input[name=name]', 'Phase nine fabric'); await fill('#create-material-form input[name=unit]', 'm');
  await submit('#create-material-form');
  ok('materials: the new material is listed with no stock', (await until(`!!document.querySelector('[data-material="P9-FABRIC"]')`, 15000)) && /^0 m/.test((await text('[data-material="P9-FABRIC"] [data-material-stock]')).trim()));
  const [material] = await q(`select id from materials where code = 'P9-FABRIC'`);
  const matQty = async () => Number((await q(`select stock_qty from materials where id = $1`, [material.id]))[0].stock_qty);
  await visit(`/materials/${material.id}`, '!!document.querySelector("[data-entity=material]")');
  ok('material: on the entity frame (Ledger · Details); the ledger is empty and says how stock arrives', (await tabs()) === 'ledger|details' && /purchase order/.test(await text('[data-empty=material-ledger]')));

  // ---------- New purchase order ----------
  await visit('/purchase-orders', '!!document.querySelector("[data-workspace=purchase-orders]")');
  ok('purchase orders: on the workspace frame; the views are the real statuses; a new order is started on its own page', (await moduleViews()) === VIEWS
    && (await list('[data-po-tabs] [data-view]', 'e.dataset.view')).join('|') === 'all|draft|approved|ordered|partially_received|received|closed|cancelled'
    && !(await exists('#create-po-form')) && (await attr('[data-link=new-po]', 'href')) === '/purchase-orders/new');
  await visit(`/purchase-orders/new?vendor=${vendor.id}`, '!!document.querySelector("#create-po-form tr[data-po-product]")');
  const visibleProducts = await ev(`[...document.querySelectorAll('#create-po-form tr[data-po-product]:not([hidden])')].map(r=>r.dataset.poProduct)`);
  const productSkus = (await q(`select sku from product_variants where product_id = $1`, [product.id])).map(r => r.sku);
  ok('new order: with a vendor chosen, only the products it supplies are listed (and every material)', visibleProducts.length > 0 && visibleProducts.every(s => productSkus.includes(s)) && (await exists('#create-po-form tr[data-po-material="P9-FABRIC"]:not([hidden])')), visibleProducts.join());
  await hydrated(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`);
  await fill(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`, '10'); await fill(`#create-po-form tr[data-po-product="${size.sku}"] input[name="costs[]"]`, '250');
  await fill('#create-po-form tr[data-po-material="P9-FABRIC"] input[name="qtys[]"]', '20'); await fill('#create-po-form tr[data-po-material="P9-FABRIC"] input[name="costs[]"]', '80');
  await fill('#create-po-form select[name=locationId]', branch.id);
  await autoConfirm(); await submit('#create-po-form');
  ok('new order: created as a draft and opened', await until(`/^\\/purchase-orders\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('[data-entity=purchase-order]')`, 20000), await ev('location.pathname'));
  const poPath = await ev('location.pathname'), poId = poPath.split('/').pop();
  const [po] = await q(`select po_number, status, location_id from purchase_orders where id = $1`, [poId]);
  const poLines = await q(`select id, variant_id, material_id from purchase_order_lines where purchase_order_id = $1 order by position`, [poId]);
  const pLine = poLines.find(l => l.variant_id).id, mLine = poLines.find(l => l.material_id).id;
  const poDb = async () => (await q(`select p.status, (select count(*)::int from goods_receipts where purchase_order_id = p.id) receipts,
    (select qty_received::float from purchase_order_lines where id = $2) product_received, (select qty_received::float from purchase_order_lines where id = $3) material_received from purchase_orders p where p.id = $1`, [poId, pLine, mLine]))[0];
  ok('new order: nothing entered stock; it is to be received at the chosen branch', po.status === 'draft' && po.location_id === branch.id && (await heldAt(branch.id)) === branch0 && (await onlineQty()) === online0 && (await matQty()) === 0);

  // ---------- Purchase order page ----------
  ok('order: on the entity frame; tabs Overview · Items · Receiving · Documents · Activity', (await text('[data-entity=purchase-order] h1')).startsWith(po.po_number) && (await tabs()) === 'overview|items|receiving|documents|activity', await tabs());
  ok('order: the header names the vendor (a link), where it is received, and what is ordered', (await attr('[data-po-facts] [data-fact=vendor] a', 'href')) === `/vendors/${vendor.id}`
    && (await text('[data-po-facts] [data-fact=location]')).trim() === branch.name && (await text('[data-po-facts] [data-fact=received]')).trim() === '30', await text('[data-po-facts]'));
  ok('order: Overview says where it stands and what comes next; a draft cannot be received yet', /A draft/.test(await text('[data-section=progress]')) && /Ordered\s*30/i.test(await text('[data-po-progress]'))
    && (await exists('#po-place-form')) && (await exists('#po-cancel-form')) && !(await exists('[data-link=receive]')));
  await visit(poPath + '?tab=items', '!!document.querySelector("[data-po-lines]")');
  ok('order → Items: both lines with ordered / received / remaining, unit cost, line total and the order value', (await count('[data-po-lines] tbody tr')) === 2
    && /10 pcs[\s\S]*0 pcs[\s\S]*10 pcs/.test(await text(`[data-line="${size.sku}"]`)) && /2,500\.00/.test(await text(`[data-line="${size.sku}"]`)) && /4,100\.00/.test(await text('[data-po-total]')) && (await exists('#po-line-form')), await text('[data-po-total]'));
  await visit(poPath + '?tab=receiving', '!!document.querySelector("[data-section=receipts]")');
  ok('order → Receiving: nothing can be received before the order is sent, and the page says so', !(await exists('#receive-form')) && /once the order has been sent/.test(await text('[data-empty=receipts]')));
  await visit(poPath + '?tab=documents', '!!document.querySelector("[data-po-documents]")');
  ok('order → Documents: the printable purchase order, marked as a draft', (await count('[data-po-documents] tbody tr')) === 1 && /Draft/.test(await text('[data-document=purchase-order]')) && (await attr('[data-link=print-po-document]', 'href')) === `${poPath}/print`);

  // ---------- Purchase order list ----------
  await visit(`/purchase-orders?q=${po.po_number}`, '!!document.querySelector("[data-po-table]")');
  const ROW = `[data-po="${po.po_number}"]`;
  ok('list: search finds the order; the row shows vendor, branch, quantity ordered, value and status, and opens the order', (await count('[data-po]')) === 1 && (await attr(`${ROW} a.row-link`, 'href')) === poPath
    && /P9 Textiles/.test(await text(ROW)) && (await text(ROW)).includes(branch.name) && /30 ordered/.test(await text(`${ROW} [data-po-received]`)) && /4,100\.00/.test(await text(ROW)) && (await attr(ROW, 'data-po-status')) === 'draft', await text(ROW));
  ok('list: the vendor in a row opens the vendor', (await attr(`${ROW} a[href^="/vendors/"]`, 'href')) === `/vendors/${vendor.id}`);
  await visit(`/purchase-orders?status=draft&vendor=${vendor.id}`, '!!document.querySelector("[data-po-table]")');
  ok('list: the Draft view and the vendor filter combine (in the address)', (await count('[data-po]')) === 1 && (await attr('[data-po-tabs] [data-view=draft]', 'aria-current')) === 'page');
  await visit('/purchase-orders?q=zzzz-nothing', '!!document.querySelector("[data-empty=purchase-orders]")');
  ok('list: no match shows an empty state with a way back', /No matching purchase orders/.test(await text('[data-empty=purchase-orders]')) && (await exists('[data-empty=purchase-orders] a[href="/purchase-orders"]')));

  // ---------- Send, then receive in parts ----------
  await visit(poPath, '!!document.querySelector("#po-place-form")');
  await autoConfirm(); await submit('#po-place-form');
  ok('order: sending asks first; then it is Sent and offers Receive goods', /Send this order to the vendor/.test(await asked()) && (await until(`!!document.querySelector('[data-link=receive]') && !document.querySelector('#po-place-form')`, 15000))
    && (await poDb()).status === 'ordered' && (await heldAt(branch.id)) === branch0);
  await click('[data-link=receive]');
  ok('order: Receive goods opens Receiving (in the address) with the form', (await until(`/tab=receiving/.test(location.search) && !!document.querySelector('#receive-form')`, 20000)));
  const P = `#receive-form input[name="received:${pLine}"]`, M = `#receive-form input[name="received:${mLine}"]`;
  ok('receiving: every line shows ordered, received and remaining, and the form says what is still to come', /10 pcs[\s\S]*0 pcs[\s\S]*10/.test(await text(`[data-receiving-line="${size.sku}"]`))
    && /10 pcs to come/.test(await text('#receive-form')) && /20 m to come/.test(await text('#receive-form')));
  // more than is outstanding: refused, nothing written
  await fill(P, '11'); await autoConfirm(); await submit('#receive-form');
  ok('receiving: more than the remaining quantity is refused with a clear message; nothing is written', /More was entered than is still outstanding/.test(await message('#receive-form')) && (await poDb()).receipts === 0 && (await heldAt(branch.id)) === branch0, await message('#receive-form'));
  ok('receiving: the confirmation says what will happen (stock ledger, goods receipt, cannot be edited)', /stock ledger/.test(await asked()) && /cannot be edited/.test(await asked()), await asked());
  await fill(P, ''); await fill(M, ''); await autoConfirm(); await submit('#receive-form');
  ok('receiving: an empty delivery is refused', (await poDb()).receipts === 0 && (await message('#receive-form')).length > 0, await message('#receive-form'));
  // cancelling the confirmation writes nothing
  await fill(P, '4'); await hydrated('#receive-form');
  await ev(`window.__acObs?.disconnect(),document.querySelector('#receive-form button[type=submit]').click(),true`);
  const dialog = await until(`!!document.querySelector('[data-confirm-dialog]')`, 8000);
  await ev(`(document.querySelector('[data-confirm-dialog] [data-confirm-cancel]') ?? [...document.querySelectorAll('[data-confirm-dialog] button')].find(x=>!x.matches('[data-confirm-accept]')))?.click(),true`);
  await w(600);
  ok('receiving: cancelling the confirmation records nothing', dialog && (await poDb()).receipts === 0 && (await heldAt(branch.id)) === branch0);
  // first delivery: 4 of 10 pieces, 5 of 20 m
  await visit(poPath + '?tab=receiving', '!!document.querySelector("#receive-form")');
  await fill(P, '4'); await fill(M, '5'); await fill('#receive-form input[name=vendorRef]', 'DN-41'); await autoConfirm(); await submit('#receive-form');
  ok('receiving: a partial delivery is recorded with its own goods receipt number', /^GRN.* recorded\. Some items are still to come\./.test(await message('#receive-form')), await message('#receive-form'));
  ok('receiving: ordered 10, received 4, remaining 6 on the page at once', await until(`/10 pcs[\\s\\S]*4 pcs[\\s\\S]*6/.test(document.querySelector('[data-receiving-line="${size.sku}"]')?.innerText ?? '') && document.querySelectorAll('[data-po-receipts] tbody tr').length === 1`, 15000), await text(`[data-receiving-line="${size.sku}"]`));
  let s = await poDb();
  ok('receiving: the database agrees: partly received, 4 pieces at the branch, 5 m of material, the online stock untouched', s.status === 'partially_received' && s.product_received === 4 && s.material_received === 5 && s.receipts === 1
    && (await heldAt(branch.id)) === branch0 + 4 && (await matQty()) === 5 && (await onlineQty()) === online0, JSON.stringify(s));
  ok('receiving: the ledger rows of the receipt are shown: +4 at the branch (a link to it) and +5 m of material', (await count('[data-receipt-movements] tbody tr')) === 2 && /\+4/.test(await text(`[data-movement="${size.sku}"] [data-delta]`))
    && (await attr(`[data-movement="${size.sku}"] a[href^="/locations/"]`, 'href')) === `/locations/${branch.id}` && /\+5 m/.test(await text('[data-movement="P9-FABRIC"] [data-delta]'))
    && (await attr('[data-movement="P9-FABRIC"] [data-link=material-ledger]', 'href')) === `/materials/${material.id}`, await text('[data-receipt-movements]'));
  const ledgerHref = await attr(`[data-movement="${size.sku}"] [data-link=ledger]`, 'href');
  // an out-of-date page: this tab still says "0 received" (as a second tab or a colleague's screen would after the delivery above)
  ok('receiving: the form carries what the page shows as already received (4 pieces, 5 m)', (await attr(`#receive-form input[name="seen:${pLine}"]`, 'value')) === '4' && (await attr(`#receive-form input[name="seen:${mLine}"]`, 'value')) === '5');
  await sendAs('#receive-form', `seen:${pLine}`, '0'); await fill(P, '4'); await autoConfirm(); await submit('#receive-form');
  s = await poDb();
  ok('receiving: the same delivery entered from an out-of-date page is refused and says so; nothing is written', /since you opened the page/.test(await message('#receive-form')) && s.receipts === 1 && s.product_received === 4 && (await heldAt(branch.id)) === branch0 + 4, await message('#receive-form'));
  await visit(poPath + '?tab=receiving', '!!document.querySelector("#receive-form")');
  // second delivery: the rest, with a double click on the button
  await fill(P, '6'); await fill(M, '15'); await hydrated('#receive-form'); await autoConfirm();
  await ev(`(()=>{const btn=document.querySelector('#receive-form button[type=submit]');btn.click();btn.click();return true})()`);
  await until(`!document.querySelector('#receive-form') && document.querySelectorAll('[data-po-receipts] tbody tr').length === 2`, 20000);
  await w(800);
  s = await poDb();
  ok('receiving: 4 then 6 is 10, never more; a double click on the button records one receipt, not two', s.status === 'received' && s.product_received === 10 && s.material_received === 20 && s.receipts === 2
    && (await heldAt(branch.id)) === branch0 + 10 && (await matQty()) === 20, JSON.stringify(s));
  ok('receiving: once everything has arrived the form is gone and the order reads Received', !(await exists('#receive-form')) && /Received/.test(await text('[data-entity=purchase-order] h1')) && (await text('[data-po-facts] [data-fact=received]')).trim() === '30 of 30');
  ok('receiving: one stock-ledger row per receipt and size (2 for the product, 2 for the material), all linked to their receipts', (await q(`select count(*)::int n from inventory_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = $1 and m.reason = 'purchase_in' and m.location_id = $2`, [poId, branch.id]))[0].n === 2
    && (await q(`select count(*)::int n from material_movements m join goods_receipts g on g.id = m.goods_receipt_id where g.purchase_order_id = $1 and m.reason = 'receipt'`, [poId]))[0].n === 2);

  // ---------- Trace: receipt → ledger → location; documents; activity ----------
  const grnHref = await attr('[data-po-receipts] tbody tr a', 'href');
  await visit(grnHref, '!!document.querySelector("[data-grn-print]")');
  ok('goods receipt: its page shows what arrived and leads back to the ledger rows on the order', /^GRN/.test(await text('[data-grn-number]')) && /4/.test(await text(`[data-grn-line="${size.sku}"]`)) && (await attr('[data-grn-trace] [data-link=po-receiving]', 'href')) === `${poPath}?tab=receiving`);
  await visit(ledgerHref, '!!document.querySelector("[data-movements-ledger]")');
  ok('trace: the Stock ledger link opens Inventory → Movements on this size\'s purchase receipts, each naming its goods receipt', (await count('[data-movement]')) >= 2 && /GRN/.test(await text('[data-movements-ledger]')), ledgerHref);
  await visit(`/locations/${branch.id}`, '!!document.querySelector("main")');
  ok('trace: the branch holds the received pieces', new RegExp(size.sku).test(await text('main')));
  await visit(poPath + '?tab=documents', '!!document.querySelector("[data-po-documents]")');
  ok('order → Documents: the purchase order and both goods receipts, each opening its printable page', (await count('[data-po-documents] tbody tr')) === 3 && (await list('[data-po-documents] tbody a', 'e.getAttribute("href")')).every(h => h.startsWith(poPath + '/')));
  await visit(poPath + '/print', '!!document.querySelector("[data-po-print]")');
  ok('print: the purchase order prints with the vendor, both items and the total', /P9 Textiles/.test(await text('[data-po-print]')) && (await count('[data-po-print-items] tbody tr')) === 2 && /4,100\.00/.test(await text('[data-po-print-items] tfoot')));
  await visit(poPath + '?tab=activity', '!!document.querySelector("[data-activity=purchase-order]")');
  ok('order → Activity: created, sent and both receipts, newest first, with who did it', JSON.stringify(await actions()) === JSON.stringify(['purchase_order.receive', 'purchase_order.receive', 'purchase_order.place', 'purchase_order.create'])
    && /GRN/.test(await text('[data-activity=purchase-order]')) && /@/.test(await text('[data-activity=purchase-order] li')), JSON.stringify(await actions()));
  await visit(`/materials/${material.id}`, '!!document.querySelector("[data-material-ledger]")');
  ok('material ledger: both receipts with their balance, each linking to its goods receipt and purchase order', (await count('[data-material-movement=receipt]')) === 2 && /20 m/.test(await text('[data-material-facts] [data-fact=stock]'))
    && /\+15 m[\s\S]*20 m/.test(await text('[data-material-movement=receipt]')) && (await attr('[data-material-movement=receipt] [data-reference] a:last-child', 'href')) === `${poPath}?tab=receiving`, await text('[data-material-ledger] tbody tr'));
  await visit(`/vendors/${vendor.id}?tab=orders`, '!!document.querySelector("[data-vendor-orders]")');
  ok('vendor → Purchase orders: the order with what was received, opening the order', (await attr(`[data-vendor-order="${po.po_number}"] a.row-link`, 'href')) === poPath && /30 of 30/.test(await text(`[data-vendor-order="${po.po_number}"]`)));

  // ---------- Close; cancel a draft ----------
  await visit(poPath, '!!document.querySelector("#po-close-form")');
  await autoConfirm(); await submit('#po-close-form');
  ok('order: a fully received order is closed (asks first)', (await until(`!document.querySelector('#po-close-form')`, 15000)) && (await poDb()).status === 'closed' && /Close the order/.test(await asked()));
  await visit(`/purchase-orders/new?vendor=${vendor.id}`, '!!document.querySelector("#create-po-form tr[data-po-product]")');
  await hydrated(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`);
  await fill(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`, '2'); await fill('#create-po-form select[name=locationId]', branch.id);
  await autoConfirm(); await submit('#create-po-form');
  await until(`/^\\/purchase-orders\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('#po-cancel-form')`, 20000);
  const po2Path = await ev('location.pathname'), po2Id = po2Path.split('/').pop();
  await ev(`document.querySelector('#po-cancel-form').closest('details').open = true`);
  await autoConfirm(); await submit('#po-cancel-form');
  ok('order: cancelling needs a reason', (await q(`select status from purchase_orders where id = $1`, [po2Id]))[0].status === 'draft');
  await fill('#po-cancel-form input[name=note]', 'Not needed'); await autoConfirm(); await submit('#po-cancel-form');
  await until(`!document.querySelector('#po-cancel-form')`, 15000);
  await visit(po2Path + '?tab=receiving', '!!document.querySelector("[data-section=receipts]")');
  ok('order: a cancelled order is Cancelled, offers nothing more and cannot be received', (await q(`select status from purchase_orders where id = $1`, [po2Id]))[0].status === 'cancelled' && !(await exists('#receive-form')) && !(await exists('[data-link=receive]')) && (await heldAt(branch.id)) === branch0 + 10);
  // a third order, sent and left open for the inventory manager below
  await visit(`/purchase-orders/new?vendor=${vendor.id}`, '!!document.querySelector("#create-po-form tr[data-po-product]")');
  await hydrated(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`);
  await fill(`#create-po-form tr[data-po-product="${size.sku}"] input[name="qtys[]"]`, '2'); await fill('#create-po-form select[name=locationId]', branch.id);
  await autoConfirm(); await submit('#create-po-form');
  await until(`/^\\/purchase-orders\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('#po-place-form')`, 20000);
  const po3Path = await ev('location.pathname'), po3Id = po3Path.split('/').pop();
  await autoConfirm(); await submit('#po-place-form');
  await until(`!document.querySelector('#po-place-form')`, 15000);
  const [po3Line] = await q(`select id from purchase_order_lines where purchase_order_id = $1`, [po3Id]);
  await visit('/purchase-orders?status=ordered', '!!document.querySelector("[data-po-table]")');
  ok('list: the Sent view shows what is still to come on an open order', /0 of 2/.test(await text(`[data-po-status=ordered] [data-po-received]`)) && (await text('[data-po-status=ordered] [data-po-outstanding]')).trim() === '2');

  // ---------- Production ----------
  await visit('/production', '!!document.querySelector("[data-workspace=production]")');
  ok('production: on the workspace frame; the views are the real statuses; planning is on its own page', (await list('[data-production-tabs] [data-view]', 'e.dataset.view')).join('|') === 'all|planned|in_progress|completed|cancelled'
    && !(await exists('#create-production-form')) && (await attr('[data-link=new-production]', 'href')) === '/production/new');
  await visit('/production/new', '!!document.querySelector("#create-production-form")');
  await fill('#create-production-form select[name=variantId]', size.id); await fill('#create-production-form input[name=qty]', '5');
  await submit('#create-production-form');
  ok('production: an order is planned and opened', await until(`/^\\/production\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('[data-entity=production-order]')`, 20000), await ev('location.pathname'));
  const prPath = await ev('location.pathname'), prId = prPath.split('/').pop();
  const [pr] = await q(`select number from production_orders where id = $1`, [prId]);
  const prDb = async () => (await q(`select o.status, (select qty_passed from qc_results where production_order_id = o.id) passed,
    (select coalesce(sum(qty_consumed),0)::float from production_inputs where production_order_id = o.id) used,
    (select count(*)::int from inventory_movements where reason = 'production_in' and note = o.number) stock_rows from production_orders o where o.id = $1`, [prId]))[0];
  ok('production order: on the entity frame; tabs Overview · Materials · Output · Activity', (await text('[data-entity=production-order] h1')).startsWith(pr.number) && (await tabs()) === 'overview|materials|output|activity', await tabs());
  ok('production order: planned 5, nothing made, 5 remaining; the piece opens the product; planning added nothing to stock', /Planned\s*5/i.test(await text('[data-production-progress]')) && /Remaining\s*5/i.test(await text('[data-production-progress]'))
    && (await attr('[data-production-facts] [data-fact=piece] a', 'href')) === `/products/${product.id}?tab=production` && (await onlineQty()) === online0, await text('[data-production-progress]'));
  await visit(prPath + '?tab=output', '!!document.querySelector("[data-empty=production-output]")');
  ok('production order → Output: nothing can be completed before production starts, and the page says so', !(await exists('#qc-form')) && /Start production first/.test(await text('[data-empty=production-output]')));
  await visit(prPath + '?tab=materials', '!!document.querySelector("#production-input-form")');
  await fill('#production-input-form select[name=materialId]', material.id); await fill('#production-input-form input[name=qtyPlanned]', '8');
  await submit('#production-input-form');
  ok('production order → Materials: a material is planned (taking nothing from stock); using it waits for the start', (await until(`!!document.querySelector('[data-input="P9-FABRIC"]')`, 15000)) && /8 m/.test(await text('[data-input="P9-FABRIC"] [data-planned]'))
    && !(await exists('#consume-form')) && (await exists('[data-consume-later]')) && (await matQty()) === 20);
  ok('production order → Materials: what to buy is worked out from stock (covered: 20 m in stock for 8 planned)', (await attr('[data-procurement-status]', 'data-procurement-status')) === 'in_stock');
  await visit(prPath, '!!document.querySelector("#production-start-form")');
  await submit('#production-start-form');
  ok('production order: started; the header offers the next steps', (await until(`!!document.querySelector('[data-link=record-output]') && !document.querySelector('#production-start-form')`, 15000)) && (await prDb()).status === 'in_progress' && (await exists('[data-link=record-materials]')));
  await click('[data-link=record-materials]');
  await until(`/tab=materials/.test(location.search) && !!document.querySelector('#consume-form')`, 20000);
  // more than is in stock: refused
  await fill('#consume-form select[name=materialId]', material.id); await fill('#consume-form input[name=qty]', '100'); await autoConfirm(); await submit('#consume-form');
  ok('material used: more than is in stock is refused with a clear message; nothing is taken', /not enough of this material/.test(await message('#consume-form')) && (await matQty()) === 20 && (await prDb()).used === 0, await message('#consume-form'));
  ok('material used: the confirmation says it is taken from material stock through the ledger', /material ledger/.test(await asked()) && /cannot be edited/.test(await asked()), await asked());
  await fill('#consume-form select[name=materialId]', material.id); await fill('#consume-form input[name=qty]', '3'); await hydrated('#consume-form'); await autoConfirm();
  await ev(`(()=>{const btn=document.querySelector('#consume-form button[type=submit]');btn.click();btn.click();return true})()`);
  await until(`/Material left in stock: 17/.test(document.querySelector('#consume-form [data-form-message]')?.innerText ?? '')`, 20000);
  await w(800);
  ok('material used: 3 m recorded once (a double click on the button records one use, not two); 17 m left', (await matQty()) === 17 && (await prDb()).used === 3
    && (await q(`select count(*)::int n from material_movements where material_id = $1 and reason = 'consume' and note = $2`, [material.id, pr.number]))[0].n === 1, await message('#consume-form'));
  ok('material used: the order shows planned 8, used 3, and the ledger row it wrote (−3, balance 17)', (await until(`/3 m/.test(document.querySelector('[data-input="P9-FABRIC"] [data-used]')?.innerText ?? '') && !!document.querySelector('[data-usage-ledger]')`, 15000))
    && /-3 m/.test(await text('[data-usage="P9-FABRIC"] [data-delta]')) && /17 m/.test(await text('[data-usage="P9-FABRIC"] [data-balance]')), await text('[data-usage-ledger]'));
  await visit(prPath + '?tab=materials', '!!document.querySelector("#consume-form")');
  const usedSeen = await attr(`#consume-form input[name="used:${material.id}"]`, 'value');
  await sendAs('#consume-form', `used:${material.id}`, '0'); await fill('#consume-form select[name=materialId]', material.id); await fill('#consume-form input[name=qty]', '3'); await autoConfirm(); await submit('#consume-form');
  ok('material used: the form carries what the page shows as used (3 m); the same use entered from an out-of-date page is refused and nothing is taken', usedSeen === '3' && /since you opened the page/.test(await message('#consume-form'))
    && (await matQty()) === 17 && (await prDb()).used === 3 && (await q(`select count(*)::int n from material_movements where material_id = $1 and reason = 'consume'`, [material.id]))[0].n === 1, await message('#consume-form'));
  await visit(`/materials/${material.id}`, '!!document.querySelector("[data-material-ledger]")');
  ok('material ledger: the use is a row that opens the production order', (await count('[data-material-movement=consume]')) === 1 && (await attr('[data-material-movement=consume] [data-reference] a', 'href')) === `${prPath}?tab=materials`
    && /17 m/.test(await text('[data-material-facts] [data-fact=stock]')));
  // output
  await visit(prPath, '!!document.querySelector("[data-link=record-output]")');
  await click('[data-link=record-output]');
  await until(`/tab=output/.test(location.search) && !!document.querySelector('#qc-form')`, 20000);
  await fill('#qc-form input[name=passed]', '3'); await fill('#qc-form input[name=rejected]', '1'); await autoConfirm(); await submit('#qc-form');
  ok('output: rejected pieces need a reason; nothing is completed without it', (await prDb()).status === 'in_progress' && (await onlineQty()) === online0 && (await message('#qc-form')).length > 0, await message('#qc-form'));
  await fill('#qc-form input[name=passed]', '3'); await fill('#qc-form input[name=rejected]', '1'); await fill('#qc-form input[name=rejectReason]', 'Loose stitching'); await hydrated('#qc-form'); await autoConfirm();
  await ev(`(()=>{const btn=document.querySelector('#qc-form button[type=submit]');btn.click();btn.click();return true})()`);
  await until(`!document.querySelector('#qc-form') && !!document.querySelector('[data-qc-result]')`, 20000);
  await w(800);
  const done = await prDb();
  ok('output: completed once (a double click completes it once): 3 passed pieces entered the online stock, the rejected one did not', done.status === 'completed' && done.passed === 3 && done.stock_rows === 1 && (await onlineQty()) === online0 + 3
    && /cannot be undone/.test(await asked()), JSON.stringify(done));
  ok('output: planned 5, passed 3, rejected 1, remaining 1 (not made on this order)', /Planned\s*5/i.test(await text('[data-qc-result]')) && (await text('[data-qc-result] [data-fact=passed]')).trim() === '3'
    && /^1 — Loose stitching/.test((await text('[data-qc-result] [data-fact=rejected]')).trim()) && /^1 not made/.test((await text('[data-qc-result] [data-fact=remaining]')).trim()), await text('[data-qc-result]'));
  ok('output: the stock-ledger row of the order is shown (+3, the balance, the online location) with a link into the ledger', (await count('[data-output-movement] tbody tr')) === 1 && /\+3/.test(await text('[data-output-movement] [data-delta]'))
    && (await text('[data-output-movement] [data-balance]')).trim() === String(online0 + 3) && (await text('[data-output-movement]')).includes(online.name) && /reason=production_in/.test(await attr('[data-output-movement] [data-link=ledger]', 'href')));
  await visit(await attr('[data-output-movement] [data-link=ledger]', 'href'), '!!document.querySelector("[data-movements-ledger]")');
  ok('trace: Inventory → Movements shows the production receipt of this size', (await count('[data-movement]')) >= 1 && /\+3/.test(await text('[data-movements-ledger]')));
  await visit(prPath, '!!document.querySelector("[data-production-progress]")');
  ok('production order: Overview reads completed 3, rejected 1, remaining 1, and says a new order is needed for the rest; nothing more can be done', /Completed\s*3/i.test(await text('[data-production-progress]')) && /Remaining\s*1/i.test(await text('[data-production-progress]'))
    && (await exists('[data-production-short]')) && !(await exists('[data-section=status]')) && !(await exists('[data-link=record-output]')) && (await text('[data-production-facts] [data-fact=passed]')).trim() === '3 of 5', await text('[data-production-progress]'));
  await visit(prPath + '?tab=activity', '!!document.querySelector("[data-activity=production-order]")');
  ok('production order → Activity: planned, material planned, started, material used, completed', JSON.stringify(await actions()) === JSON.stringify(['production.complete', 'production.consume', 'production.start', 'production.input_plan', 'production.create']), JSON.stringify(await actions()));
  await visit(`/production?q=${pr.number}`, '!!document.querySelector("[data-production-table]")');
  ok('production list: search finds the order; it reads Completed with 3 of 5 passed and opens the order', (await count('[data-production]')) === 1 && (await attr(`[data-production="${pr.number}"]`, 'data-production-status')) === 'completed'
    && (await text(`[data-production="${pr.number}"] [data-passed]`)).trim() === '3 of 5' && (await attr(`[data-production="${pr.number}"] a.row-link`, 'href')) === prPath);
  await visit('/production?q=zzzz-nothing', '!!document.querySelector("[data-empty=production]")');
  ok('production list: no match shows an empty state with a way back', /No matching production orders/.test(await text('[data-empty=production]')) && (await exists('[data-empty=production] a[href="/production"]')));
  // a second order: cancelled with a reason; a third: started and left for the inventory manager
  const plan = async qty => { await visit('/production/new', '!!document.querySelector("#create-production-form")'); await fill('#create-production-form select[name=variantId]', size.id); await fill('#create-production-form input[name=qty]', String(qty));
    await submit('#create-production-form'); await until(`/^\\/production\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('#production-start-form')`, 20000); return ev('location.pathname'); };
  const pr2Path = await plan(2), pr2Id = pr2Path.split('/').pop();
  await ev(`document.querySelector('#production-cancel-form').closest('details').open = true`);
  await autoConfirm(); await submit('#production-cancel-form');
  const stillPlanned = (await q(`select status from production_orders where id = $1`, [pr2Id]))[0].status === 'planned';
  await fill('#production-cancel-form input[name=note]', 'Fabric delayed'); await autoConfirm(); await submit('#production-cancel-form');
  ok('production order: cancelling needs a reason and asks first; a cancelled order says why and added nothing to stock', stillPlanned && (await until(`!!document.querySelector('[data-cancelled]')`, 15000)) && /Fabric delayed/.test(await text('[data-cancelled]'))
    && /cannot be undone/.test(await asked()) && (await onlineQty()) === online0 + 3);
  await visit(pr2Path + '?tab=output', '!!document.querySelector("[data-empty=production-output]")');
  ok('production order → Output: a cancelled order offers no quality check', !(await exists('#qc-form')) && /added nothing to stock/.test(await text('[data-empty=production-output]')));
  const pr3Path = await plan(2);
  await submit('#production-start-form');
  await until(`!document.querySelector('#production-start-form')`, 15000);

  // ================= inventory manager: receives goods and records the quality check; nothing else =================
  ok('inventory manager signs in', await signIn('inventory', 'Purchasing Stock'));
  await visit('/purchase-orders', '!!document.querySelector("[data-po-table]")');
  ok('inventory manager: sees purchase orders, but no New purchase order and no order values', !(await exists('[data-link=new-po]')) && !/Order value/i.test(await text('[data-po-table] thead')));
  await visit('/purchase-orders/new');
  ok('inventory manager: the new-order page is not served', (await exists('[data-gate=forbidden]')) && !(await exists('#create-po-form')));
  await visit(po3Path, '!!document.querySelector("[data-entity=purchase-order]")');
  ok('inventory manager: an open order offers Receive goods but no status change', (await exists('[data-link=receive]')) && !(await exists('[data-section=status]')) && !(await exists('#po-cancel-form')));
  await visit(po3Path + '?tab=items', '!!document.querySelector("[data-po-lines]")');
  ok('inventory manager: items without costs', !/Unit cost|Line total/i.test(await text('[data-po-lines] thead')) && !(await exists('#po-line-form')));
  await visit(po3Path + '?tab=receiving', '!!document.querySelector("#receive-form")');
  await fill(`#receive-form input[name="received:${po3Line.id}"]`, '1'); await autoConfirm(); await submit('#receive-form');
  ok('inventory manager: records a delivery (1 of 2): partly received, +1 at the branch', /^GRN.* recorded/.test(await message('#receive-form')) && (await q(`select status from purchase_orders where id = $1`, [po3Id]))[0].status === 'partially_received' && (await heldAt(branch.id)) === branch0 + 11, await message('#receive-form'));
  await visit(`/vendors/${vendor.id}`, '!!document.querySelector("[data-entity=vendor]")');
  ok('inventory manager: a vendor is read-only (no edit, no deactivate, no new order)', !(await exists('[data-drawer-open=edit-vendor]')) && !(await exists('[id^=vendor-active-]')) && !(await exists('[data-link=new-po]')) && (await exists('[data-readonly=vendor]')));
  await visit('/vendors', '!!document.querySelector("[data-vendors-table]")');
  ok('inventory manager: the vendor list offers no New vendor', !(await exists('[data-drawer-open]')) && (await exists('[data-readonly=vendors]')));
  await visit(`/materials/${material.id}?tab=details`, '!!document.querySelector("[data-entity=material]")');
  ok('inventory manager: a material is read-only (no adjust, no edit)', !(await exists('[data-drawer-open=adjust-material]')) && !(await exists('[id^=mat-edit-]')) && (await exists('[data-readonly=material]')));
  await visit('/production/new');
  ok('inventory manager: the plan-production page is not served', (await exists('[data-gate=forbidden]')) && !(await exists('#create-production-form')));
  await visit(pr3Path, '!!document.querySelector("[data-entity=production-order]")');
  ok('inventory manager: a started order offers the quality check but neither cancelling nor recording materials', (await exists('[data-link=record-output]')) && !(await exists('[data-section=status]')) && !(await exists('[data-link=record-materials]')));
  await visit(pr3Path + '?tab=materials', '!!document.querySelector("[data-section=inputs]")');
  ok('inventory manager: Materials is read-only', !(await exists('#consume-form')) && !(await exists('#production-input-form')) && !(await exists('#raise-po-form')));
  await visit(pr3Path + '?tab=output', '!!document.querySelector("#qc-form")');
  ok('inventory manager: the quality check form is offered on Output', await exists('#qc-form'));

  // ================= support: neither purchasing nor production =================
  ok('support signs in', await signIn('support', 'Purchasing Support'));
  const gates = [];
  for (const p of ['/purchase-orders', '/purchase-orders/new', poPath, poPath + '?tab=receiving', poPath + '/print', grnHref, '/vendors', `/vendors/${vendor.id}`, '/materials', `/materials/${material.id}`, '/production', '/production/new', prPath, prPath + '?tab=output']) {
    await visit(p); gates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-po-table],[data-entity],[data-vendors-table],[data-materials-table],[data-production-table],#receive-form,#qc-form,#create-po-form,[data-po-print],[data-grn-print]')));
  }
  ok('no procurement.read / production.read: no list, order, receipt, vendor, material or production page is served', gates.every(Boolean), gates.join());

  // ================= phone width =================
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', 'pp.root@test.local'); await fill('input[name=password]', PW); await submit('main form');
  const rootBack = await until(`location.pathname==='/dashboard'`, 20000);
  ok('super admin signs in with the password', rootBack);
  if (rootBack) {
    await b.viewport(390, 844, true);
    for (const p of ['/purchase-orders', '/purchase-orders?status=received', '/purchase-orders/new', poPath, poPath + '?tab=items', poPath + '?tab=receiving', poPath + '?tab=documents', poPath + '?tab=activity', po3Path + '?tab=receiving', grnHref,
      '/vendors', `/vendors/${vendor.id}`, `/vendors/${vendor.id}?tab=orders`, `/vendors/${vendor.id}?tab=products`, '/materials', `/materials/${material.id}`, `/materials/${material.id}?tab=details`,
      '/production', '/production/new', prPath, prPath + '?tab=materials', prPath + '?tab=output', prPath + '?tab=activity', pr3Path + '?tab=materials', pr3Path + '?tab=output']) {
      await visit(p);
      ok(`390px: no sideways page scroll: ${p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`, await noOverflow());
    }
    await visit('/purchase-orders', '!!document.querySelector("[data-po-table]")');
    ok('390px orders: each order is a card that keeps its figures, labelled', await ev(`(()=>{const r=document.querySelector('[data-po]');const box=r.getBoundingClientRect();
      return getComputedStyle(r).display !== 'table-row' && box.width <= innerWidth && [...r.querySelectorAll('td[data-label]')].every(td=>getComputedStyle(td,'::before').content.includes(td.dataset.label))})()`));
    await b.shot('p9-390-purchase-orders.png');
    await visit('/production', '!!document.querySelector("[data-production-table]")');
    ok('390px production: each order is a card that keeps its figures, labelled', await ev(`(()=>{const r=document.querySelector('[data-production]');return getComputedStyle(r).display !== 'table-row' && [...r.querySelectorAll('td[data-label]')].every(td=>getComputedStyle(td,'::before').content.includes(td.dataset.label))})()`));
    await b.shot('p9-390-production.png');
    await visit('/vendors', '!!document.querySelector("[data-drawer-open=new-vendor]")');
    await openDrawer('new-vendor', '#create-vendor-form');
    await w(500);
    ok('390px: the New vendor drawer fits the screen', await ev(`(()=>{const d=document.querySelector('[data-drawer=new-vendor]').getBoundingClientRect();return d.left >= -1 && d.right <= innerWidth + 1})()`));
    await visit(po3Path + '?tab=receiving', '!!document.querySelector("#receive-form")');
    await b.shot('p9-390-receiving.png');
    await fill(`#receive-form input[name="received:${po3Line.id}"]`, '1'); await hydrated('#receive-form');
    await ev(`window.__acObs?.disconnect(),document.querySelector('#receive-form button[type=submit]').click(),true`);
    const fits = await until(`(()=>{const d=document.querySelector('[data-confirm-dialog]');if(!d)return false;const r=d.getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1})()`, 8000);
    ok('390px: the confirmation before a delivery fits the screen', fits);
    await ev(`(document.querySelector('[data-confirm-dialog] [data-confirm-cancel]') ?? [...document.querySelectorAll('[data-confirm-dialog] button')].find(x=>!x.matches('[data-confirm-accept]')))?.click(),true`);
    await w(500);
    ok('390px: cancelling the confirmation records nothing', (await heldAt(branch.id)) === branch0 + 11);
    await visit(prPath + '?tab=output', '!!document.querySelector("[data-qc-result]")');
    await b.shot('p9-390-output.png');
    await b.viewport(1440, 900);
    await visit(poPath + '?tab=receiving', '!!document.querySelector("[data-po-receipts]")'); await b.shot('p9-receiving.png');
    await visit(prPath, '!!document.querySelector("[data-production-progress]")'); await b.shot('p9-production.png');
    await visit('/purchase-orders', '!!document.querySelector("[data-po-table]")'); await b.shot('p9-purchase-orders.png');
    await visit(`/vendors/${vendor.id}`, '!!document.querySelector("[data-entity=vendor]")'); await b.shot('p9-vendor.png');
  }

  // ================= the ledgers afterwards =================
  const after = await totals();
  ok('after: every stock still equals its ledger (products at every location, materials); nothing negative; no line received more than ordered', after.mismatch === 0 && after.material_mismatch === 0 && after.negative === 0 && after.over_received === 0, JSON.stringify(after));
  ok('after: purchasing added 11 pieces at the branch and none online; production added its 3 passed pieces online', after.located - before.located === 11 + 3 && after.online_units - before.online_units === 3, JSON.stringify({before, after}));
  ok('after: the ledgers only grew, by exactly the rows these actions wrote (3 receipts of the product + 1 output; 2 material receipts + 1 use)', after.rows - before.rows === 4 && after.material_rows - before.material_rows === 3, `${after.rows - before.rows} stock rows, ${after.material_rows - before.material_rows} material rows`);
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
