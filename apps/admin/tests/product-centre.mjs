/* Phase 5 browser tests: the product control centre (2026-10-08), against the LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs after the order fixtures and every other suite, with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin, manager = products.write without products.publish, admin = may publish, support = read-only,
   inventory = inventory_manager).
   The suite adds three fixtures of its own (one review, one production order, one product discount) and removes them
   at the end; the product's status is changed and restored; no stock is moved (the ledger is compared before/after). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'product centre e2e passphrase';
const PID = 'ky-proto-006';               // bought in the delivered fixture order KTS-TEST-0005
const TABS = ['overview', 'variants', 'pricing', 'media', 'merchandising', 'sales', 'reviews', 'production', 'activity'];
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9398);
const ev = e => b.eval(e);
const until = async (expr, ms = 10000) => {
  let last = null;
  for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; last = null; } catch (e) { last = e; } await w(100); }
  if (process.env.WAIT_TRACE) console.error(`WAIT TIMEOUT ${ms}ms: ${String(expr).slice(0, 140)}${last ? ` — throws: ${String(last.message ?? last).split(String.fromCharCode(10))[0]}` : ''}`);
  return false;
};
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ' + ${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const submit = async formSel => {
  const sel = JSON.stringify(formSel), start = await ev('location.pathname + location.search');
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel}),btn=document.querySelector(${JSON.stringify(formSel + ' button[type=submit]')});if(!btn)throw new Error('no submit button for ' + ${sel});
    window.__busySeen=false;if(f)new MutationObserver(()=>{if(f.matches('[aria-busy=true]'))window.__busySeen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});btn.click();return true})()`);
  await until(`window.__busySeen === true || !!document.querySelector(${sel})?.matches('[aria-busy=true]') || (location.pathname + location.search) !== ${JSON.stringify(start)}`, 3000);
  if (!(await until(`!document.querySelector(${sel})?.matches('[aria-busy=true]')`, 20000))) throw new Error(`submission of ${formSel} did not finish`);
};
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const attr = (sel, name) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? ''`);
const here = () => ev('location.pathname + location.search');
const allErrors = [];
const visit = async (p, ready = '!!document.querySelector("main") && !document.querySelector("[data-loading]")') => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
/** Clicks an element once React has attached its handlers. */
const click = async sel => {
  const s = JSON.stringify(sel);
  await until(`(()=>{const t=document.querySelector(${s});return !!t && Object.keys(t).some(k=>k.startsWith('__reactProps')||k.startsWith('__reactFiber'))})()`, 20000);
  await ev(`document.querySelector(${s}).click(),true`);
};
const openDrawer = async name => { await click(`[data-drawer-open=${name}]`); return until(`!!document.querySelector('[data-drawer=${name}] form')`); };
/** Ticks the first listed product and returns the choices of the bulk bar's "Set status" menu (then closes it and unticks). */
const bulkChoices = async () => {
  await click('[data-product-row] input[type=checkbox]');
  await until(`!!document.querySelector('.bulk-float button')`);
  await ev(`document.querySelector('.bulk-float button').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'})),true`);
  await until(`document.querySelectorAll('[role=menu] [role=menuitem]').length > 0`);
  const items = await ev(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(i=>i.textContent.trim()).join('|')`);
  await b.key('Escape', 'Escape', 27);
  await until(`!document.querySelector('[role=menu]')`);
  await click('[data-product-row] input[type=checkbox]');
  return items;
};
const tabsShown = () => ev(`[...document.querySelectorAll('[data-entity=product] [data-entity-tab]')].map(a=>a.dataset.entityTab).join()`);
const product = (tab, ready) => visit(`/products/${PID}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`, ready ?? `!!document.querySelector('[data-entity=product][data-tab=${tab || 'overview'}]')`);
const statusNow = async () => (await q(`select status from products where id = $1`, [PID]))[0].status;
const ledger = async () => (await q(`select (select count(*)::int from inventory_movements) rows, (select coalesce(sum(delta),0)::int from inventory_movements) delta,
  (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select coalesce(sum(qty),0)::int from location_stock) located`))[0];

async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}
/** The tabs a role should see, from its permissions in the database (a tab needs its module's read permission). */
async function expectedTabs(role) {
  const has = new Set((await q(`select rp.permission_code c from role_permissions rp join roles r on r.id = rp.role_id where r.code = $1`, [role])).map(r => r.c));
  const need = {sales: 'orders.read', reviews: 'reviews.read', production: 'production.read', activity: 'audit.read'};
  return {has, tabs: TABS.filter(t => !need[t] || has.has(need[t])).join()};
}

let reviewId = null, productionId = null, discountId = null;
try {
  await b.viewport(1440, 900);
  const before = await ledger();
  const [prod] = await q(`select id, sku, name, status, price_paise from products where id = $1`, [PID]);
  const variants = await q(`select id, sku, size, stock_qty from product_variants where product_id = $1 order by sort_order`, [PID]);
  const [line] = await q(`select i.id, o.id order_id, o.order_number, o.customer_id from order_items i join orders o on o.id = i.order_id where i.product_id = $1 and o.order_number = 'KTS-TEST-0005'`, [PID]);
  if (!prod || prod.status !== 'active' || !line) throw new Error('fixture product or order line missing');

  // ---------- fixtures of this suite (removed in the finally block) ----------
  await q(`delete from reviews where order_item_id = $1`, [line.id]);
  reviewId = (await q(`insert into reviews (product_id, customer_id, order_item_id, rating, title, body, display_name) values ($1,$2,$3,4,'E2E fits well','Good cloth, true to size.','Ravi F.') returning id`, [PID, line.customer_id, line.id]))[0].id;
  productionId = (await q(`insert into production_orders (number, variant_id, qty_planned) values ('PR-E2E-0001', $1, 6) returning id`, [variants[0].id]))[0].id;
  discountId = (await q(`insert into discounts (name, code, kind, value, scope, product_ids, is_active) values ('E2E product ten', 'E2EPROD10', 'percent', 1000, 'products', array[$1], true) returning id`, [PID]))[0].id;

  // ================= super admin: list, every tab, cross-module navigation =================
  ok('super admin signs in', await signIn('root', 'Centre Root'));

  // ---------- product list ----------
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  const [{n: total}] = await q(`select count(*)::int n from products`);
  ok('list: views are All · Published · Draft · Pending approval · Archived', (await ev(`[...document.querySelectorAll('[data-workspace=products] [data-views] [data-view]')].map(a=>a.dataset.view+':'+a.textContent.trim()).join('|')`)) === 'all:All products|active:Published|draft:Draft|review:Pending approval|archived:Archived');
  const [{n: lowActive}] = await q(`select count(*)::int n from products p where p.status = 'active' and exists (select 1 from v_inventory_status s where s.product_id = p.id and s.is_active and s.stock_status <> 'in_stock')`);
  ok('list: every product is listed; a next step is shown only where there is one (published products low on stock)', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === total && (await ev(`document.querySelectorAll('[data-product-row] [data-next-step]').length`)) === lowActive
    && (await ev(`[...document.querySelectorAll('[data-product-row] [data-next-step]')].every(a=>a.dataset.nextStep==='stock' && /tab=variants$/.test(a.getAttribute('href')))`)), `${total} rows, ${lowActive} with a step`);
  ok('list: the badge of a published product reads Published (the stored status is still active)', (await text(`[data-product-row="${PID}"] .badge.active`)).trim() === 'Published' && prod.status === 'active');
  ok('list: a row says product, status, price and stock', await ev(`(()=>{const r=document.querySelector('[data-product-row="${PID}"]');return !!r && /${prod.sku}/.test(r.innerText) && /₹/.test(r.innerText) && /sizes/.test(r.innerText) && !!r.querySelector('.badge, [class*=pill]')})()`));
  await visit('/products?status=review', '!!document.querySelector("[data-products-table],[data-empty]")');
  ok('list: Pending approval shows only products waiting (none now → empty state)', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === 0 && (await exists('[data-empty=products]')));
  await visit(`/products?q=${encodeURIComponent(prod.sku)}`, '!!document.querySelector("[data-products-table]")');
  ok('list: search by SKU finds the product', (await ev(`[...document.querySelectorAll('[data-product-row]')].map(r=>r.dataset.productRow).join()`)) === PID);
  await visit('/products?stock=in_stock', '!!document.querySelector("[data-products-table],[data-empty]")');
  const [{n: inStock}] = await q(`select count(*)::int n from products p where exists (select 1 from product_variants v where v.product_id = p.id and v.is_active and v.stock_qty > 0)`);
  ok('list: availability filter matches the database', (await ev(`document.querySelectorAll('[data-product-row]').length`)) === inStock, String(inStock));
  await visit('/products', '!!document.querySelector("[data-products-table]")');
  const prices = () => ev(`[...document.querySelectorAll('[data-product-row] [data-price]')].map(e=>Number(e.innerText.replace(/[^0-9.]/g,'')))`);
  await ev(`[...document.querySelectorAll('[data-products-table] thead .sort-btn')].find(x=>/Price/.test(x.textContent)).click(),true`);
  await until(`!!document.querySelector('[data-products-table] th[aria-sort]')`);
  const sorted = await prices();
  const dir = await attr('[data-products-table] th[aria-sort]', 'aria-sort');   // a number column sorts highest first on the first click
  ok('list: sorting by price orders the rows', sorted.length === total && sorted.every((v, i) => i === 0 || (dir === 'ascending' ? sorted[i - 1] <= v : sorted[i - 1] >= v)), `${dir}: ${sorted.slice(0, 4).join()}`);
  ok('list → product: the row opens the product page', (await attr(`[data-product-row="${PID}"] a.row-link`, 'href')) === `/products/${PID}`);
  await click(`[data-product-row="${PID}"] a.row-link`);
  ok('list → product: lands on the product control centre', await until(`location.pathname === '/products/${PID}' && !!document.querySelector('[data-entity=product][data-tab=overview]')`, 20000));

  // ---------- header + Overview ----------
  ok('product page: tabs Overview · Variants & Stock · Pricing · Media · Merchandising · Sales · Reviews · Production · Activity', (await tabsShown()) === TABS.join(), await tabsShown());
  const head = await text('[data-entity=product] .ent-head');
  ok('header: name, status, SKU, category, price and stock', head.includes(prod.name) && head.includes(prod.sku) && /₹/.test(await text('[data-fact=price]')) && /units in \d+ sizes/.test(await text('[data-fact=stock]')) && (await exists('.ent-status .badge')) && (await exists('.ent-media img')), head.replace(/\s+/g, ' ').slice(0, 120));
  ok('header and Status section: the badge reads Published', (await text('.ent-status .badge.active')).trim() === 'Published' && (await text('[data-section=status] .badge.active')).trim() === 'Published');
  ok('header: published product has no status action; rare actions are under More', (await exists('[data-product-actions=active] [data-more-menu]')) && !(await exists('[data-product-actions] form')));
  ok('overview: summary sections, no form on the page until a drawer is opened', (await exists('[data-section=details]')) && (await exists('[data-section=status]')) && (await exists('[data-section=summary]')) && (await exists('[data-section=recent]'))
    && (await ev(`document.querySelectorAll('[data-tab-panel=overview] form').length`)) === 0);
  ok('overview: needs attention names the review waiting for moderation', /1 review is waiting/.test(await text('[data-warning=reviews]')) && (await attr('[data-warning=reviews] a', 'href')) === `/products/${PID}?tab=reviews`);
  const sum = async (f, t) => (await attr(`[data-fact=sum-${f}] a`, 'href')) === `/products/${PID}?tab=${t}`;
  ok('overview: each summary line opens its tab', (await sum('price', 'pricing')) && (await sum('stock', 'variants')) && (await sum('merch', 'merchandising')) && (await sum('sales', 'sales')) && (await sum('reviews', 'reviews')) && (await sum('production', 'production')));
  const [{units: soldUnits}] = await q(`select coalesce(sum(i.qty),0)::int units from order_items i join orders o on o.id = i.order_id where i.product_id = $1 and o.status in ('paid','processing','shipped','delivered')`, [PID]);
  ok('overview: sales summary is the paid-order figure', new RegExp(`^${soldUnits} units? sold`).test(await text('[data-fact=sum-sales]')), await text('[data-fact=sum-sales]'));
  ok('overview: production summary counts the planned order', /1 planned or in progress of 1/.test(await text('[data-fact=sum-production]')), await text('[data-fact=sum-production]'));
  await b.shot('product-centre-overview.png', true);
  ok('overview: details drawer holds the product form', (await openDrawer('details')) && (await exists('[data-drawer=details] #details-form [name=name]')) && (await exists('#details-form [name=categoryId]')) && (await exists('#details-form [name=seoTitle]')));

  // ---------- tabs live in the address; Back / Forward ----------
  await product('overview');
  await click('[data-entity-tab=variants]');
  ok('tab click: the address carries the tab, the header stays', (await until(`location.search === '?tab=variants' && !!document.querySelector('[data-tab-panel=variants] [data-variants-table]')`, 20000)) && (await text('[data-entity=product] h1')).includes(prod.name));
  await click('[data-entity-tab=pricing]');
  await until(`location.search === '?tab=pricing' && !!document.querySelector('[data-tab-panel=pricing]')`, 20000);
  await ev('history.back(),true');
  const backOk = await until(`location.search === '?tab=variants' && !!document.querySelector('[data-tab-panel=variants] [data-variants-table]')`, 20000);
  await ev('history.forward(),true');
  ok('browser Back and Forward move between the tabs', backOk && (await until(`location.search === '?tab=pricing' && !!document.querySelector('[data-tab-panel=pricing] [data-section=price]')`, 20000)));

  // ---------- Variants & Stock ↔ Inventory (one ledger) ----------
  await product('variants', '!!document.querySelector("[data-variants-table]")');
  const shownQty = await ev(`[...document.querySelectorAll('[data-variant]')].map(r=>r.dataset.variant+'='+r.querySelector('[data-qty]').innerText).join()`);
  ok('variants: every size with its SKU and the stock the database holds', shownQty === variants.map(v => `${v.sku}=${v.stock_qty}`).join(), shownQty);
  ok('variants: stock actions and the ledger rows are on the tab', (await exists('[data-stock-forms]')) && (await exists('[data-section=movements]')) && (await exists('[data-section=sizes]')));
  ok('product → Inventory: the link opens Inventory → Stock for this product', (await attr('[data-link=inventory]', 'href')) === `/inventory?q=${PID}`);
  await click('[data-link=inventory]');
  await until(`location.pathname === '/inventory' && !!document.querySelector('[data-stock-table]')`, 20000);
  const invQty = await ev(`[...document.querySelectorAll('[data-stock-row]')].map(r=>r.dataset.stockRow+'='+r.querySelector('[data-qty]').innerText).sort().join()`);
  ok('Inventory shows the same quantities as the product page', invQty === variants.map(v => `${v.sku}=${v.stock_qty}`).sort().join(), invQty);
  ok('Inventory → product: a row opens the product on Variants & Stock', (await attr('[data-stock-row] a.row-link', 'href')) === `/products/${PID}?tab=variants`);

  // ---------- Pricing ↔ Pricing & discounts ----------
  await product('pricing', '!!document.querySelector("#price-form")');
  ok('pricing: price, minimum, sale, size prices, scheduled changes and history', (await exists('[data-current-price]')) && (await exists('[data-section=min-price]')) && (await exists('[data-section=sale-price]')) && (await exists('[data-size-prices]')) && (await exists('[data-section=scheduled]')) && (await exists('[data-section=history]')));
  await b.shot('product-centre-pricing.png', true);
  ok('pricing: the discount that targets this product is listed, read-only', (await exists('[data-product-discounts] [data-discount=E2EPROD10]')) && /10%/.test(await text('[data-discount=E2EPROD10]')) && (await ev(`document.querySelectorAll('[data-section=discounts] form').length`)) === 0);
  ok('product → Pricing & discounts: discounts are managed there', (await attr('[data-link=discounts]', 'href')) === '/pricing/discounts');
  await click('[data-link=discounts]');
  ok('product → Pricing & discounts: lands on the discount list with the same discount', (await until(`location.pathname === '/pricing/discounts' && !!document.querySelector('[data-discounts-table] [data-discount=E2EPROD10]')`, 20000)));
  await visit(`/pricing/${PID}`, '!!document.querySelector("[data-entity=product]")');
  ok('old pricing address opens the product on its Pricing tab', (await here()) === `/products/${PID}?tab=pricing`);

  // ---------- Media ----------
  await product('media', '!!document.querySelector("[data-section=images]")');
  ok('media: images with the primary one marked, and the existing upload form', (await exists('[data-image][data-primary]')) && (await exists('#upload-image-form')) && (await exists('[data-image-tools]')));

  // ---------- Merchandising ↔ Catalogue setup ----------
  await product('merchandising', '!!document.querySelector("[data-section=collections]")');
  ok('merchandising: category, collections, New Arrivals, store filters, size chart, complete the look', (await exists('[data-section=category]')) && (await exists('[data-section=new-arrivals]')) && (await exists('[data-section=attributes]')) && (await exists('[data-section=size-chart]')) && (await exists('[data-section=related]')));
  const setup = await ev(`[...document.querySelectorAll('[data-link=catalogue-setup]')].map(a=>a.getAttribute('href')).join()`);
  ok('product → Catalogue setup: links to Categories, Collections, Attributes and Size charts', ['/categories', '/collections', '/attributes', '/size-charts'].every(h => setup.split(',').includes(h)), setup);
  ok('merchandising: the category is changed with the product details form', (await openDrawer('details')) && (await exists('[data-drawer=details] #details-form [name=categoryId]')));
  await product('merchandising', '!!document.querySelector("[data-section=category]")');
  await click('[data-section=category] [data-link=catalogue-setup]');
  ok('product → Catalogue setup: lands on Categories', await until(`location.pathname === '/categories' && !!document.querySelector('[data-categories-table]')`, 20000));

  // ---------- Sales → Order ----------
  await product('sales', '!!document.querySelector("[data-section=sales]")');
  ok('sales: figures, by size and the orders that contain the product', (await exists('[data-figures]')) && (await exists('[data-sales-by-size]')) && (await exists('[data-product-orders]')) && (await ev(`document.querySelectorAll('[data-tab-panel=sales] form').length`)) === 0);
  ok('product → Order: a row opens the order on its Items tab', (await ev(`[...document.querySelectorAll('[data-product-orders] a.row-link')].map(a=>a.getAttribute('href')).join()`)).split(',').includes(`/orders/${line.order_id}?tab=items`));
  await click(`[data-product-orders] a.row-link[href="/orders/${line.order_id}?tab=items"]`);
  ok('product → Order: lands on the order, Items tab selected', await until(`location.pathname === '/orders/${line.order_id}' && !!document.querySelector('[data-entity=order][data-tab=items] [data-items-table]')`, 20000));
  await ev('history.back(),true');
  ok('Back from the order returns to the product Sales tab', await until(`location.pathname + location.search === '/products/${PID}?tab=sales' && !!document.querySelector('[data-product-orders]')`, 20000));

  // ---------- Reviews (the queue's own action) ----------
  await product('reviews', '!!document.querySelector("[data-section=reviews]")');
  ok('reviews: the pending review with rating, customer, date and moderation', (await exists(`[data-review-id="${reviewId}"][data-review=pending]`)) && /4\s*\/ 5/.test(await text(`[data-review-id="${reviewId}"]`)) && /Ravi F\./.test(await text(`[data-review-id="${reviewId}"]`))
    && (await exists(`[id="rv-ok-${reviewId}"]`)) && (await exists(`[id="rv-no-${reviewId}"]`)));
  await b.shot('product-centre-reviews.png', true);
  ok('product → Reviews: the link opens the moderation queue', (await attr('[data-link=reviews]', 'href')) === '/reviews?status=pending');
  await submit(`[id="rv-ok-${reviewId}"]`);
  const [rv] = await q(`select r.status, s.email from reviews r left join staff_users s on s.id = r.moderated_by where r.id = $1`, [reviewId]);
  const [{n: rvAudit}] = await q(`select count(*)::int n from audit_logs where action = 'review.approve' and entity_id = $1`, [reviewId]);
  ok('reviews: approving on the product page is the Reviews decision (one row, one audit record)', rv.status === 'approved' && rv.email === 'pc.root@test.local' && rvAudit === 1, JSON.stringify(rv) + ' audit ' + rvAudit);
  ok('reviews: the tab shows the new state and rating', await until(`!!document.querySelector('[data-review-id="${reviewId}"][data-review=approved]') && /4 \\/ 5/.test(document.querySelector('[data-figures]').innerText)`, 15000));
  await visit('/reviews?status=approved', '!!document.querySelector("[data-reviews]")');
  ok('Reviews queue shows the same review as approved, linking back to the product Reviews tab', (await exists(`[data-review="${reviewId}"][data-status=approved]`)) && (await attr(`[data-review="${reviewId}"] .review-head a`, 'href')) === `/products/${PID}?tab=reviews`);

  // ---------- Production → Production order ----------
  await product('production', '!!document.querySelector("[data-section=production]")');
  ok('production: the product\'s production order with size, quantity and state', /PR-E2E-0001/.test(await text('[data-product-production]')) && /planned/i.test(await text('[data-product-production]')) && (await ev(`document.querySelectorAll('[data-tab-panel=production] form').length`)) === 0);
  ok('product → Production: a row opens the production order', (await attr('[data-product-production] a.row-link', 'href')) === `/production/${productionId}`);
  await click('[data-product-production] a.row-link');
  ok('product → Production: lands on the production order', await until(`location.pathname === '/production/${productionId}' && /PR-E2E-0001/.test(document.querySelector('main').innerText)`, 20000));
  ok('production order links back to the product Production tab', await exists(`a[href="/products/${PID}?tab=production"]`));

  // ---------- status: draft (the existing rule: only an admin publishes) ----------
  await product('overview');
  await openDrawer('status');
  await autoConfirm();
  await fill('#status-form [name=status]', 'draft'); await submit('#status-form');
  ok('status: moved to draft through the existing status form (with its confirmation)', (await statusNow()) === 'draft' && /hides this product/.test((await ev('window.__q ?? []'))[0] ?? ''));
  await product('overview', '!!document.querySelector("[data-product-actions=draft]")');
  ok('draft: the header offers Publish to someone who may publish', (await exists('[data-product-actions=draft] #quick-active-form')) && !(await exists('#quick-review-form')));
  await visit('/products?status=draft', '!!document.querySelector("[data-products-table]")');
  await b.shot('product-centre-list.png');
  ok('list: Draft view shows it with the next step "Finish draft"', (await ev(`[...document.querySelectorAll('[data-product-row]')].map(r=>r.dataset.productRow).join()`)) === PID && (await attr(`[data-product-row="${PID}"] [data-next-step]`, 'data-next-step')) === 'finish');

  // ---------- Activity ----------
  await product('activity', '!!document.querySelector("[data-section=activity]")');
  const acts = await ev(`[...document.querySelectorAll('[data-product-activity] li')].map(l=>l.dataset.action)`);
  ok('activity: the status change and the review decision, each once, newest first', acts[0] === 'product.status_update' && acts.filter(a => a === 'review.approve').length === 1 && acts.filter(a => a === 'product.status_update').length === 1, acts.join());
  ok('activity: says who did it and what changed', /pc\.root@test\.local/.test(await text('[data-product-activity] li')) && /status: active → draft/.test(await text('[data-product-activity] li')), (await text('[data-product-activity] li')).replace(/\s+/g, ' '));

  // ---------- the wording is the product's only ----------
  await visit('/staff', '!!document.querySelector("main .badge.active")');
  ok('other records keep "Active" (staff list)', (await text('main .badge.active')).trim() === 'Active');

  // ---------- Locations → product ----------
  const [loc] = await q(`select s.location_id from location_stock s join product_variants v on v.id = s.variant_id group by s.location_id order by count(*) desc limit 1`);
  if (loc) {
    await visit(`/locations/${loc.location_id}`, '!!document.querySelector("[data-section=location-stock]")');
    const locLinks = await ev(`[...document.querySelectorAll('[data-location-stock] a[href^="/products/"]')].map(a=>a.getAttribute('href'))`);
    ok('Locations → product: stock rows open the product on Variants & Stock', locLinks.length > 0 && locLinks.every(h => h.startsWith('/products/') && h.endsWith('?tab=variants')), `${locLinks.length} links, e.g. ${locLinks[0]}`);
    if (locLinks.length) {
      await click('[data-location-stock] a[href^="/products/"]');
      ok('Locations → product: lands on the Variants & Stock tab', await until(`location.pathname.startsWith('/products/') && location.search === '?tab=variants' && !!document.querySelector('[data-entity=product][data-tab=variants] [data-variants-table]')`, 20000));
    }
  } else ok('Locations → product: stock rows open the product on Variants & Stock', false, 'no location holds stock in this database');

  // ---------- not found ----------
  await visit('/products/ky-none-999');
  ok('unknown product: a not-found page, no product frame', !(await exists('[data-entity=product]')) && /not found|could not be found|404/i.test(await text('main')), (await text('main')).replace(/\s+/g, ' ').slice(0, 80));
  await product('nonsense', '!!document.querySelector("[data-entity=product]")');
  ok('unknown tab: falls back to Overview', await exists('[data-entity=product][data-tab=overview]'));

  // ================= manager: may edit, may NOT publish =================
  ok('manager signs in', await signIn('manager', 'Centre Manager'));
  const mgr = await expectedTabs('manager');
  await product('overview', '!!document.querySelector("[data-product-actions=draft]")');
  ok('manager: sees the tabs of the modules they may read', (await tabsShown()) === mgr.tabs, await tabsShown());
  ok('manager (no products.publish): the main action is Submit for approval, never Publish', !mgr.has.has('products.publish') && (await exists('#quick-review-form')) && !(await exists('#quick-active-form')));
  await openDrawer('status');
  ok('manager: the status form does not offer Published', (await ev(`[...document.querySelectorAll('#status-form [name=status] option')].map(o=>o.value).join()`)) === 'review,draft,archived');
  await product('overview', '!!document.querySelector("#quick-review-form")');
  await submit('#quick-review-form');
  const [sub] = await q(`select p.status, s.email from products p left join staff_users s on s.id = p.submitted_by where p.id = $1`, [PID]);
  ok('manager: submitting puts the product in Pending approval, still hidden from the store', sub.status === 'review' && sub.email === 'pc.manager@test.local', JSON.stringify(sub));
  await product('overview', '!!document.querySelector("[data-product-actions=review]")');
  ok('pending approval: the product header and Status badges read Pending approval', (await text('.ent-status .badge.review')).trim() === 'Pending approval' && (await text('[data-section=status] .badge.review')).trim() === 'Pending approval');
  ok('pending approval: the page says so and offers the manager nothing to publish with', (await exists('[data-warning=approval]')) && (await ev(`document.querySelectorAll('[data-product-actions] form').length`)) === 0);
  await visit('/products?status=review', '!!document.querySelector("[data-products-table]")');
  ok('list: Pending approval lists exactly the submitted product; the manager can only view it', (await ev(`[...document.querySelectorAll('[data-product-row]')].map(r=>r.dataset.productRow).join()`)) === PID && !(await exists(`[data-product-row="${PID}"] [data-next-step]`)));
  const mgrBulk = await bulkChoices();
  ok('bulk status, manager (no products.publish): Draft and Archived only, Published is not offered', /Draft/.test(mgrBulk) && /Archived/.test(mgrBulk) && !/Published|Active/.test(mgrBulk), mgrBulk);
  await product('pricing', '!!document.querySelector("[data-section=price]")');
  ok('manager: may change the price (products.write) and sees the discounts', (await exists('#price-form')) && (await exists('[data-section=discounts]')));

  // ================= admin: approves =================
  ok('admin signs in', await signIn('admin', 'Centre Admin'));
  await visit('/products?status=review', '!!document.querySelector("[data-products-table]")');
  ok('admin: the pending product\'s next step is Review & publish', (await attr(`[data-product-row="${PID}"] [data-next-step]`, 'data-next-step')) === 'approve');
  const admBulk = await bulkChoices();
  ok('bulk status, admin (products.publish): Published, Draft and Archived', /Published/.test(admBulk) && /Draft/.test(admBulk) && /Archived/.test(admBulk), admBulk);
  ok('the badge of the pending product reads Pending approval, like its view', (await text(`[data-product-row="${PID}"] .badge.review`)).trim() === 'Pending approval');
  await click(`[data-product-row="${PID}"] [data-next-step]`);
  await until(`location.pathname === '/products/${PID}' && !!document.querySelector('[data-product-actions=review] #quick-active-form')`, 20000);
  await submit('#quick-active-form');
  const [pub] = await q(`select p.status, s.email from products p left join staff_users s on s.id = p.approved_by where p.id = $1`, [PID]);
  ok('admin: Publish approves it (published, approver recorded)', pub.status === 'active' && pub.email === 'pc.admin@test.local', JSON.stringify(pub));
  ok('published: the header follows the state', await until(`!!document.querySelector('[data-product-actions=active]') && !document.querySelector('[data-product-actions] form')`, 15000));

  // ================= support: read-only =================
  ok('support signs in', await signIn('support', 'Centre Support'));
  const sup = await expectedTabs('support');
  await product('overview');
  ok('support: sees the tabs of the modules they may read only', (await tabsShown()) === sup.tabs, await tabsShown());
  ok('support: information without actions (no drawers, no status action, read-only notes)', !(await exists('[data-drawer-open]')) && (await ev(`document.querySelectorAll('[data-entity=product] form').length`)) === 0 && (await exists('[data-readonly=status]')) && (await exists('[data-readonly=details]')));
  await product('pricing', '!!document.querySelector("[data-section=price]")');
  ok('support: sees the price, cannot change it; discounts need pricing.read', (await exists('[data-current-price]')) && !(await exists('#price-form')) && (await exists('[data-readonly=price]')) && (await exists('[data-section=discounts]')) === sup.has.has('pricing.read'));
  await product('variants', '!!document.querySelector("[data-section=stock]")');
  ok('support: sees stock, cannot adjust it or change sizes', (await exists('[data-variants-table]')) && !(await exists('[data-stock-forms]')) && !(await exists('[data-section=sizes]')) && (await exists('[data-readonly=stock]')));
  await product('media', '!!document.querySelector("[data-section=images]")');
  const supMedia = (await exists('[data-image]')) && !(await exists('#upload-image-form')) && !(await exists('[data-image-tools]'));
  await product('merchandising', '!!document.querySelector("[data-section=collections]")');
  ok('support: media and merchandising are shown without controls', supMedia && (await ev(`document.querySelectorAll('[data-tab-panel=merchandising] form').length`)) === 0 && !(await exists('[data-drawer-open]')));
  if (sup.has.has('reviews.read')) {
    await product('reviews', '!!document.querySelector("[data-section=reviews]")');
    ok('support: moderation is offered only with reviews.moderate', (await exists(`[id="rv-no-${reviewId}"]`)) === sup.has.has('reviews.moderate'));
  }
  for (const t of ['production', 'activity'].filter(t => !sup.tabs.split(',').includes(t))) {
    await product(t, '!!document.querySelector("[data-entity=product]")');
    ok(`support: ?tab=${t} is not served without its permission (Overview instead)`, (await exists('[data-entity=product][data-tab=overview]')) && !(await exists('[data-product-production],[data-product-activity]')));
  }

  // ================= inventory manager: stock yes, sales / reviews no =================
  ok('inventory manager signs in', await signIn('inventory', 'Centre Inventory'));
  const inv = await expectedTabs('inventory_manager');
  await product('overview');
  ok('inventory manager: sees the tabs of the modules they may read only', (await tabsShown()) === inv.tabs && !inv.tabs.includes('sales'), await tabsShown());
  ok('inventory manager: Overview shows no sales or review figures', !(await exists('[data-fact=sum-sales]')) && !(await exists('[data-fact=sum-reviews]')) && (await exists('[data-fact=sum-stock]')));
  await product('sales', '!!document.querySelector("[data-entity=product]")');
  ok('inventory manager: ?tab=sales is not served (Overview instead)', (await exists('[data-entity=product][data-tab=overview]')) && !(await exists('[data-product-orders]')));
  await product('variants', '!!document.querySelector("[data-section=stock]")');
  ok('inventory manager: may adjust stock, not sizes', (await exists('[data-stock-forms]')) && !(await exists('[data-section=sizes]')));

  // ================= phone width =================
  await b.viewport(390, 844, true);
  for (const t of inv.tabs.split(',')) {
    await product(t);
    ok(`390px, inventory manager, ${t}: no sideways page scroll`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  }
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', 'pc.manager@test.local'); await fill('input[name=password]', PW); await submit('main form');
  const mgrBack = await until(`location.pathname==='/dashboard'`, 20000);
  ok('manager signs in with the password', mgrBack, await here());
  if (mgrBack) {
    await b.viewport(390, 844, true);
    for (const p of ['/products', '/products?status=review', ...TABS.map(t => `/products/${PID}${t === 'overview' ? '' : `?tab=${t}`}`)]) {
      await visit(p);
      ok(`390px: no sideways page scroll: ${p}`, await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
    }
    await product('variants', '!!document.querySelector("[data-variants-table]")');
    ok('390px: all nine tabs are there and the row scrolls inside itself', (await tabsShown()) === TABS.join() && (await ev(`(()=>{const n=document.querySelector('.ent-tabs');return n.scrollWidth > n.clientWidth && n.getBoundingClientRect().right <= innerWidth + 1})()`)));
    ok('390px: wide tables scroll inside their own frame, every column kept', await ev(`[...document.querySelectorAll('[data-tab-panel] .table-wrap')].every(x=>x.getBoundingClientRect().right <= innerWidth + 1) && document.querySelectorAll('[data-variants-table] thead th').length === 8`));
    await ev(`document.querySelector('[data-entity-tab=activity]').scrollIntoView({inline:'center'}),true`);
    await click('[data-entity-tab=activity]');
    ok('390px: the last tab can be reached and opened', await until(`location.search === '?tab=activity' && !!document.querySelector('[data-tab-panel=activity]')`, 20000));
    await product('overview');
    ok('390px: the header keeps the name, status, facts and actions', (await text('[data-entity=product] h1')).includes(prod.name) && (await exists('[data-fact=price]')) && (await exists('[data-fact=stock]')) && (await exists('[data-more-menu]')));
    await b.shot('product-centre-390.png', true);
  }

  // ================= nothing moved =================
  const after = await ledger();
  ok('stock ledger unchanged by the whole run (rows, sum, stock, location stock)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({before, after}));
  const [{n: mismatch}] = await q(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online)))`);
  ok('stock still equals the sum of its ledger rows for every size', mismatch === 0, String(mismatch));
  ok('product is published again, at its original price', (await statusNow()) === 'active' && (await q(`select price_paise from products where id = $1`, [PID]))[0].price_paise === prod.price_paise);
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally {
  b.close();
  try {
    if (reviewId) await q(`delete from reviews where id = $1`, [reviewId]);
    if (productionId) await q(`delete from production_orders where id = $1`, [productionId]);
    if (discountId) await q(`delete from discounts where id = $1`, [discountId]);
    await q(`update products set status = 'active' where id = $1 and status <> 'active'`, [PID]);
  } catch (e) { ok('fixtures removed', false, String(e.message)); }
  await pool.end();
}

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
