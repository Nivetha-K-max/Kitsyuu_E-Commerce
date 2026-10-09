/* ERP segregation, remaining modules (2026-10-09), against the LOCAL test database (never Supabase).
   Started by tests/run-e2e.mjs after every other suite, with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin, support = neither marketing nor pricing).
   Checks that Marketing, Pricing & discounts, Reviews, Support, Store content, Finance, Reports, Team & access,
   Configuration, System, POS and the Customers module's Carts and Loyalty views are on the shared frame, that a campaign and
   a segment have their record pages, and that the record pages of a ticket, a staff member and a role use the entity frame.
   What it creates, through the existing actions: one campaign, one discount linked to it, one banner linked to it, one
   segment (deleted again) and one support ticket. No stock, order or price is changed. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'modules e2e passphrase';
const pool = new pg.Pool({connectionString: assertLocalOwnerUrl(KITSYUU_DB_URL), max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;

const b = await launch(9411);
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
const click = async sel => { await hydrated(sel); await ev(`document.querySelector(${JSON.stringify(sel)}).click(),true`); };
const openDrawer = async (name, form) => { await click(`[data-drawer-open=${name}]`); return until(`!!document.querySelector(${JSON.stringify(`[data-drawer=${name}] ${form}`)})`); };
const noOverflow = () => ev('document.documentElement.scrollWidth <= innerWidth + 1');
const tabs = () => ev(`[...document.querySelectorAll('[data-entity-tab]')].map(a=>a.dataset.entityTab).join('|')`);
const views = () => ev(`[...document.querySelectorAll('[data-views] [data-view]')].map(a=>a.textContent.trim()).join('|')`);

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
  const stock0 = (await q(`select (select count(*)::int from inventory_movements) moves, (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select count(*)::int from orders) orders`))[0];
  ok('super admin signs in', await signIn('root', 'Modules Root'));

  // ================= every remaining module page is on the workspace frame =================
  const PAGES = [
    ['/marketing', 'marketing'], ['/marketing/banners', 'marketing-banners'], ['/marketing/segments', 'marketing-segments'], ['/marketing/subscribers', 'marketing-subscribers'], ['/marketing/report', 'marketing-report'],
    ['/pricing', 'pricing'], ['/pricing/discounts', 'pricing-discounts'], ['/pricing/scheduled', 'pricing-scheduled'], ['/pricing/history', 'pricing-history'],
    ['/reviews', 'reviews'], ['/support', 'support'], ['/support/report', 'support-report'], ['/content', 'content'],
    ['/finance', 'finance'], ['/finance/expenses', 'finance-expenses'], ['/finance/invoices', 'finance-invoices'], ['/finance/notes', 'finance-notes'], ['/finance/reconciliation', 'finance-reconciliation'],
    ['/finance/tax', 'finance-tax'], ['/finance/vendor-payments', 'finance-vendor-payments'], ['/reports', 'reports'],
    ['/staff', 'staff'], ['/roles', 'roles'], ['/audit', 'audit'], ['/settings', 'configuration'], ['/system', 'system'], ['/pos', 'pos'],
    ['/carts', 'carts'], ['/carts/checkouts', 'carts-checkouts'], ['/carts/wishlists', 'carts-wishlists'], ['/loyalty', 'loyalty'],
    ['/stock-counts', 'stock-counts'], ['/stock-value', 'stock-value'],
    ['/pos/sessions', 'pos-sessions'], ['/pos/report', 'pos-report'], ['/audit/sign-ins', 'audit-sign-ins'], ['/locations/report', 'locations-report'],
    ['/shipping/couriers', 'shipping-couriers'], ['/shipping/zones', 'shipping-zones'], ['/shipping/report', 'shipping-report'], ['/returns/report', 'returns-report'],
    ['/notifications', 'notifications'], ['/search', 'search'], ['/products/bulk', 'products-bulk'], ['/products/new', 'new-product'], ['/roles/new', 'new-role'], ['/staff/invite', 'invite-staff'], ['/support/new', 'new-ticket'],
  ];
  const offFrame = [];
  for (const [p, name] of PAGES) { await visit(p); if (!(await exists(`[data-workspace=${name}] .page-head h1`)) || (await exists('[data-gate]'))) offFrame.push(p); }
  ok(`all ${PAGES.length} remaining module pages are on the workspace frame, each with its title`, offFrame.length === 0, offFrame.join(', '));
  await visit('/marketing');
  ok('Marketing: the five agreed views, in order (Campaigns · Banners · Segments · Subscribers · Report)', (await views()) === 'Campaigns|Banners|Segments|Subscribers|Report', await views());
  await visit('/pricing');
  ok('Pricing & discounts: its views are unchanged (Products · Discounts & coupons · Scheduled changes · Price history)', (await views()) === 'Products|Discounts & coupons|Scheduled changes|Price history', await views());

  // ================= Marketing: a campaign and its record page =================
  await visit('/marketing', '!!document.querySelector("[data-workspace=marketing]")');
  ok('campaigns: creating is in a drawer (no form on the page until it is opened)', !(await exists('#create-campaign-form')) && (await openDrawer('new-campaign', '#create-campaign-form')));
  await fill('#create-campaign-form input[name=name]', 'MF Festive'); await fill('#create-campaign-form textarea[name=description]', 'Frame test campaign');
  await submit('#create-campaign-form');
  ok('campaigns: the new campaign appears in the list and its row opens the campaign', (await until(`!!document.querySelector('[data-campaign="MF Festive"] a.row-link')`, 15000)), await message('#create-campaign-form'));
  const [camp] = await q(`select id from campaigns where name = 'MF Festive'`);
  const C = `/marketing/campaigns/${camp.id}`;
  ok('campaigns: the row link is the campaign page', (await attr('[data-campaign="MF Festive"] a.row-link', 'href')) === C);
  await visit(C, '!!document.querySelector("[data-entity=campaign]")');
  ok('campaign: on the entity frame; tabs Overview · Discounts · Banners · Results · Activity', (await text('[data-entity=campaign] h1')).startsWith('MF Festive') && (await tabs()) === 'overview|discounts|banners|results|activity', await tabs());
  ok('campaign: Overview shows its details and figures; nothing linked yet', /Frame test campaign/.test(await text('[data-campaign-details]')) && (await text('[data-fact=discounts]')).trim() === '0' && (await text('[data-fact=banners]')).trim() === '0');
  await visit(C + '?tab=discounts', '!!document.querySelector("[data-section=discounts]")');
  ok('campaign → Discounts: empty, and it says discounts are made under Pricing & discounts (with the link)', (await exists('[data-empty=campaign-discounts]')) && (await attr('[data-link=pricing-discounts]', 'href')) === '/pricing/discounts');
  // a discount is created where discounts are created, and linked to the campaign there
  await visit('/pricing/discounts', '!!document.querySelector("#create-discount-form")');
  await fill('#create-discount-form input[name=name]', 'MF ten'); await fill('#create-discount-form input[name=code]', 'mf10'); await fill('#create-discount-form input[name=value]', '10');
  await fill('#create-discount-form select[name=campaignId]', camp.id);
  await autoConfirm(); await submit('#create-discount-form');
  ok('discount: created under Pricing & discounts and linked to the campaign', (await q(`select campaign_id from discounts where name = 'MF ten'`))[0]?.campaign_id === camp.id, await message('#create-discount-form'));
  await visit(C + '?tab=discounts', '!!document.querySelector("[data-campaign-discounts]")');
  ok('campaign → Discounts: lists the linked discount with its code', (await count('[data-campaign-discounts] tbody tr')) === 1 && /MF10/.test(await text('[data-discount="MF ten"]')));
  // a banner linked to the campaign
  await visit('/marketing/banners', '!!document.querySelector("[data-workspace=marketing-banners]")');
  ok('banners: creating is in a drawer', !(await exists('#create-banner-form')) && (await openDrawer('new-banner', '#create-banner-form')));
  await fill('#create-banner-form input[name=heading]', 'MF banner'); await fill('#create-banner-form select[name=campaignId]', camp.id);
  await submit('#create-banner-form');
  ok('banners: saved as a draft and listed with a link to its campaign', (await until(`!!document.querySelector('[data-banner="MF banner"]')`, 15000)) && (await attr('[data-banner="MF banner"] a[href^="/marketing/campaigns/"]', 'href')) === C + '?tab=banners', await message('#create-banner-form'));
  await visit(C + '?tab=banners', '!!document.querySelector("[data-campaign-banners]")');
  ok('campaign → Banners: lists the linked banner as a draft', (await count('[data-campaign-banners] tbody tr')) === 1 && /draft/i.test(await text('[data-banner="MF banner"]')));
  await visit(C + '?tab=results', '!!document.querySelector("[data-campaign-results]")');
  ok('campaign → Results: orders, revenue and discount given from recorded redemptions (none yet), with a link to the report', /orders\s*0/i.test(await text('[data-campaign-results]')) && (await attr('[data-link=promotion-report]', 'href')) === '/marketing/report', await text('[data-campaign-results]'));
  await visit(C, '!!document.querySelector("[data-drawer-open=edit-campaign]")');
  await openDrawer('edit-campaign', `#campaign-${camp.id}`);
  await fill(`#campaign-${camp.id} textarea[name=description]`, 'Edited in the drawer'); await submit(`#campaign-${camp.id}`);
  ok('campaign: edited in a drawer on its own page', (await until(`/Edited in the drawer/.test(document.querySelector('[data-campaign-details]')?.innerText ?? '')`, 15000)), await message(`#campaign-${camp.id}`));
  await visit(C, `!!document.querySelector('#campaign-active-${camp.id}')`);
  const stateBefore = (await text('[data-campaign-state]')).trim();
  await submit(`#campaign-active-${camp.id}`);
  ok('campaign: Pause switches it off (and the page says so)', (await until(`document.querySelector('[data-campaign-state]')?.innerText.trim() !== ${JSON.stringify(stateBefore)}`, 15000)) && (await q(`select is_active from campaigns where id = $1`, [camp.id]))[0].is_active === false, `${stateBefore} → ${(await text('[data-campaign-state]')).trim()}`);
  await visit(C + '?tab=activity', '!!document.querySelector("[data-activity=campaign]")');
  ok('campaign → Activity: its changes from the audit log', (await count('[data-activity=campaign] li')) >= 3);

  // ================= Marketing: a segment and its record page =================
  await visit('/marketing/segments', '!!document.querySelector("[data-workspace=marketing-segments]")');
  ok('segments: creating is in a drawer', !(await exists('#create-segment-form')) && (await openDrawer('new-segment', '#create-segment-form')));
  await fill('#create-segment-form input[name=name]', 'MF buyers'); await fill('#create-segment-form input[name=minOrders]', '1');
  await submit('#create-segment-form');
  ok('segments: the new segment is listed with its rules in words and opens its page', (await until(`!!document.querySelector('[data-segment="MF buyers"] a.row-link')`, 15000)) && /at least 1 paid order/.test(await text('[data-segment="MF buyers"]')), await message('#create-segment-form'));
  const [seg] = await q(`select id from customer_segments where name = 'MF buyers'`);
  const SG = `/marketing/segments/${seg.id}`;
  await visit(SG, '!!document.querySelector("[data-entity=segment]")');
  ok('segment: on the entity frame; tabs Customers · Rules; it says it is not a mailing list', (await tabs()) === 'customers|rules' && /not a mailing list/.test(await text('[data-segment-note]')) && /at least 1 paid order/.test(await text('[data-segment-facts]')), await tabs());
  ok('segment → Customers: the customers who match now (or an empty state), counted in the header', (await exists('[data-segment-members],[data-empty=segment-members]')) && /^\d/.test((await text('[data-fact=members]')).trim()));
  await visit(SG + '?tab=rules', `!!document.querySelector('#segment-${seg.id}')`);
  await fill(`#segment-${seg.id} input[name=minOrders]`, '2'); await submit(`#segment-${seg.id}`);
  ok('segment → Rules: the rules are changed on the segment\'s own page', (await until(`/at least 2 paid order/.test(document.querySelector('[data-segment-facts]')?.innerText ?? '')`, 15000)), await message(`#segment-${seg.id}`));
  await autoConfirm(); await submit(`#segment-del-${seg.id}`);
  await w(800);
  ok('segment: deleting asks first and removes only the saved filter', (await q(`select count(*)::int n from customer_segments where id = $1`, [seg.id]))[0].n === 0 && /Customers are not affected/.test(await ev('(window.__q ?? []).join(" ")')));

  // ================= record pages of the other modules on the entity frame =================
  await visit('/support/new', '!!document.querySelector("#new-ticket-form")');
  await fill('#new-ticket-form input[name=customerEmail]', 'mf.customer@test.local'); await fill('#new-ticket-form input[name=subject]', 'MF frame ticket'); await fill('#new-ticket-form textarea[name=body]', 'Where is my order?');
  await submit('#new-ticket-form');
  ok('ticket: created and opened on the entity frame (Conversation · Activity)', (await until(`/^\\/support\\/[0-9a-f-]{36}$/.test(location.pathname) && !!document.querySelector('[data-entity=ticket]')`, 20000)) && (await tabs()) === 'main|activity', await tabs());
  const T = await ev('location.pathname');
  ok('ticket: the header has its number, who it is from and when; the conversation and details are on the first tab', /mf\.customer@test\.local/.test(await text('[data-ticket-facts]')) && (await exists('[data-section=ticket-messages]')) && (await exists('[data-section=ticket-details]')));
  await visit(T + '?tab=activity', '!!document.querySelector("[data-tab-panel=activity]")');
  ok('ticket → Activity: served, with the working forms left on the first tab', (await exists('[data-section=activity]')) && !(await exists('[data-section=ticket-messages]')));
  const [me] = await q(`select id from staff_users where email = 'mf.root@test.local'`);
  await visit(`/staff/${me.id}`, '!!document.querySelector("[data-entity=staff-member]")');
  ok('staff member: on the entity frame (Account · Activity) with roles and access on the first tab', (await tabs()) === 'main|activity' && (await exists('[data-section=roles]')) && (await exists('[data-section=access]')) && /mf\.root@test\.local/.test(await text('[data-staff-facts]')), await tabs());
  await visit(`/staff/${me.id}?tab=activity`, '!!document.querySelector("[data-activity=staff-member],[data-empty=staff-member-activity]")');
  ok('staff member → Activity: its changes from the audit log', (await count('[data-activity=staff-member] li')) >= 1);
  const [role] = await q(`select id, code from roles where code = 'manager'`);
  await visit(`/roles/${role.id}`, '!!document.querySelector("[data-entity=role]")');
  ok('role: on the entity frame (Permissions · Activity) with the permission matrix on the first tab', (await tabs()) === 'main|activity' && (await exists('[data-perm-matrix]')) && /manager/.test(await text('[data-role-facts]')), await tabs());
  await visit('/stock-value', '!!document.querySelector("[data-workspace=stock-value]")');
  ok('Inventory → Stock value: two views of one page', (await list('[data-value-views] [data-view]', 'e.dataset.view')).join('|') === 'pieces|materials');

  // ================= nothing here touches stock, orders or prices =================
  const stock1 = (await q(`select (select count(*)::int from inventory_movements) moves, (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select count(*)::int from orders) orders`))[0];
  ok('no stock movement, stock quantity or order changed', JSON.stringify(stock0) === JSON.stringify(stock1), JSON.stringify({stock0, stock1}));

  // ================= permissions: the frame hides nothing that was protected and shows nothing that was not =================
  ok('support signs in', await signIn('support', 'Modules Support'));
  const gates = [];
  for (const p of ['/marketing', C, C + '?tab=discounts', '/marketing/segments', '/pricing', '/pricing/discounts', '/finance', '/staff', `/roles/${role.id}`, '/settings', '/system', '/stock-value']) {
    await visit(p); gates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-entity],[data-campaigns-table],[data-pricing-table],[data-perm-matrix],#create-discount-form')));
  }
  ok('a support agent is refused Marketing, a campaign, Pricing, Finance, Team & access, Configuration, System and Stock value', gates.every(Boolean), gates.join());
  await visit('/support', '!!document.querySelector("[data-workspace=support]")');
  ok('a support agent still has Support, on the frame, and can open the ticket', (await exists('[data-ticket-filters]')));
  await visit(T, '!!document.querySelector("[data-entity=ticket]")');
  ok('a support agent sees the ticket but no Activity tab (no audit.read)', (await tabs()) === 'main');

  // ================= phone width =================
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', 'mf.root@test.local'); await fill('input[name=password]', PW); await submit('main form');
  const rootBack = await until(`location.pathname==='/dashboard'`, 20000);
  ok('super admin signs in with the password', rootBack);
  if (rootBack) {
    await b.viewport(390, 844, true);
    const wide = [];
    for (const p of [...PAGES.map(x => x[0]), C, C + '?tab=discounts', C + '?tab=banners', C + '?tab=results', T, `/staff/${me.id}`, `/roles/${role.id}`]) { await visit(p); if (!(await noOverflow())) wide.push(p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')); }
    ok(`390px: no sideways page scroll on any of the ${PAGES.length + 7} pages`, wide.length === 0, wide.join(', '));
    await visit('/marketing', '!!document.querySelector("[data-drawer-open=new-campaign]")');
    await openDrawer('new-campaign', '#create-campaign-form'); await w(500);
    ok('390px: the New campaign drawer fits the screen', await ev(`(()=>{const d=document.querySelector('[data-drawer=new-campaign]').getBoundingClientRect();return d.left >= -1 && d.right <= innerWidth + 1})()`));
    await b.shot('mf-390-marketing.png');
    await b.viewport(1440, 900);
    await visit(C, '!!document.querySelector("[data-entity=campaign]")'); await b.shot('mf-campaign.png');
    await visit('/marketing', '!!document.querySelector("[data-workspace=marketing]")'); await b.shot('mf-marketing.png');
    await visit('/finance', '!!document.querySelector("[data-workspace=finance]")'); await b.shot('mf-finance.png');
  }
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
