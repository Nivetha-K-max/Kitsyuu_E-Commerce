/* Phase 8 browser tests: Inventory & Locations (2026-10-08), against the LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs after every other suite, with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin, inventory = inventory_manager, support = inventory.read only, accountant = no inventory.read).
   What it changes, all through the existing actions and the stock functions, and all put back: +3 / −3 at a branch,
   one transfer sent and cancelled. The online stock and the ledger's totals are compared before and after. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'inventory e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9406);
const ev = e => b.eval(e);
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
const allErrors = [];
const READY = '!!document.querySelector("main") && !document.querySelector("[data-loading]")';
const visit = async (p, ready = READY) => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]/.test(e))); };
const autoConfirm = () => ev(`window.__q=[];window.__acObs?.disconnect();window.__acObs=new MutationObserver(()=>{const d=document.querySelector('[data-confirm-dialog]:not([data-auto])');if(d){d.setAttribute('data-auto','1');window.__q.push(d.querySelector('[data-confirm-text]').textContent);d.querySelector('[data-confirm-accept]').click();}});window.__acObs.observe(document.body,{childList:true,subtree:true});true`);
const click = async sel => { await hydrated(sel); await ev(`document.querySelector(${JSON.stringify(sel)}).click(),true`); };
const noOverflow = () => ev('document.documentElement.scrollWidth <= innerWidth + 1');
const VIEWS = '/inventory|/inventory/movements|/locations|/transfers|/stock-counts|/stock-value';
const moduleViews = () => ev(`[...document.querySelectorAll('[data-module-views=inventory] [data-view]')].map(a=>a.dataset.view).join('|')`);
const totals = async () => (await q(`select (select count(*)::int from inventory_movements) rows, (select coalesce(sum(stock_qty),0)::int from product_variants) online_units, (select coalesce(sum(qty),0)::int from location_stock) located,
  (select count(*)::int from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id and (m.location_id is null or m.location_id = (select id from locations where is_online))))
  + (select count(*)::int from location_stock s where s.qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = s.variant_id and coalesce(m.location_id, (select id from locations where is_online)) = s.location_id)) mismatch,
  (select count(*)::int from location_stock where qty < 0) + (select count(*)::int from product_variants where stock_qty < 0) negative`))[0];

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
  ok('before: stock equals its ledger at every location, nothing negative', before.mismatch === 0 && before.negative === 0, JSON.stringify(before));
  const [{n: sizes}] = await q(`select count(*)::int n from product_variants`);
  const [online] = await q(`select id, name from locations where is_online`);
  // a branch for the checks (an existing active one; nothing is created here)
  const findBranch = async () => (await q(`select l.id, l.name, l.code, (select count(*)::int from location_stock s where s.location_id = l.id and s.qty > 0) held from locations l where not l.is_online and l.is_active order by held desc, l.sort_order limit 1`))[0];
  // In the full run the earlier suites have added branches. Run on its own (ONLY=inventory) there is none yet: one empty branch is added as a fixture.
  if (!(await findBranch())) await q(`insert into locations (code, name, kind, is_active, sort_order) values ('INV-E2E', 'Inventory Test Branch', 'retail', true, (select coalesce(max(sort_order), 0) + 1 from locations))`);
  const branch = await findBranch();

  // ================= super admin =================
  ok('super admin signs in', await signIn('root', 'Inventory Root'));

  // ---------- Stock overview ----------
  await visit('/inventory', '!!document.querySelector("[data-stock-table]")');
  ok('stock: on the workspace frame with the Inventory views (Stock · Movements · Locations · Transfers · Stock counts · Stock value)', (await exists('[data-workspace=inventory] h1')) && (await moduleViews()) === VIEWS, await moduleViews());
  ok('stock: paged, 50 sizes a page, and the pager says how many there are', (await count('[data-stock-row]')) === Math.min(50, sizes) && new RegExp(`of ${Math.ceil(sizes / 50)} · ${sizes} sizes`).test(await text('[data-pager]')), `${sizes} sizes · ${await text('[data-pager]')}`);
  ok('stock: the page says what the figures mean (on hand = sellable; no separate reserved quantity)', /on hand and can be sold/.test(await text('[data-stock-definitions]')) && !/reserved/i.test(await text('[data-stock-table] thead')));
  const [row] = await q(`select s.variant_sku sku, s.stock_qty, s.reorder_level, s.stock_status, s.product_id, s.product_name from v_inventory_status s where s.is_active order by s.product_sku, s.variant_sku limit 1`);
  const R = `[data-stock-row="${row.sku}"]`;
  ok('stock: a row shows the product, SKU, size, the online stock the database holds, the reorder level and status', (await text(`${R} .row-link`)) === row.product_name && (await text(`${R} [data-qty]`)).trim() === String(row.stock_qty)
    && (await attr(R, 'data-level')) === row.stock_status && (await text(R)).includes(row.sku) && new RegExp(`\\b${row.reorder_level}\\b`).test(await text(R)));
  ok('stock → product: the row opens the product on Variants & Stock', (await attr(`${R} a.row-link`, 'href')) === `/products/${row.product_id}?tab=variants`);
  await click('[data-pager] a');
  ok('stock: Next goes to page 2 (in the address) with the following sizes', (await until(`/page=2/.test(location.search) && !!document.querySelector('[data-stock-table]')`, 20000)) && !(await exists(R)) && (await count('[data-stock-row]')) === Math.min(50, sizes - 50));
  await ev('history.back(),true');
  ok('Back returns to page 1', await until(`!/page=/.test(location.search) && !!document.querySelector(${JSON.stringify(R)})`, 20000));
  await visit(`/inventory?q=${encodeURIComponent(row.sku)}`, '!!document.querySelector("[data-stock-table]")');
  ok('stock: search by SKU finds exactly that size', (await list('[data-stock-row]', 'e.dataset.stockRow')).join() === row.sku);
  for (const st of ['low_stock', 'out_of_stock', 'attention']) {
    const [{n}] = await q(st === 'attention' ? `select count(*)::int n from v_inventory_status where is_active and stock_status <> 'in_stock'` : `select count(*)::int n from v_inventory_status where stock_status = $1`, st === 'attention' ? [] : [st]);
    await visit(`/inventory?status=${st}`, '!!document.querySelector("[data-stock-table],[data-empty]")');
    const levels = await list('[data-stock-row]', 'e.dataset.level');
    ok(`stock: the "${st}" filter is the database's own status (${n} size${n === 1 ? '' : 's'})`, levels.length === Math.min(50, n) && (n > 0 || (await exists('[data-state=empty][data-empty=stock]')))
      && levels.every(l => st === 'attention' ? l === 'low_stock' || l === 'out_of_stock' : l === st || l === 'off'), `${levels.length} shown`);
  }
  const [{n: inTops}] = await q(`select count(*)::int n from product_variants v join products p on p.id = v.product_id where p.category_id = 'tops' or p.subcategory_id = 'tops'`);
  await visit('/inventory?category=tops', '!!document.querySelector("[data-stock-table]")');
  ok('stock: the category filter lists that category\'s sizes', (await count('[data-stock-row]')) === Math.min(50, inTops) && new RegExp(`${inTops} sizes|^$`).test((await text('[data-pager]')).match(/\d+ sizes/)?.[0] ?? ''), String(inTops));
  await visit('/inventory?sort=qty_asc', '!!document.querySelector("[data-stock-table]")');
  const asc = (await list('[data-stock-row] [data-qty]', 'Number(e.innerText)'));
  ok('stock: sorting by lowest stock first orders the sizes', asc.length > 1 && asc.every((v, i) => i === 0 || asc[i - 1] <= v), asc.slice(0, 6).join());
  // location: the sizes a branch holds, with the quantity there
  const heldHere = await q(`select v.sku, s.qty from location_stock s join product_variants v on v.id = s.variant_id join products p on p.id = v.product_id where s.location_id = $1 and s.qty > 0 order by p.sku, v.sku`, [branch.id]);
  await visit(`/inventory?location=${branch.id}`, '!!document.querySelector("[data-stock-table],[data-empty]")');
  ok(`stock: the location filter shows the sizes ${branch.name} holds, with the quantity there`, heldHere.length === 0 ? await exists('[data-state=empty][data-empty=stock]')
    : (await count('[data-stock-row]')) === Math.min(50, heldHere.length) && (await text(`[data-stock-row="${heldHere[0].sku}"] [data-qty-here]`)).trim() === String(heldHere[0].qty), `${heldHere.length} sizes`);
  if (heldHere.length) {
    await visit(`/inventory?q=${encodeURIComponent(heldHere[0].sku)}`, '!!document.querySelector("[data-stock-table]")');
    ok('stock: "Other locations" names where else a size is held, linking to the location', (await text(`[data-stock-row="${heldHere[0].sku}"] [data-by-location]`)).includes(`${branch.name} ${heldHere[0].qty}`)
      && (await attr(`[data-stock-row="${heldHere[0].sku}"] [data-by-location] a[href="/locations/${branch.id}"]`, 'href')) === `/locations/${branch.id}`);
  }
  await visit('/inventory?q=zzzz-none', '!!document.querySelector("[data-empty]")');
  ok('stock: nothing matching shows the empty state with a way back', (await exists('[data-state=empty][data-empty=stock]')) && (await exists('[data-state=empty] a[href="/inventory"]')));
  await visit('/inventory', '!!document.querySelector("[data-stock-table]")');
  await b.shot('inventory-stock.png');

  // ---------- Movements: the ledger ----------
  const [busy] = await q(`select v.id, v.sku from product_variants v order by (select count(*) from inventory_movements m where m.variant_id = v.id) desc, v.sku limit 1`);
  await visit(`/inventory?q=${encodeURIComponent(busy.sku)}`, '!!document.querySelector("[data-stock-table]")');
  await click(`[data-stock-row="${busy.sku}"] [data-link=movements]`);
  ok('stock → movements: History opens the ledger for that size', await until(`location.pathname === '/inventory/movements' && !!document.querySelector('[data-movements-ledger]')`, 20000));
  const ledger = await q(`select m.id, m.delta, m.balance_after from inventory_movements m join product_variants v on v.id = m.variant_id join products p on p.id = v.product_id
    where p.name ilike $1 or v.sku ilike $1 order by m.created_at desc, m.id desc limit 50`, [`%${busy.sku}%`]);
  const shownRows = await ev(`[...document.querySelectorAll('[data-movement]')].map(r=>[r.dataset.movement, r.querySelector('[data-delta]').innerText.trim(), r.querySelector('[data-balance]').innerText.trim()])`);
  ok('movements: exactly the ledger rows of that size, newest first, with the change and the balance the ledger recorded', JSON.stringify(shownRows) === JSON.stringify(ledger.map(m => [String(m.id), m.delta > 0 ? `+${m.delta}` : String(m.delta), m.balance_after === null ? '—' : String(m.balance_after)])), `${shownRows.length} rows`);
  const [{n: allMoves}] = await q(`select count(*)::int n from inventory_movements`);
  await visit('/inventory/movements', '!!document.querySelector("[data-movements-ledger]")');
  const page1 = await list('[data-movement]', 'e.dataset.movement');
  ok('movements: on the workspace frame; 50 a page, older rows on the next page', (await moduleViews()) === VIEWS && page1.length === Math.min(50, allMoves) && (allMoves <= 50 || await exists('[data-pager] a')), `${allMoves} ledger rows`);
  if (allMoves > 50) {
    await click('[data-pager] a');
    await until(`/page=2/.test(location.search) && !!document.querySelector('[data-movement]')`, 20000);
    const page2 = await list('[data-movement]', 'e.dataset.movement');
    ok('movements: page 2 continues where page 1 stopped (no row twice, none skipped)', page2.length === Math.min(50, allMoves - 50) && page2.every(id => !page1.includes(id)) && Number(page2[0]) < Number(page1.at(-1)) + 1e9
      && JSON.stringify([...page1, ...page2]) === JSON.stringify((await q(`select id from inventory_movements order by created_at desc, id desc limit $1`, [page1.length + page2.length])).map(r => String(r.id))));
  }
  const [ordered] = await q(`select m.id, m.order_id, o.order_number from inventory_movements m join orders o on o.id = m.order_id order by m.id desc limit 1`);
  if (ordered) {
    await visit(`/inventory/movements?q=${encodeURIComponent(ordered.order_number)}`, '!!document.querySelector("[data-movements-ledger]")');
    ok('movements: a sale names its order and opens it on Items', (await attr(`[data-movement="${ordered.id}"] [data-reference] a`, 'href')) === `/orders/${ordered.order_id}?tab=items` && (await text(`[data-movement="${ordered.id}"] [data-reference]`)).includes(ordered.order_number));
  }
  const reasonsUsed = await q(`select reason, count(*)::int n from inventory_movements group by reason order by n desc limit 2`);
  await visit(`/inventory/movements?reason=${reasonsUsed[0].reason}`, '!!document.querySelector("[data-movements-ledger]")');
  ok('movements: the movement-type filter shows only that type', (await list('[data-movement]', 'e.dataset.reason')).every(r => r === reasonsUsed[0].reason) && (await count('[data-movement]')) === Math.min(50, reasonsUsed[0].n));
  await visit('/inventory/movements?direction=out', '!!document.querySelector("[data-movements-ledger],[data-empty]")');
  ok('movements: "Stock out" shows only decreases', (await list('[data-movement] [data-delta]', 'e.innerText.trim()')).every(d => d.startsWith('-')));
  const [{n: atBranch}] = await q(`select count(*)::int n from inventory_movements where location_id = $1`, [branch.id]);
  await visit(`/inventory/movements?location=${branch.id}`, '!!document.querySelector("[data-movements-ledger],[data-empty]")');
  ok(`movements: the location filter shows ${branch.name}'s rows only`, (await count('[data-movement]')) === Math.min(50, atBranch) && (atBranch > 0 || await exists('[data-state=empty][data-empty=movements]')), String(atBranch));
  ok('movements: read-only — no form or button changes anything here', (await count('[data-workspace=movements] form:not([role=search])')) === 0);
  await b.shot('inventory-movements.png');

  // ---------- Locations ----------
  await visit('/locations', '!!document.querySelector("[data-locations-table]")');
  const locs = await q(`select l.id, l.code, l.name, l.is_online, (select coalesce(sum(s.qty),0)::int from location_stock s where s.location_id = l.id) units from locations l order by l.is_online desc, l.sort_order, l.name`);
  ok('locations: on the workspace frame; every location with its kind, units and status', (await exists('[data-workspace=locations]')) && (await moduleViews()) === VIEWS && (await list('[data-location]', 'e.dataset.location')).join() === locs.map(l => l.code).join());
  ok('locations: the online location is marked; unit counts are the stock held there', /Online store stock/.test(await text(`[data-location="${locs[0].code}"]`)) && (await text(`[data-location="${branch.code}"] [data-location-units]`)).replace(/[^0-9]/g, '') === String(locs.find(l => l.id === branch.id).units));
  if (heldHere.length) {
    await click(`[data-location="${branch.code}"] [data-link=location-stock]`);
    ok('locations → stock: the units open Inventory → Stock for that location', await until(`location.pathname === '/inventory' && location.search === '?location=${branch.id}' && document.querySelectorAll('[data-stock-row]').length === ${Math.min(50, heldHere.length)}`, 20000));
  }
  await visit(`/locations/${branch.id}`, '!!document.querySelector("[data-section=location-stock]")');
  ok('location: links to its stock and its ledger rows; the Edit location button is still there', (await attr('.page-head [data-link=location-stock]', 'href')) === `/inventory?location=${branch.id}`
    && (await attr('.page-head [data-link=location-movements]', 'href')) === `/inventory/movements?location=${branch.id}` && (await attr('.page-head [data-edit-location]', 'href')) === '#edit-location' && (await exists('#edit-location #edit-location-form')));

  // ---------- adjustment at a branch: confirmation, the ledger, stale data, a double click ----------
  const F = '#location-adjust-form';
  const pick = async () => { const o = await ev(`(()=>{const o=[...document.querySelector('${F} select[name=variant]').options].find(o=>o.value);return o?{value:o.value,label:o.textContent}:null})()`); return {...o, variantId: o.value.split(':')[0], shown: Number(o.value.split(':')[1])}; };
  const qtyAt = async v => (await q(`select coalesce((select qty from location_stock where location_id = $1 and variant_id = $2), 0)::int n`, [branch.id, v]))[0].n;
  const movesAt = async v => (await q(`select count(*)::int n from inventory_movements where location_id = $1 and variant_id = $2`, [branch.id, v]))[0].n;
  let o = await pick();
  const startQty = await qtyAt(o.variantId), startMoves = await movesAt(o.variantId);
  ok('adjustment: the form shows the quantity now at the location', o.shown === startQty, `${o.label}`);
  await fill(`${F} select[name=variant]`, o.value); await fill(`${F} input[name=delta]`, 'abc'); await fill(`${F} select[name=reason]`, 'restock');
  await autoConfirm(); await submit(F);
  ok('adjustment: a quantity that is not a whole number is refused; nothing is written', (await qtyAt(o.variantId)) === startQty && (await movesAt(o.variantId)) === startMoves && !/Stock updated/.test(await message(F)), await message(F));
  await fill(`${F} select[name=variant]`, o.value); await fill(`${F} input[name=delta]`, '3'); await fill(`${F} select[name=reason]`, ''); await autoConfirm(); await submit(F);
  ok('adjustment: a reason is required', (await qtyAt(o.variantId)) === startQty && !/Stock updated/.test(await message(F)));
  await fill(`${F} select[name=variant]`, o.value); await fill(`${F} input[name=delta]`, '3'); await fill(`${F} select[name=reason]`, 'restock'); await fill(`${F} input[name=note]`, 'Phase 8 browser check');
  await autoConfirm(); await submit(F);
  const asked = (await ev('window.__q ?? []'))[0] ?? '';
  ok('adjustment: asks before writing (it cannot be edited afterwards)', new RegExp(`Record this stock change at ${branch.name}`).test(asked) && /stock ledger/.test(asked), asked);
  ok('adjustment: applied once, with a clear result', (await qtyAt(o.variantId)) === startQty + 3 && new RegExp(`Now ${startQty + 3} at this location`).test(await message(F)), await message(F));
  const [mv] = await q(`select m.delta, m.reason, m.balance_after, m.note, s.email from inventory_movements m left join staff_users s on s.id = m.staff_id where m.location_id = $1 and m.variant_id = $2 order by m.id desc limit 1`, [branch.id, o.variantId]);
  ok('adjustment: one ledger row with the change, reason, balance, note and the staff member', (await movesAt(o.variantId)) === startMoves + 1 && mv.delta === 3 && mv.reason === 'restock' && mv.balance_after === startQty + 3 && mv.note === 'Phase 8 browser check' && mv.email === 'inv.root@test.local', JSON.stringify(mv));
  ok('adjustment: audited with the location', (await q(`select count(*)::int n from audit_logs where action = 'inventory.location_adjust' and entity_id = $1 and metadata->>'location_id' = $2 and metadata->>'note' = 'Phase 8 browser check'`, [o.variantId, branch.id]))[0].n === 1);
  // stale page: the stock changes elsewhere (through the stock function) after this page was opened
  await visit(`/locations/${branch.id}`, `!!document.querySelector('${F}')`);
  const staleValue = `${o.variantId}:${startQty + 3}`;      // what this page shows for the size
  ok('adjustment: the reloaded form shows the new quantity', await exists(`${F} select[name=variant] option[value="${staleValue}"]`));
  await q(`select public.adjust_location_stock($1::uuid, $2::uuid, 1, 'restock', null::uuid, 'changed elsewhere'::text, null)`, [o.variantId, branch.id]);
  await fill(`${F} select[name=variant]`, staleValue); await fill(`${F} input[name=delta]`, '-2'); await fill(`${F} select[name=reason]`, 'damage');
  await autoConfirm(); await submit(F);
  ok('adjustment: a page that is out of date is refused, and says so', /changed since you opened/.test(await message(F)) && (await qtyAt(o.variantId)) === startQty + 4, await message(F));
  // a double click on Update stock: two submissions of the same form at the same moment
  await visit(`/locations/${branch.id}`, `!!document.querySelector('${F}')`);
  await fill(`${F} select[name=variant]`, `${o.variantId}:${startQty + 4}`); await fill(`${F} input[name=delta]`, '-4'); await fill(`${F} select[name=reason]`, 'correction');
  await fill(`${F} input[name=note]`, 'Phase 8 put back'); await hydrated(F); await autoConfirm();
  const movesBeforeDouble = await movesAt(o.variantId);
  await ev(`(()=>{const btn=document.querySelector('${F} button[type=submit]');btn.click();btn.click();return true})()`);
  await until(`/Now ${startQty} at this location|changed since/.test(document.querySelector('${F} [data-form-message]')?.innerText ?? '')`, 20000);
  await w(800);
  ok('adjustment: a double click writes one movement, not two; the branch is back where it started', (await movesAt(o.variantId)) === movesBeforeDouble + 1 && (await qtyAt(o.variantId)) === startQty, `${(await movesAt(o.variantId)) - movesBeforeDouble} row(s), qty ${await qtyAt(o.variantId)}`);
  await visit(`/locations/${branch.id}`, '!!document.querySelector("[data-location-movements]")');
  ok('location: its recent movements show those rows with before, change and after', /Phase 8 put back/.test(await text('[data-location-movements]')) && /Phase 8 browser check/.test(await text('[data-location-movements]')));
  await b.shot('inventory-location.png', true);

  // ---------- transfer: draft → sent → cancelled (stock out, then back), with its ledger rows ----------
  await visit('/transfers', '!!document.querySelector("[data-workspace=transfers]")');
  ok('transfers: on the workspace frame; views are the existing statuses', (await moduleViews()) === VIEWS && (await list('[data-transfer-views] [data-view]', 'e.dataset.view')).join() === 'all,draft,sent,received,cancelled' && (await exists('[data-link=new-transfer]')));
  await visit(`/transfers/new?from=${online.id}&to=${online.id}`, READY);
  ok('transfer: the same location for both ends is refused before anything is chosen', /two different locations/i.test(await text('main')) && !(await exists('#new-transfer-form')));
  await visit(`/transfers/new?from=${online.id}&to=${branch.id}`, '!!document.querySelector("#new-transfer-form")');
  const tSku = await ev(`document.querySelector('[data-transfer-pick] tbody tr').dataset.sku`);
  const [tv] = await q(`select id, stock_qty from product_variants where sku = $1`, [tSku]);
  await fill(`#new-transfer-form tr[data-sku="${tSku}"] input`, String(tv.stock_qty + 50)); await submit('#new-transfer-form');
  await until(`/^\\/transfers\\/[0-9a-f-]{36}$/.test(location.pathname)`, 15000);
  ok('transfer: more than the sender holds can be written down as a draft, which says it cannot be sent', /not enough/i.test(await text('[data-transfer-lines]')) && /cannot be sent/i.test(await text('main')));
  await autoConfirm(); await submit('#send-transfer-form');
  ok('transfer: sending it is refused by the server and nothing moves', /Not enough stock/i.test(await message('#send-transfer-form')) && (await q(`select stock_qty from product_variants where id = $1`, [tv.id]))[0].stock_qty === tv.stock_qty, await message('#send-transfer-form'));
  await fill('#cancel-transfer-form input[name=note]', 'Phase 8: could not be sent'); await autoConfirm(); await submit('#cancel-transfer-form');
  await visit(`/transfers/new?from=${online.id}&to=${branch.id}`, '!!document.querySelector("#new-transfer-form")');
  await fill(`#new-transfer-form tr[data-sku="${tSku}"] input`, '1'); await submit('#new-transfer-form');
  await until(`/^\\/transfers\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('#send-transfer-form')`, 15000);
  const tPath = await ev('location.pathname'), tId = tPath.split('/').pop();
  const [tr] = await q(`select number, status from stock_transfers where id = $1`, [tId]);
  ok('transfer: saved as a draft; nothing has moved; no ledger rows yet', tr.status === 'draft' && (await q(`select count(*)::int n from inventory_movements where transfer_id = $1`, [tId]))[0].n === 0 && !(await exists('[data-link=transfer-movements]')));
  await autoConfirm(); await submit('#send-transfer-form');
  const sentAsk = (await ev('window.__q ?? []'))[0] ?? '';
  ok('transfer: Send asks first and says what leaves where', new RegExp(`Send ${tr.number}\\? 1 unit\\(s\\) leave`).test(sentAsk), sentAsk);
  ok('transfer: sent — the stock has left the sender and waits to be received', (await until(`!!document.querySelector('#receive-transfer-form')`, 15000)) && (await q(`select stock_qty from product_variants where id = $1`, [tv.id]))[0].stock_qty === tv.stock_qty - 1);
  await visit(tPath, '!!document.querySelector("[data-link=transfer-movements]")');
  await click('[data-link=transfer-movements]');
  ok('transfer → movements: its ledger rows, each linking back to the transfer', (await until(`location.pathname === '/inventory/movements' && document.querySelectorAll('[data-movement]').length === 1`, 20000))
    && (await text('[data-movement] [data-delta]')).trim() === '-1' && (await attr('[data-movement] [data-reference] a', 'href')) === tPath);
  await visit(tPath, '!!document.querySelector("#cancel-transfer-form")');
  await fill('#cancel-transfer-form input[name=note]', 'Phase 8 browser check'); await autoConfirm(); await submit('#cancel-transfer-form');
  ok('transfer: cancelled after sending — the unit is back at the sender; the ledger shows it leaving and returning', (await until(`!document.querySelector('#cancel-transfer-form')`, 15000))
    && (await q(`select stock_qty from product_variants where id = $1`, [tv.id]))[0].stock_qty === tv.stock_qty
    && (await q(`select delta from inventory_movements where transfer_id = $1 order by id`, [tId])).map(r => r.delta).join() === '-1,1' && !(await exists('#send-transfer-form,#receive-transfer-form')));
  await visit('/transfers?status=cancelled', '!!document.querySelector("[data-transfers-table]")');
  ok('transfers: the Cancelled view lists it', await exists(`[data-transfer="${tr.number}"]`));
  await b.shot('inventory-transfers.png');

  // ================= inventory manager: adjust and transfer, not locations =================
  ok('inventory manager signs in', await signIn('inventory', 'Inventory Manager'));
  const perms = async role => new Set((await q(`select rp.permission_code c from role_permissions rp join roles r on r.id = rp.role_id where r.code = $1`, [role])).map(r => r.c));
  const im = await perms('inventory_manager');
  await visit('/locations', '!!document.querySelector("[data-locations-table]")');
  ok('inventory manager: sees locations; adding or editing one needs locations.manage', (await exists('#new-location-form')) === im.has('locations.manage') && (await exists('[data-readonly=locations]')) === !im.has('locations.manage'));
  await visit(`/locations/${branch.id}`, '!!document.querySelector("[data-section=location-stock]")');
  ok('inventory manager: may adjust stock at a location (inventory.adjust)', (await exists(F)) === im.has('inventory.adjust') && (await exists('#edit-location-form')) === im.has('locations.manage'));
  await visit('/transfers', '!!document.querySelector("[data-workspace=transfers]")');
  ok('inventory manager: may start a transfer (inventory.transfer)', (await exists('[data-link=new-transfer]')) === im.has('inventory.transfer'));

  // ================= support: inventory.read only =================
  ok('support signs in', await signIn('support', 'Inventory Support'));
  await visit('/inventory', '!!document.querySelector("[data-stock-table]")');
  const supStock = (await count('[data-stock-row]')) > 0 && !(await exists('[data-stock-row] a[aria-label^="Adjust"]')) && (await exists('[data-link=movements]'));
  await visit('/inventory/movements', '!!document.querySelector("[data-movements-ledger]")');
  const supMoves = (await count('[data-movement]')) > 0;
  await visit(`/locations/${branch.id}`, '!!document.querySelector("[data-section=location-stock]")');
  const supLoc = !(await exists(F)) && !(await exists('#edit-location-form')) && (await exists('[data-location-movements],[data-section=location-movements]'));
  await visit(tPath, '!!document.querySelector("[data-transfer-lines]")');
  ok('read-only (inventory.read): stock, movements, a location and a transfer are shown without any action', supStock && supMoves && supLoc && (await count('main form')) === 0);
  await visit('/transfers/new');
  ok('read-only: New transfer is not served (inventory.transfer, checked on the server)', (await exists('[data-gate=forbidden]')) && !(await exists('#new-transfer-form,[data-transfer-locations]')));
  await visit('/transfers', '!!document.querySelector("[data-workspace=transfers]")');
  ok('read-only: no New transfer button', !(await exists('[data-link=new-transfer]')));

  // ================= accountant: no inventory.read =================
  ok('accountant signs in', await signIn('accountant', 'Inventory Accounts'));
  const gates = [];
  for (const p of ['/inventory', '/inventory/movements', '/locations', `/locations/${branch.id}`, '/transfers', tPath]) { await visit(p); gates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-stock-table],[data-movements-ledger],[data-locations-table],[data-location-stock],[data-transfers-table],[data-transfer-lines]'))); }
  ok('no inventory.read: Stock, Movements, Locations, a location, Transfers and a transfer are not served', gates.every(Boolean), gates.join());

  // ================= phone width =================
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', 'inv.root@test.local'); await fill('input[name=password]', PW); await submit('main form');
  const rootBack = await until(`location.pathname==='/dashboard'`, 20000);
  ok('super admin signs in with the password', rootBack);
  if (rootBack) {
    await b.viewport(390, 844, true);
    for (const p of ['/inventory', `/inventory?location=${branch.id}`, '/inventory?status=attention', '/inventory/movements', `/inventory/movements?location=${branch.id}`, '/locations', `/locations/${branch.id}`, '/transfers', tPath, `/transfers/new?from=${online.id}&to=${branch.id}`]) {
      await visit(p);
      ok(`390px: no sideways page scroll: ${p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`, await noOverflow());
    }
    await visit('/inventory', '!!document.querySelector("[data-stock-table]")');
    ok('390px stock: each size is a card that keeps every figure, labelled (online stock, reorder level, status, last movement)', await ev(`(()=>{const r=document.querySelector('[data-stock-row]');const box=r.getBoundingClientRect();
      return box.right <= innerWidth + 1 && !!r.querySelector('[data-qty]') && !!r.querySelector('[data-label="Reorder at"]') && !!r.querySelector('[data-label="Last movement"]') && !!r.querySelector('.badge') && !!r.querySelector('[data-link=movements]')})()`));
    ok('390px stock: the filters fit and stay usable', await ev(`[...document.querySelectorAll('[data-stock-filters] .input')].every(i=>{const r=i.getBoundingClientRect();return r.right <= innerWidth + 1 && r.width >= 120})`));
    await b.shot('inventory-390-stock.png');
    await visit('/inventory/movements', '!!document.querySelector("[data-movements-ledger]")');
    ok('390px movements: each row is a card with the change, balance, location, source and who', await ev(`(()=>{const r=document.querySelector('[data-movement]');return r.getBoundingClientRect().right <= innerWidth + 1 && !!r.querySelector('[data-delta]') && !!r.querySelector('[data-balance]') && !!r.querySelector('[data-label=Location]') && !!r.querySelector('[data-label=By]')})()`));
    await b.shot('inventory-390-movements.png');
    await visit(`/locations/${branch.id}`, `!!document.querySelector('${F}')`);
    await fill(`${F} select[name=variant]`, (await pick()).value); await fill(`${F} input[name=delta]`, '1'); await fill(`${F} select[name=reason]`, 'restock'); await hydrated(F);
    await ev(`window.__acObs?.disconnect(),document.querySelector('${F} button[type=submit]').click(),true`);
    const fits = await until(`(()=>{const d=document.querySelector('[data-confirm-dialog]');if(!d)return false;const r=d.getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1})()`, 8000);
    ok('390px: the confirmation before an adjustment fits the screen', fits);
    await ev(`(document.querySelector('[data-confirm-dialog] [data-confirm-cancel]') ?? [...document.querySelectorAll('[data-confirm-dialog] button')].find(x=>!x.matches('[data-confirm-accept]')))?.click(),true`);
    await w(500);
    ok('390px: cancelling the confirmation writes nothing', (await qtyAt(o.variantId)) === startQty);
  }

  // ================= the rest of Inventory on the shared frame (2026-10-09): stock counts, stock value, record pages =================
  if (rootBack) {
    await b.viewport(1440, 900);
    const tabsOf = () => ev(`[...document.querySelectorAll('[data-entity-tab]')].map(a=>a.dataset.entityTab).join('|')`);
    await visit('/stock-counts', '!!document.querySelector("[data-workspace=stock-counts]")');
    ok('stock counts: on the workspace frame with the Inventory views; opening a count is in a drawer', (await moduleViews()) === VIEWS && !(await exists('#open-count-form')) && (await exists('[data-drawer-open=new-count]')));
    const countsBefore = (await q(`select count(*)::int n from stock_counts`))[0].n, movesBefore = (await totals()).rows;
    await click('[data-drawer-open=new-count]'); await until(`!!document.querySelector('[data-drawer=new-count] #open-count-form')`);
    await fill('#open-count-form select[name=locationId]', branch.id); await submit('#open-count-form');
    ok('stock count: opened and shown on the entity frame (Counted quantities · Activity)', (await until(`/^\\/stock-counts\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('[data-entity=stock-count]')`, 20000)) && (await tabsOf()) === 'lines|activity', await tabsOf());
    const countPath = await ev('location.pathname');
    ok('stock count: the header says where and how much is counted; Post and Cancel are offered while it is open', (await text('[data-count-facts]')).includes(branch.name) && /0 of \d+ sizes/.test(await text('[data-count-facts] [data-fact=counted]'))
      && (await exists('#post-count-form')) && (await exists('#cancel-count-form')) && (await exists('#counts-form [data-count-lines]')), await text('[data-count-facts]'));
    await autoConfirm(); await submit('#cancel-count-form');
    ok('stock count: cancelling asks first, closes the count and changes nothing in stock', (await until(`!document.querySelector('#cancel-count-form')`, 15000)) && /Nothing is changed in stock/.test(await ev('(window.__q ?? []).join(" ")'))
      && (await q(`select status from stock_counts order by created_at desc limit 1`))[0].status === 'cancelled' && (await totals()).rows === movesBefore && (await q(`select count(*)::int n from stock_counts`))[0].n === countsBefore + 1);
    await visit(countPath + '?tab=activity', '!!document.querySelector("[data-activity=stock-count]")');
    ok('stock count → Activity: opened and cancelled, from the audit log', (await ev(`document.querySelectorAll('[data-activity=stock-count] li').length`)) === 2);
    await visit('/stock-counts', '!!document.querySelector("[data-counts-table]")');
    ok('stock counts: the list row opens the count', (await attr('[data-counts-table] tbody tr a.row-link', 'href')) === countPath);
    await visit('/stock-value', '!!document.querySelector("[data-workspace=stock-value]")');
    ok('stock value: on the workspace frame with two views (Finished pieces · Materials); the valuation rule is stated', (await moduleViews()) === VIEWS && (await list('[data-value-views] [data-view]', 'e.dataset.view')).join('|') === 'pieces|materials'
      && (await exists('[data-value-garments]')) && !(await exists('[data-value-materials]')) && /no costing method/.test(await text('[data-value-rule]')));
    await click('[data-value-views] [data-view=materials]');
    ok('stock value: Materials is its own view (in the address)', await until(`/view=materials/.test(location.search) && !!document.querySelector('[data-value-materials],[data-empty=value-materials]') && !document.querySelector('[data-value-garments]')`, 20000));
    await visit(`/locations/${branch.id}`, '!!document.querySelector("[data-entity=location]")');
    ok('location: on the entity frame (Stock · Activity); Edit location still lands on its form on the same view', (await tabsOf()) === 'stock|activity' && (await attr('.page-head [data-edit-location]', 'href')) === '#edit-location'
      && (await exists('#edit-location #edit-location-form')) && (await exists('[data-section=location-stock]')) && (await exists('[data-section=location-movements]')), await tabsOf());
    await visit(`/locations/${branch.id}?tab=activity`, '!!document.querySelector("[data-tab-panel=activity]")');
    ok('location → Activity: the tab is served and the working forms are not on it', (await exists('[data-section=activity]')) && !(await exists('#edit-location-form')) && !(await exists('#location-adjust-form')));
    await visit(tPath, '!!document.querySelector("[data-entity=transfer]")');
    ok('transfer: on the entity frame (Sizes · Activity); the header links both locations', (await tabsOf()) === 'sizes|activity' && (await ev(`document.querySelectorAll('[data-transfer-facts] a[href^="/locations/"]').length`)) === 2
      && (await exists('[data-transfer-lines]')) && (await exists('[data-transfer-meta]')), await tabsOf());
    await visit(tPath + '?tab=activity', '!!document.querySelector("[data-activity=transfer]")');
    ok('transfer → Activity: its steps from the audit log', (await ev(`document.querySelectorAll('[data-activity=transfer] li').length`)) >= 2);
    await visit(`/transfers/new?from=${online.id}&to=${branch.id}`, '!!document.querySelector("[data-workspace=new-transfer]")');
    ok('new transfer: inside the module frame with its two steps', (await exists('[data-transfer-locations]')) && (await exists('#new-transfer-form')));
    await b.viewport(390, 844, true);
    for (const p of ['/stock-counts', countPath, '/stock-value', '/stock-value?view=materials', `/locations/${branch.id}?tab=activity`, tPath + '?tab=activity']) {
      await visit(p);
      ok(`390px: no sideways page scroll: ${p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`, await noOverflow());
    }
    await b.viewport(1440, 900);
  }

  // ================= nothing created, nothing lost =================
  const after = await totals();
  ok('after: the online stock is what it was; every location\'s stock is what it was', after.online_units === before.online_units && after.located === before.located, JSON.stringify({before, after}));
  ok('after: stock still equals its ledger at every location; nothing negative', after.mismatch === 0 && after.negative === 0);
  ok('after: the ledger only grew (rows are never edited or removed)', after.rows > before.rows, `${before.rows} → ${after.rows}`);
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
