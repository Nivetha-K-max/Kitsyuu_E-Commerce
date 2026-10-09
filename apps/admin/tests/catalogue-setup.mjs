/* Phase 7 browser tests: Catalogue setup on the shared frame (2026-10-08), against the LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs after every other suite, with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin, inventory = inventory_manager: categories.read without categories.write, support = no categories.read).
   Creates one category ("e2e-cs", left inactive) and one collection group; assigns and un-assigns a size chart; adds and
   removes one collection member. Moves no stock (the ledger is compared before / after). */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'catalogue setup e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9405);
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
const message = formSel => ev(`document.querySelector(${JSON.stringify(formSel + ' [data-form-message]')})?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const attr = (sel, name) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? ''`);
const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const here = () => ev('location.pathname + location.search');
const allErrors = [];
const READY = '!!document.querySelector("main") && !document.querySelector("[data-loading]")';
const visit = async (p, ready = READY) => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const click = async sel => {
  const s = JSON.stringify(sel);
  await until(`(()=>{const t=document.querySelector(${s});return !!t && Object.keys(t).some(k=>k.startsWith('__reactProps')||k.startsWith('__reactFiber'))})()`, 20000);
  await ev(`document.querySelector(${s}).click(),true`);
};
const openDrawer = async name => { await click(`[data-drawer-open=${name}]`); return until(`!!document.querySelector('[data-drawer=${name}] form')`); };
const noOverflow = () => ev('document.documentElement.scrollWidth <= innerWidth + 1');
const ledger = async () => (await q(`select (select count(*)::int from inventory_movements) rows, (select coalesce(sum(delta),0)::int from inventory_movements) delta, (select coalesce(sum(stock_qty),0)::int from product_variants) units`))[0];
const VIEWS = '/categories|/collections|/attributes|/size-charts';
const moduleViews = () => ev(`[...document.querySelectorAll('[data-module-views=catalogue] [data-view]')].map(a=>a.dataset.view).join('|')`);

async function signIn(key, name) {
  await b.send('Network.clearBrowserCookies');
  const link = fs.readFileSync(INVITES[key], 'utf8').match(/accept-invite\?token=[A-Za-z0-9_-]{43}/)[0];
  await visit('/' + link, '!!document.querySelector("input[name=password]")');
  await fill('main input[name=fullName]', name); await fill('main input[name=password]', PW); await fill('main input[name=confirm]', PW);
  await submit('main form');
  return until(`location.pathname==='/dashboard'`);
}

let chartFix = null;
try {
  await b.viewport(1440, 900);
  const before = await ledger();
  const statusBefore = await q(`select id, status from products order by id`);

  // ================= super admin =================
  ok('super admin signs in', await signIn('root', 'Setup Root'));

  // ---------- Categories ----------
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  const [{n: catTotal}] = await q(`select count(*)::int n from categories`);
  ok('categories: on the workspace frame with the four Catalogue setup views', (await exists('[data-workspace=categories] h1')) && (await moduleViews()) === VIEWS && (await attr('[data-module-views=catalogue] [aria-current=page]', 'data-view')) === '/categories', await moduleViews());
  ok('categories: every category is listed, subcategories under their parent', (await count('[data-category-row]')) === catTotal && (await count('tr.cat-child')) === (await q(`select count(*)::int n from categories where parent_id is not null`))[0].n, String(catTotal));
  const [tops] = await q(`select (select count(*)::int from products p where p.category_id = 'tops' or p.subcategory_id = 'tops') total, (select count(*)::int from products p where (p.category_id = 'tops' or p.subcategory_id = 'tops') and p.status = 'active') published`);
  ok('categories: a row shows published products (and all) for the category', new RegExp(`^${tops.published}\\s+${tops.total} in all`).test((await text('[data-category-row=tops] [data-category-products]')).trim()), await text('[data-category-row=tops] [data-category-products]'));
  ok('categories → Products: the count opens Products filtered by the category', (await attr('[data-category-row=tops] [data-link=category-products]', 'href')) === '/products?category=tops');
  await click('[data-category-row=tops] [data-link=category-products]');
  ok('categories → Products: lands on the product list with exactly those products', (await until(`location.pathname === '/products' && location.search === '?category=tops' && !!document.querySelector('[data-products-table]')`, 20000))
    && (await count('[data-product-row]')) === tops.total && /Category/.test(await text('[data-product-filters]')));
  await ev('history.back(),true');
  ok('Back returns to Categories', await until(`location.pathname === '/categories' && !!document.querySelector('[data-categories-table]')`, 20000));
  await visit('/categories?q=jeans', '!!document.querySelector("[data-categories-table],[data-empty]")');
  ok('categories: search keeps the matching subcategory and its parent', (await ev(`[...document.querySelectorAll('[data-category-row]')].map(r=>r.dataset.categoryRow).join()`)) === 'bottoms,bottoms.jeans', await ev(`[...document.querySelectorAll('[data-category-row]')].map(r=>r.dataset.categoryRow).join()`));
  ok('categories: reordering is offered only on the whole list', !(await exists('[id^=cat-up-],[id^=cat-down-]')) && (await exists('[data-clear-filters]')));
  await visit('/categories?q=zzzz-none', '!!document.querySelector("[data-empty]")');
  ok('categories: a search with no match shows the empty state', (await exists('[data-state=empty][data-empty=categories]')) && /No matching categories/.test(await text('[data-state=empty]')));
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  ok('categories: creating is in a drawer (no form on the page until it is opened)', !(await exists('#create-category-form')) && (await openDrawer('new-category')) && (await exists('[data-drawer=new-category] #create-category-form [name=slug]')));
  await q(`delete from categories where id = 'e2e-cs' and not exists (select 1 from products where category_id = 'e2e-cs')`);
  await fill('#create-category-form [name=slug]', 'e2e-cs'); await fill('#create-category-form [name=label]', 'E2E Setup'); await submit('#create-category-form');
  ok('categories: created through the existing action, audited', /e2e-cs created/.test(await message('#create-category-form')) && (await q(`select count(*)::int n from audit_logs where action = 'category.create' and entity_id = 'e2e-cs'`))[0].n === 1, await message('#create-category-form'));
  await visit('/categories', '!!document.querySelector("[data-category-row=e2e-cs]")');
  ok('categories: an unused category has no product link (nothing to open)', !(await exists('[data-category-row=e2e-cs] [data-link=category-products]')) && /^0/.test((await text('[data-category-row=e2e-cs] [data-category-products]')).trim()));
  await autoConfirm();
  await submit('[id="cat-active-e2e-cs"]');
  ok('categories: deactivated with the existing confirmation', (await q(`select is_active from categories where id = 'e2e-cs'`))[0].is_active === false && /hidden from the store/i.test((await ev('window.__q ?? []'))[0] ?? ''));
  await visit('/categories?status=inactive', '!!document.querySelector("[data-categories-table]")');
  const [{n: inactiveCats}] = await q(`select count(*)::int n from categories where not is_active`);
  ok('categories: the Inactive filter lists the inactive ones', (await count('[data-category-row][data-active=no]')) === inactiveCats && (await exists('[data-category-row=e2e-cs]')), String(inactiveCats));
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  await autoConfirm(); await submit('[id="cat-active-tops"]');
  ok('categories: deactivating one with published products is refused, with the reason', (await q(`select is_active from categories where id = 'tops'`))[0].is_active === true && /active|product|subcategor/i.test(await message('[id="cat-active-tops"]')), await message('[id="cat-active-tops"]'));
  await b.shot('catalogue-setup-categories.png', true);

  // ---------- Collections ----------
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  const colls = await q(`select c.id, c.label, c.is_active, c.group_id, (select count(*)::int from collection_products x where x.collection_id = c.id) n from collections c order by c.sort_order, c.id`);
  const groups = await q(`select id, label from collection_groups order by sort_order, id`).catch(() => []);
  ok('collections: on the workspace frame; one row per collection (a list, not cards)', (await exists('[data-workspace=collections]')) && (await moduleViews()) === VIEWS && (await count('[data-collection]')) === colls.length && !(await exists('.col-card')), String(colls.length));
  ok('collections: group views are All + the groups', (await ev(`[...document.querySelectorAll('[data-group-tabs] [data-view]')].map(a=>a.dataset.view).join()`)).startsWith(['all', ...groups.map(g => g.id)].join()), await ev(`[...document.querySelectorAll('[data-group-tabs] [data-view]')].map(a=>a.dataset.view).join()`));
  const withMembers = colls.find(c => c.n > 0), emptyColl = colls.find(c => c.n === 0);
  ok('collections: a row shows the product count and whether the store shows it', new RegExp(`^${withMembers.n}`).test((await text(`[data-collection="${withMembers.id}"] [data-collection-counts]`)).trim()) && /in store|hidden/i.test(await text(`[data-collection="${withMembers.id}"]`)));
  ok('collections → Products: the count opens Products filtered by the collection', (await attr(`[data-collection="${withMembers.id}"] [data-view-products]`, 'href')) === `/products?collection=${withMembers.id}`
    && (!emptyColl || !(await exists(`[data-collection="${emptyColl.id}"] [data-view-products]`))));
  await click(`[data-collection="${withMembers.id}"] [data-view-products]`);
  ok('collections → Products: lands on exactly its products', (await until(`location.pathname === '/products' && location.search === '?collection=${withMembers.id}' && !!document.querySelector('[data-products-table]')`, 20000)) && (await count('[data-product-row]')) === withMembers.n);
  const grouped = colls.find(c => c.group_id);
  if (grouped) {
    await visit('/collections', '!!document.querySelector("[data-collections-table]")');
    await click(`[data-group-tabs] [data-view="${grouped.group_id}"]`);
    ok('collections: a group view shows only that group and lives in the address', (await until(`location.search === '?group=${grouped.group_id}' && document.querySelectorAll('[data-collections-table] tbody[data-group]').length === 1`, 20000))
      && (await count('[data-collection]')) === colls.filter(c => c.group_id === grouped.group_id).length);
    await ev('history.back(),true');
    const backAll = await until(`location.search === '' && document.querySelectorAll('[data-collection]').length === ${colls.length}`, 20000);
    await ev('history.forward(),true');
    ok('collections: Back and Forward move between the group views', backAll && (await until(`location.search === '?group=${grouped.group_id}'`, 20000)));
  }
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  ok('collections: New collection and New group are drawers', !(await exists('#create-collection-form')) && (await openDrawer('new-collection')) && (await exists('#create-collection-form [name=label]')));
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  await openDrawer('new-group');
  const groupName = `E2E Setup ${Date.now() % 100000}`;
  await fill('#create-group-form [name=label]', groupName); await submit('#create-group-form');
  ok('collections: a group is added through the existing action', /added/i.test(await message('#create-group-form')) && (await q(`select count(*)::int n from collection_groups where label = $1`, [groupName]))[0].n === 1, await message('#create-group-form'));
  await b.shot('catalogue-setup-collections.png', true);

  // ---------- one collection (entity frame) ----------
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  await click(`[data-collection="${withMembers.id}"] a.row-link`);
  ok('collection: the row opens it on the entity frame', await until(`location.pathname === '/collections/${withMembers.id}' && !!document.querySelector('[data-entity=collection][data-tab=products]')`, 20000));
  ok('collection: header with name, store status, link, group, product count and the one visibility action', (await text('[data-entity=collection] h1')).includes(withMembers.label) && (await exists('[data-collection-status]'))
    && (await text('[data-collection-facts]')).includes(`/shop?collection=${withMembers.id}`) && new RegExp(`^${withMembers.n}`).test((await text('[data-fact=products]')).trim()) && (await count('[data-collection-actions] form')) === 1);
  ok('collection: tabs Products · Details', (await ev(`[...document.querySelectorAll('[data-entity=collection] [data-entity-tab]')].map(a=>a.dataset.entityTab).join()`)) === 'products,details');
  const members = await q(`select p.id, p.sku, p.status from collection_products m join products p on p.id = m.product_id where m.collection_id = $1 order by m.position, p.id`, [withMembers.id]);
  ok('collection: its products in store order, each opening the product on Merchandising', (await ev(`[...document.querySelectorAll('[data-member]')].map(r=>r.dataset.member).join()`)) === members.map(m => m.sku).join()
    && (await ev(`[...document.querySelectorAll('[data-member] a.row-link')].map(a=>a.getAttribute('href')).join()`)) === members.map(m => `/products/${m.id}?tab=merchandising`).join());
  ok('collection: a published product reads Published (the product wording)', members[0].status !== 'active' || (await text('[data-member] .badge.active')).trim() === 'Published');
  await click('[data-member] a.row-link');
  ok('collection → product: lands on the product Merchandising tab, which shows the collection', (await until(`location.pathname === '/products/${members[0].id}' && location.search === '?tab=merchandising' && !!document.querySelector('[data-section=collections]')`, 20000))
    && (await text('[data-section=collections]')).includes(withMembers.label));
  ok('product → Catalogue setup: the Merchandising tab links back to Collections', await exists('[data-section=collections] [data-link=catalogue-setup][href="/collections"]'));
  await ev('history.back(),true');
  await until(`location.pathname === '/collections/${withMembers.id}' && !!document.querySelector('[data-members-table]')`, 20000);
  // add a member, then remove it again (existing actions; the collection ends as it began)
  const [cand] = await q(`select id, sku from products where status <> 'archived' and id not in (select product_id from collection_products where collection_id = $1) order by sku limit 1`, [withMembers.id]);
  await fill('#add-member-form [name=productId]', cand.id); await submit('#add-member-form');
  ok('collection: a product is added through the existing action', (await until(`!!document.querySelector('[data-member="${cand.sku}"]')`, 15000)) && (await q(`select count(*)::int n from collection_products where collection_id = $1 and product_id = $2`, [withMembers.id, cand.id]))[0].n === 1);
  await submit(`[id="mem-rm-${cand.id}"]`);
  ok('collection: and removed again', (await until(`!document.querySelector('[data-member="${cand.sku}"]')`, 15000)) && (await q(`select count(*)::int n from collection_products where collection_id = $1`, [withMembers.id]))[0].n === withMembers.n);
  await click('[data-entity-tab=details]');
  ok('collection: Details tab in the address, with the existing form; the header stays', (await until(`location.search === '?tab=details' && !!document.querySelector('[data-tab-panel=details] #collection-name-form')`, 20000)) && (await text('[data-entity=collection] h1')).includes(withMembers.label));
  await ev('history.back(),true');
  ok('collection: Back returns to the Products tab', await until(`location.search === '' && !!document.querySelector('[data-tab-panel=products]')`, 20000));
  await b.shot('catalogue-setup-collection.png', true);
  if (emptyColl) {
    await visit(`/collections/${emptyColl.id}`, '!!document.querySelector("[data-entity=collection]")');
    ok('collection without products: an empty state, and the existing rule on showing it', (await exists('[data-state=empty][data-empty=members]')) && (emptyColl.is_active || /at least one published product/.test(await text('[data-section=members]'))));
    if (!emptyColl.is_active) {
      await submit('#collection-active-form');
      ok('collection: showing an empty collection is still refused by the server', (await q(`select is_active from collections where id = $1`, [emptyColl.id]))[0].is_active === false, await message('#collection-active-form'));
    }
  }
  await visit('/collections/no-such-collection');
  ok('unknown collection: the not-found page', !(await exists('[data-entity=collection]')) && /not found|404/i.test(await text('main')));

  // ---------- Attributes ----------
  await visit('/attributes', '!!document.querySelector("[data-workspace=attributes]")');
  const attrs = await q(`select id, label from attributes order by sort_order, id`);
  ok('attributes: on the workspace frame; every attribute with its values', (await moduleViews()) === VIEWS && (await count('[data-attribute]')) === attrs.length && (await exists('[data-attribute-filters]')), String(attrs.length));
  ok('attributes: creating is in a drawer', !(await exists('#create-attribute-form')) && (await openDrawer('new-attribute')) && (await exists('#create-attribute-form [name=label]')));
  await visit('/attributes?q=zzzz-none', '!!document.querySelector("[data-empty]")');
  ok('attributes: a search with no match shows the empty state', await exists('[data-state=empty][data-empty=attributes]'));
  if (attrs[0]) {
    await visit(`/attributes?q=${encodeURIComponent(attrs[0].label.toLowerCase())}`, '!!document.querySelector("[data-attribute]")');
    ok('attributes: search by name finds the attribute', await exists(`[data-attribute="${attrs[0].id}"]`));
  }
  await b.shot('catalogue-setup-attributes.png', true);

  // ---------- Size charts ----------
  const [chart] = await q(`select id, name from size_charts order by name limit 1`);
  const [aProduct] = await q(`select id, name, category_id from products where status = 'active' and size_chart_id is null order by id limit 1`);
  if (chart) {
    // Assigned for this check with the owner connection (to a category and to one product), and cleared again below.
    chartFix = {category: (await q(`select id, size_chart_id from categories where id = 'outerwear'`))[0], product: aProduct.id};
    await q(`update categories set size_chart_id = $1 where id = 'outerwear'`, [chart.id]); await q(`update products set size_chart_id = $1 where id = $2`, [chart.id, aProduct.id]);
  }
  await visit('/size-charts', '!!document.querySelector("[data-workspace=size-charts]")');
  ok('size charts: on the workspace frame; creating is in a drawer', (await moduleViews()) === VIEWS && !(await exists('#create-size-chart-form')) && (await exists('[data-drawer-open=new-size-chart]')));
  if (chart) {
    const card = `[data-size-chart="${chart.name}"]`;
    ok('size charts: a chart says where it is assigned: categories and single products', (await exists(`${card} [data-size-chart-table]`)) && (await attr(`${card} [data-link=chart-category][href="/products?category=outerwear"]`, 'href')) === '/products?category=outerwear'
      && (await attr(`${card} [data-link=chart-product]`, 'href')) === `/products/${aProduct.id}?tab=merchandising`, await text(`${card} [data-size-chart-use]`));
    await click(`${card} [data-link=chart-product]`);
    ok('size chart → product: the product Merchandising tab names the same chart', (await until(`location.pathname === '/products/${aProduct.id}' && !!document.querySelector('[data-section=size-chart]')`, 20000)) && (await text('[data-product-size-chart]')).includes(chart.name));
    ok('product → Catalogue setup: the size-chart section links back to Size charts', await exists('[data-section=size-chart] [data-link=catalogue-setup][href="/size-charts"]'));
  } else ok('size charts: empty state', await exists('[data-state=empty][data-empty=size-charts]'));
  await visit('/size-charts', '!!document.querySelector("[data-workspace=size-charts]")');
  await b.shot('catalogue-setup-size-charts.png', true);
  await ev(`document.querySelector('[data-module-views=catalogue] [data-view="/categories"]').click(),true`);
  ok('the view row moves between the four Catalogue setup pages', await until(`location.pathname === '/categories' && !!document.querySelector('[data-categories-table]')`, 20000));

  // ================= inventory manager: may look, may not change =================
  ok('inventory manager signs in', await signIn('inventory', 'Setup Inventory'));
  await visit('/categories', '!!document.querySelector("[data-categories-table]")');
  ok('read-only categories: no New category, no row actions, a note instead', !(await exists('[data-drawer-open]')) && (await count('[data-workspace=categories] form:not([role=search])')) === 0 && (await exists('[data-readonly=categories]'))
    && (await exists('[data-category-row=tops] [data-link=category-products]')));
  await visit('/collections', '!!document.querySelector("[data-collections-table]")');
  const roList = !(await exists('[data-drawer-open]')) && (await count('[data-workspace=collections] form')) === 0 && (await exists('[data-readonly=collections]'));
  await visit(`/collections/${withMembers.id}`, '!!document.querySelector("[data-entity=collection]")');
  const roOne = (await count('[data-entity=collection] form')) === 0 && (await exists('[data-readonly=collection]')) && (await exists('[data-members-table]'));
  await visit(`/collections/${withMembers.id}?tab=details`, '!!document.querySelector("[data-tab-panel=details]")');
  ok('read-only collections: list, products and details are shown without any action', roList && roOne && !(await exists('#collection-name-form')) && (await exists('[data-readonly=collection]')));
  await visit('/attributes', '!!document.querySelector("[data-workspace=attributes]")');
  const roAttr = !(await exists('[data-drawer-open]')) && (await count('[data-workspace=attributes] form:not([role=search])')) === 0 && (await exists('[data-readonly=attributes]'));
  await visit('/size-charts', '!!document.querySelector("[data-workspace=size-charts]")');
  ok('read-only attributes and size charts (size charts follow products.write, as before)', roAttr && !(await exists('[data-drawer-open]')) && (await count('[data-workspace=size-charts] form')) === 0 && (await exists('[data-readonly=size-charts]')));

  // ================= support: no categories.read =================
  ok('support signs in', await signIn('support', 'Setup Support'));
  const gates = [];
  for (const p of ['/categories', '/collections', `/collections/${withMembers.id}`, '/attributes']) { await visit(p); gates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-categories-table],[data-collections-table],[data-entity=collection],[data-attribute]'))); }
  ok('support (no categories.read): Categories, Collections, a collection and Attributes are not served', gates.every(Boolean), gates.join());
  await visit('/size-charts', '!!document.querySelector("[data-workspace=size-charts]")');
  ok('support: Size charts (products.read) is shown read-only, and is the only Catalogue setup view offered', (await exists('[data-readonly=size-charts]')) && !(await exists('[data-module-views=catalogue]'))
    && (await attr('.nav a[data-module=catalogue]', 'href')) === '/size-charts');

  // ================= phone width =================
  await b.viewport(390, 844, true);
  await visit('/size-charts'); ok('390px, read-only: /size-charts has no sideways page scroll', await noOverflow());
  await b.send('Network.clearBrowserCookies');
  await b.viewport(1440, 900);
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', 'cs.root@test.local'); await fill('input[name=password]', PW); await submit('main form');
  const rootBack = await until(`location.pathname==='/dashboard'`, 20000);
  ok('super admin signs in with the password', rootBack, await here());
  if (rootBack) {
    await b.viewport(390, 844, true);
    for (const p of ['/categories', '/categories?status=inactive', '/collections', `/collections?group=${grouped?.group_id ?? 'other'}`, `/collections/${withMembers.id}`, `/collections/${withMembers.id}?tab=details`, '/attributes', '/size-charts']) {
      await visit(p);
      ok(`390px: no sideways page scroll: ${p}`, await noOverflow());
    }
    await visit('/categories', '!!document.querySelector("[data-categories-table]")');
    ok('390px categories: rows become cards with every fact kept (name, products, status, actions)', await ev(`(()=>{const r=document.querySelector('[data-category-row=tops]');const box=r.getBoundingClientRect();
      return box.right <= innerWidth + 1 && !!r.querySelector('.cat-label') && !!r.querySelector('[data-category-products]') && !!r.querySelector('.badge') && !!r.querySelector('[id="cat-active-tops"]')})()`));
    ok('390px categories: the view row scrolls inside itself; all four views are there', (await moduleViews()) === VIEWS && (await ev(`document.querySelector('[data-module-views=catalogue]').getBoundingClientRect().right <= innerWidth + 1`)));
    await b.shot('catalogue-setup-390-categories.png', true);
    await visit('/collections', '!!document.querySelector("[data-collections-table]")');
    ok('390px collections: rows keep the name, the counts, the store status and the order actions', await ev(`(()=>{const r=document.querySelector('[data-collection]');return r.getBoundingClientRect().right <= innerWidth + 1 && !!r.querySelector('a.row-link') && !!r.querySelector('[data-collection-counts]') && !!r.querySelector('.badge')})()`));
    await b.shot('catalogue-setup-390-collections.png', true);
    await openDrawer('new-collection');
    // The drawer slides in: measured once it has come to rest.
    ok('390px: the New collection drawer fills the screen and its form is usable', await until(`(()=>{const d=document.querySelector('[data-drawer=new-collection]').getBoundingClientRect();return Math.abs(d.left) <= 1 && Math.abs(d.width - innerWidth) <= 1 && !!document.querySelector('#create-collection-form [name=label]')})()`, 5000));
    await visit(`/collections/${withMembers.id}`, '!!document.querySelector("[data-entity=collection]")');
    ok('390px collection: header, tabs and the product table stay inside the screen', await ev(`[...document.querySelectorAll('[data-entity=collection] .ent-head, [data-entity=collection] .ent-tabs, [data-tab-panel] .table-wrap')].every(x=>x.getBoundingClientRect().right <= innerWidth + 1)`));
    await b.shot('catalogue-setup-390-collection.png', true);
  }

  // ================= nothing else moved =================
  ok('stock ledger unchanged by the whole run', JSON.stringify(await ledger()) === JSON.stringify(before), JSON.stringify(before));
  ok('no product changed status (approval rules untouched)', JSON.stringify(await q(`select id, status from products order by id`)) === JSON.stringify(statusBefore));
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally {
  b.close();
  try { if (chartFix) { await q(`update categories set size_chart_id = $1 where id = 'outerwear'`, [chartFix.category?.size_chart_id ?? null]); await q(`update products set size_chart_id = null where id = $1`, [chartFix.product]); } }
  catch (e) { ok('size-chart assignment cleared', false, String(e.message)); }
  await pool.end();
}

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
