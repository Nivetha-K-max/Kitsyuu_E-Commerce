/* Leads pipeline, content studio and the "Settle…" control for a refund left pending (2026-10-12): browser tests against
   the LOCAL test database (never a hosted one). Started by tests/run-e2e.mjs with BASE, KITSYUU_DB_URL and INVITES
   (root = super_admin: may approve content moves; manager = works on leads and content, cannot approve;
   sales = leads only; support = neither).
   What it changes, through the pages' own forms and drags: three leads, one idea, two content pieces. For the refund
   control it writes one customer, one delivered order with a captured payment and a return waiting for its refund
   directly (run-e2e.mjs expects exactly that one order and customer); no provider is called. No stock moves. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from '../../website/tests/cdp.mjs';
import {assertLocalOwnerUrl} from './local-only.mjs';

const {BASE, KITSYUU_DB_URL} = process.env;
const INVITES = JSON.parse(process.env.INVITES);
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const PW = 'leads studio e2e passphrase';
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
const visit = async (p, ready = READY) => { await b.goto(BASE + p, ready); allErrors.push(...b.errors.filter(e => !/http 40[34]|\/favicon\.ico/.test(e)).map(e => `${p}: ${e}`)); };
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

/** A real drag and drop, as the browser reports it: dragstart on the card, then dragenter / dragover / drop on the target. */
const drag = (cardSel, targetSel) => ev(`(()=>{const c=document.querySelector(${JSON.stringify(cardSel)}),t=document.querySelector(${JSON.stringify(targetSel)});if(!c||!t)throw new Error('drag: missing ' + (!c ? ${JSON.stringify(cardSel)} : ${JSON.stringify(targetSel)}));
  const dt=new DataTransfer();const fire=(el,type)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));
  fire(c,'dragstart');fire(t,'dragenter');fire(t,'dragover');fire(t,'drop');fire(c,'dragend');return true})()`);
const login = async email => {
  await b.send('Network.clearBrowserCookies');
  await visit('/login', '!!document.querySelector("input[name=email]")');
  await fill('input[name=email]', email); await fill('input[name=password]', PW); await submit('main form');
  return until(`location.pathname==='/dashboard'`, 20000);
};
const navModules = () => list('.nav a[data-module]', 'e.dataset.module');
const modViews = id => ev(`[...document.querySelectorAll('[data-module-views=${id}] [data-view]')].map(a=>a.dataset.view).join('|')`);
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date());
const dayPlus = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const weekDay = n => { const d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

try {
  await b.viewport(1440, 900);
  const stock0 = (await q(`select (select count(*)::int from inventory_movements) moves, (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select count(*)::int from orders) orders, (select count(*)::int from customers) customers`))[0];

  // ================= super admin: leads =================
  ok('super admin signs in', await signIn('root', 'Studio Root'));
  const mods = await navModules();
  ok('sidebar: Leads and Content studio are two flat modules (24 in all, none collapsible)', mods.includes('leads') && mods.includes('studio') && mods.length === 24 && !(await exists('.nav details, .nav [aria-expanded]')), mods.join());
  await visit('/leads', '!!document.querySelector("[data-workspace=leads]")');
  ok('leads: on the workspace frame with the views Pipeline · Conversion; empty at first; the Leads module is current', (await modViews('leads')) === '/leads|/leads/conversion' && (await exists('[data-empty=leads]'))
    && (await attr('.nav a[aria-current=page]', 'data-module')) === 'leads', await modViews('leads'));
  const addLead = async (name, phone, extra = {}) => {
    await visit('/leads', '!!document.querySelector("[data-drawer-open=new-lead]")');
    await openDrawer('new-lead', '#create-lead-form');
    await fill('#create-lead-form input[name=name]', name); await fill('#create-lead-form input[name=phone]', phone);
    for (const [k, v] of Object.entries(extra)) await fill(`#create-lead-form [name=${k}]`, v);
    await submit('#create-lead-form');
    return message('#create-lead-form');
  };
  const m1 = await addLead('Mahaveer Jain', '+91 94440 10801', {interest: 'Bespoke wedding suit', timeline: 'Within 1 month', source: 'ads'});
  const [lead] = await q(`select id, stage, source, phone_key from leads where name = 'Mahaveer Jain'`);
  ok('leads: a new lead is added to New leads with its details', /added to New leads/.test(m1) && lead?.stage === 'new' && lead.source === 'ads' && lead.phone_key === '9444010801'
    && (await until(`!!document.querySelector('[data-lead-column=new] [data-lead="${lead.id}"]')`, 15000)) && /Bespoke wedding suit · Within 1 month/.test(await text(`[data-lead="${lead.id}"]`)), m1);
  const m2 = await addLead('Someone Else', '094440-10801');
  ok('leads: the same phone number written differently is refused, naming the lead that has it', /already exists: Mahaveer Jain/.test(m2) && (await q(`select count(*)::int n from leads`))[0].n === 1, m2);
  await addLead('Nave Nesa', '9043319408', {interest: 'Business suit', source: 'walk_in'});
  await addLead('Raj Munna', '7488315949');
  const [nave] = await q(`select id from leads where name = 'Nave Nesa'`), [raj] = await q(`select id from leads where name = 'Raj Munna'`);
  const stageOf = async id => (await q(`select stage from leads where id = $1`, [id]))[0].stage;
  await visit('/leads', '!!document.querySelector("[data-lead-board]")');
  ok('leads board: six columns in stage order, each with its count', (await list('[data-lead-column]', 'e.dataset.leadColumn')).join('|') === 'new|engaged|qualified|visited|converted|disqualified'
    && (await text('[data-lead-column=new] [data-stage-count]')).trim() === '3' && (await text('[data-lead-column=engaged] [data-stage-count]')).trim() === '0');
  // Dragging a card to another column.
  await hydrated(`[data-lead="${lead.id}"]`);
  await drag(`[data-lead="${lead.id}"]`, '[data-lead-column=engaged]');
  ok('leads board: dragging a card to Engaged moves the lead (and records it)', (await until(`!!document.querySelector('[data-lead-column=engaged] [data-lead="${lead.id}"]')`, 15000)) && (await stageOf(lead.id)) === 'engaged'
    && (await q(`select count(*)::int n from lead_events where lead_id = $1`, [lead.id]))[0].n === 2);
  // Dragging onto Disqualified asks why first; nothing moves until a reason is given.
  await drag(`[data-lead="${raj.id}"]`, '[data-lead-column=disqualified]');
  const asked = await until(`!!document.querySelector('[data-lead-column=disqualified] [data-drop-ask]')`, 8000);
  ok('leads board: dropping on Disqualified asks for the reason before anything moves', asked && (await stageOf(raj.id)) === 'new');
  await fill('[data-drop-ask] input[name=n]', 'Outside our delivery area');
  await ev(`document.querySelector('[data-drop-ask] button[type=submit]').click(),true`);
  ok('leads board: with the reason given the lead is disqualified and the card shows why', (await until(`!!document.querySelector('[data-lead-column=disqualified] [data-lead="${raj.id}"] [data-lead-reason]')`, 15000))
    && /Outside our delivery area/.test(await text(`[data-lead="${raj.id}"] [data-lead-reason]`)) && (await stageOf(raj.id)) === 'disqualified');
  // The same move without a mouse: the card's own Move control. An out-of-date board changes nothing.
  await ev(`document.querySelector('[data-lead="${nave.id}"] details').open = true`);
  await fill(`#move-lead-${nave.id} select[name=stage]`, 'qualified'); await submit(`#move-lead-${nave.id}`);
  ok('leads board: the card\'s Move control does the same without dragging', (await until(`!!document.querySelector('[data-lead-column=qualified] [data-lead="${nave.id}"]')`, 15000)) && (await stageOf(nave.id)) === 'qualified');
  await q(`update leads set stage = 'visited' where id = $1`, [nave.id]);                    // someone else moved it meanwhile
  await drag(`[data-lead="${nave.id}"]`, '[data-lead-column=new]');
  ok('leads board: a board that is out of date moves nothing and says where the lead is now', (await until(`/is now in "Customer visited"/.test(document.querySelector('[data-lead-column=new] [data-drop-said]')?.textContent ?? '')`, 10000)) && (await stageOf(nave.id)) === 'visited');
  // List, search, export.
  await visit('/leads?show=list', '!!document.querySelector("[data-leads-table]")');
  ok('leads list: every lead as a row, with stage views that carry counts', (await count('[data-leads-table] tbody tr')) === 3 && (await list('[data-lead-stages] [data-view]', 'e.dataset.view')).join('|') === 'all|new|engaged|qualified|visited|converted|disqualified');
  await visit('/leads?show=list&stage=disqualified', '!!document.querySelector("[data-leads-table]")');
  ok('leads list: a stage view shows only that stage', (await count('[data-leads-table] tbody tr')) === 1 && (await attr('[data-leads-table] tbody tr', 'data-lead')) === raj.id);
  await visit('/leads?q=90433+19', '!!document.querySelector("[data-lead-board]")');
  ok('leads: search by part of a phone number finds the lead', (await count('[data-lead]')) === 1 && (await exists(`[data-lead="${nave.id}"]`)));
  const csv = await ev(`fetch('/leads/export').then(async r => ({status: r.status, type: r.headers.get('content-type'), rows: r.headers.get('x-export-rows'), body: await r.text()}))`);
  ok('leads: the Excel export is a CSV of every lead (and is recorded)', csv.status === 200 && /text\/csv/.test(csv.type) && csv.rows === '3' && /name,phone,email,interest/.test(csv.body) && /Mahaveer Jain/.test(csv.body) && /Customer visited/.test(csv.body)
    && (await q(`select count(*)::int n from audit_logs where action = 'lead.export'`))[0].n === 1, csv.body?.slice(0, 80));
  await visit(`/leads/${lead.id}`, '!!document.querySelector("[data-entity=lead]")');
  ok('lead page: on the entity frame with its details, a stage control and its history (newest first)', /Mahaveer Jain/.test(await text('[data-entity=lead] h1')) && (await exists('#lead-move-form')) && (await exists('#lead-edit-form'))
    && (await list('[data-lead-history] tbody tr', 'e.dataset.leadEvent')).join('|') === 'engaged|new');
  await fill('#lead-move-form select[name=stage]', 'converted'); await submit('#lead-move-form');
  ok('lead page: moving it to Converted is recorded', (await until(`document.querySelector('[data-entity=lead] [data-lead-stage]')?.dataset.leadStage === 'converted'`, 15000)) && (await stageOf(lead.id)) === 'converted');
  await visit('/leads/conversion', '!!document.querySelector("[data-workspace=leads-conversion]")');
  ok('conversion: three leads added, one converted (33.3%), with what each stage reached and the sources', /3 leads added/.test(await text('[data-workspace=leads-conversion] .eyebrow')) && /33\.3%/.test(await text('[data-conversion-figures]'))
    && (await text('[data-conversion-stages] [data-stage=engaged] [data-reached]')).trim() === '1' && (await text('[data-conversion-stages] [data-stage=converted] [data-now]')).trim() === '1'
    && (await list('[data-conversion-sources] tbody tr', 'e.dataset.source')).sort().join('|') === 'ads|manual|walk_in', await text('[data-conversion-figures]'));

  // ================= super admin: content studio =================
  await visit('/studio', '!!document.querySelector("[data-workspace=studio-ideas]")');
  ok('content studio: R&D on the frame with the views R&D · Planning · Calendar; empty at first', (await modViews('studio')) === '/studio|/studio/planning|/studio/calendar' && (await exists('[data-empty=ideas]'))
    && (await attr('.nav a[aria-current=page]', 'data-module')) === 'studio', await modViews('studio'));
  await openDrawer('new-idea', '#create-idea-form');
  await fill('#create-idea-form input[name=title]', 'Hands off bro'); await fill('#create-idea-form textarea[name=description]', 'Someone grabs the suit bag in a parking area.'); await fill('#create-idea-form input[name=link]', 'http://insecure.example/x');
  await submit('#create-idea-form');
  ok('R&D: a reference link must be https', /https:\/\//.test(await text('#create-idea-form')) && (await q(`select count(*)::int n from content_ideas`))[0].n === 0);
  await fill('#create-idea-form input[name=link]', 'https://www.instagram.com/p/abc'); await submit('#create-idea-form');
  const [idea] = await q(`select id, status from content_ideas`);
  ok('R&D: the idea appears in Exploring with its link shown as the site it points to', idea?.status === 'exploring' && (await until(`!!document.querySelector('[data-idea-column=exploring] [data-idea="${idea.id}"]')`, 15000))
    && (await text(`[data-idea="${idea.id}"] [data-idea-link]`)).trim() === 'instagram.com' && (await attr(`[data-idea="${idea.id}"] [data-idea-link]`, 'rel')) === 'noopener noreferrer');
  await visit('/studio', '!!document.querySelector("[data-idea-board]")');
  await hydrated(`[data-idea="${idea.id}"]`);
  await drag(`[data-idea="${idea.id}"]`, '[data-idea-column=shortlisted]');
  ok('R&D: dragging it to Shortlisted moves it, and only then can it be sent to planning', (await until(`!!document.querySelector('[data-idea-column=shortlisted] #plan-idea-${idea.id}')`, 15000)));
  await submit(`#plan-idea-${idea.id}`);
  const [fromIdea] = await q(`select p.id, p.stage, p.title from content_pieces p join content_ideas i on i.piece_id = p.id where i.id = $1`, [idea.id]);
  ok('R&D: sent to planning once: a piece in the Idea stage, and the idea says where it stands', fromIdea?.stage === 'idea' && fromIdea.title === 'Hands off bro'
    && (await until(`!!document.querySelector('[data-idea="${idea.id}"] [data-idea-planned]') && !document.querySelector('#plan-idea-${idea.id}')`, 15000)));
  await visit('/studio/planning', '!!document.querySelector("[data-piece-board]")');
  ok('planning: six columns Idea → Posted; the new piece says what it still needs', (await list('[data-piece-column]', 'e.dataset.pieceColumn')).join('|') === 'idea|script|shoot|edit|scheduled|posted'
    && /4 left to fill/.test(await text(`[data-piece="${fromIdea.id}"] [data-piece-missing]`)) && !(await exists(`#move-piece-${fromIdea.id}`)));
  await visit(`/studio/planning/${fromIdea.id}`, '!!document.querySelector("#piece-edit-form")');
  ok('piece page: on the entity frame; it lists what is needed before it can move on', /Platform, Format, Owner, Target date/.test(await text('[data-piece-missing]')) && !(await exists('#piece-move-form')));
  const rootId = (await q(`select id from staff_users where email = 'ls.root@test.local'`))[0].id;
  await fill('#piece-edit-form select[name=platform]', 'instagram'); await fill('#piece-edit-form select[name=format]', 'reel'); await fill('#piece-edit-form select[name=ownerId]', rootId);
  await fill('#piece-edit-form input[name=targetOn]', weekDay(1)); await submit('#piece-edit-form');
  ok('piece page: with platform, format, owner and date filled in, the move to Script is offered', await until(`!!document.querySelector('#piece-move-form')`, 15000));
  await submit('#piece-move-form');
  ok('piece page: someone who may approve moves it in one step; Script then needs a hook and a script', (await until(`document.querySelector('[data-entity=piece] [data-piece-stage]')?.dataset.pieceStage === 'script'`, 15000))
    && /Hook, Script/.test(await text('[data-piece-missing]')));

  // ================= manager: works on content, cannot approve =================
  ok('manager signs in', await signIn('manager', 'Studio Manager'));
  await visit('/studio/planning', '!!document.querySelector("[data-drawer-open=new-piece]")');
  await openDrawer('new-piece', '#create-piece-form');
  const managerId = (await q(`select id from staff_users where email = 'ls.manager@test.local'`))[0].id;
  await fill('#create-piece-form input[name=title]', 'Gold sherwani walking reel'); await fill('#create-piece-form select[name=platform]', 'instagram'); await fill('#create-piece-form select[name=format]', 'reel');
  await fill('#create-piece-form select[name=ownerId]', managerId); await fill('#create-piece-form input[name=targetOn]', weekDay(2));
  await submit('#create-piece-form');
  const [piece] = await q(`select id from content_pieces where title = 'Gold sherwani walking reel'`);
  ok('planning (manager): a new piece with everything the Idea stage needs offers "Ask to move to Script"', !!piece && (await until(`!!document.querySelector('#move-piece-${piece?.id}')`, 15000)) && /Ask to move to Script/.test(await text(`#move-piece-${piece.id}`)));
  await submit(`#move-piece-${piece.id}`);
  const pieceRow = async () => (await q(`select stage, requested_stage, to_char(target_on, 'YYYY-MM-DD') target from content_pieces where id = $1`, [piece.id]))[0];
  ok('planning (manager): the move waits for approval; the piece stays in Idea, marked "Needs approval"; the manager is offered no Approve', (await until(`document.querySelector('[data-piece="${piece.id}"]')?.dataset.pieceState === 'waiting'`, 15000))
    && JSON.stringify(await pieceRow()) === JSON.stringify({stage: 'idea', requested_stage: 'script', target: weekDay(2)}) && (await exists(`[data-approval="${piece.id}"]`)) && !(await exists(`#approve-${piece.id}, #card-approve-${piece.id}, #sendback-${piece.id}`)));
  // Calendar: the day changes, the stage does not.
  await visit('/studio/calendar', '!!document.querySelector("[data-content-calendar=week]")');
  ok('calendar: this week as seven days, the piece on its day, and a "No date yet" column', (await count('[data-cal-day]')) === 7 && (await exists(`[data-cal-day="${weekDay(2)}"] [data-piece="${piece.id}"]`)) && (await exists('[data-cal-undated]'))
    && (await attr('.nav a[aria-current=page]', 'data-module')) === 'studio');
  await hydrated(`[data-piece="${piece.id}"]`);
  await drag(`[data-piece="${piece.id}"]`, `[data-cal-day="${weekDay(4)}"]`);
  ok('calendar: dragging the card to another day changes its target date only (still Idea, still waiting for approval)', (await until(`!!document.querySelector('[data-cal-day="${weekDay(4)}"] [data-piece="${piece.id}"]')`, 15000))
    && JSON.stringify(await pieceRow()) === JSON.stringify({stage: 'idea', requested_stage: 'script', target: weekDay(4)}), JSON.stringify(await pieceRow()));
  await drag(`[data-piece="${piece.id}"]`, '[data-cal-undated]');
  ok('calendar: dragging it to "No date yet" removes the date', (await until(`!!document.querySelector('[data-cal-undated] [data-piece="${piece.id}"]')`, 15000)) && (await pieceRow()).target === null);
  await drag(`[data-piece="${piece.id}"]`, `[data-cal-day="${weekDay(3)}"]`);
  await until(`!!document.querySelector('[data-cal-day="${weekDay(3)}"] [data-piece="${piece.id}"]')`, 15000);
  await click('[data-cal-views] [data-view=month]');
  ok('calendar: the month view shows the same piece on the same day (the view is in the address)', (await until(`/view=month/.test(location.search) && document.querySelectorAll('[data-cal-day]').length === 42`, 20000))
    && (await exists(`[data-cal-day="${weekDay(3)}"] [data-piece="${piece.id}"]`)));
  await visit('/leads', '!!document.querySelector("[data-lead-board]")');
  ok('manager: reads and works the leads pipeline too', await exists('[data-drawer-open=new-lead]'));

  // ================= super admin approves =================
  ok('super admin signs in with the password', await login('ls.root@test.local'));
  await visit('/studio/planning', '!!document.querySelector("[data-approvals]")');
  ok('planning (approver): the strip lists the waiting card with who asked, Approve and Send back', /1 card waiting for your approval/.test(await text('[data-approvals] h2')) && /Idea → Script · asked by Studio Manager/.test((await text(`[data-approval="${piece.id}"]`)).replace(/\s+/g, ' '))
    && (await exists(`#approve-${piece.id}`)) && (await exists(`#sendback-${piece.id}`)), await text('[data-approvals]'));
  await submit(`#approve-${piece.id}`);
  ok('planning (approver): approving moves the piece to Script and clears the strip', (await until(`!!document.querySelector('[data-piece-column=script] [data-piece="${piece.id}"]') && !document.querySelector('[data-approvals]')`, 15000))
    && (await pieceRow()).stage === 'script' && (await pieceRow()).requested_stage === null);

  // ================= a provider refund that stayed pending (Payment tab) =================
  const [buyer] = await q(`insert into customers (email, full_name, email_verified_at) values ('ls.buyer@test.local', 'Settle Buyer', now()) returning id`);
  const [ord] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-SETTLE-1', $1, 'delivered', 'paid', 80000, 80000, '{}', '{}') returning id`, [buyer.id]);
  const [item] = await q(`insert into order_items (order_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1, 'SETTLE-1', 'Settle test piece', 'M', 80000, 1, 80000) returning id`, [ord.id]);
  const [pay] = await q(`insert into payments (order_id, provider, provider_payment_id, amount_paise, status, captured_at) values ($1, 'offline', 'settle-pay-1', 80000, 'captured', now()) returning id`, [ord.id]);
  const [ret] = await q(`insert into return_requests (order_id, customer_id, status, resolution, reason_code, received_at, inspection_result) values ($1, $2, 'refund_pending', 'refund', 'size_fit', now(), 'ok') returning id`, [ord.id, buyer.id]);
  await q(`insert into return_items (return_id, order_item_id, qty) values ($1, $2, 1)`, [ret.id, item.id]);
  const stuck = async minutes => (await q(`insert into refunds (payment_id, order_id, return_id, amount_paise, reason, status, method, requested_by, created_at) values ($1, $2, $3, 30000, 'Return refund', 'pending', 'provider', $4, now() - make_interval(mins => $5)) returning id`,
    [pay.id, ord.id, ret.id, rootId, minutes]))[0].id;
  const refundId = await stuck(45);
  const refundState = async id => (await q(`select f.status, (select status from return_requests where id = $2) ret, (select payment_status from orders where id = $3) paid from refunds f where f.id = $1`, [id, ret.id, ord.id]))[0];
  await visit(`/orders/${ord.id}?tab=payment`, '!!document.querySelector("[data-refunds-table]")');
  ok('payment tab: a provider refund that stayed pending offers "Settle…"', (await exists(`[data-settle-refund="${refundId}"]`)) && (await attr('[data-refunds-table] tbody tr', 'data-refund')) === 'pending');
  await ev(`document.querySelector('[data-settle-refund="${refundId}"]').open = true`);
  await autoConfirm();
  await fill(`#settle-refund-${refundId} select[name=outcome]`, 'processed'); await fill(`#settle-refund-${refundId} input[name=note]`, 'Seen in the dashboard');
  await submit(`#settle-refund-${refundId}`);
  ok('payment tab: "Refunded" without the provider\'s refund id is refused; nothing changes', /refund id/i.test(await text(`#settle-refund-${refundId}`)) && (await refundState(refundId)).status === 'pending', await text(`#settle-refund-${refundId}`));
  await fill(`#settle-refund-${refundId} select[name=outcome]`, 'failed'); await fill(`#settle-refund-${refundId} input[name=note]`, 'Provider shows no refund');
  await submit(`#settle-refund-${refundId}`);
  ok('payment tab: settled as not refunded: the refund is failed, the return still waits, nothing was refunded, and the control is gone', (await until(`!document.querySelector('[data-settle-refund="${refundId}"]')`, 15000))
    && JSON.stringify(await refundState(refundId)) === JSON.stringify({status: 'failed', ret: 'refund_pending', paid: 'paid'}) && /Provider shows no refund/.test(await text('[data-refunds-table]')), JSON.stringify(await refundState(refundId)));
  const refund2 = await stuck(30);
  await visit(`/orders/${ord.id}?tab=payment`, `!!document.querySelector('[data-settle-refund="${refund2}"]')`);
  await ev(`document.querySelector('[data-settle-refund="${refund2}"]').open = true`);
  await autoConfirm();
  await fill(`#settle-refund-${refund2} select[name=outcome]`, 'processed'); await fill(`#settle-refund-${refund2} input[name=reference]`, 'rfnd_e2e_0001'); await fill(`#settle-refund-${refund2} input[name=note]`, 'Refunded on the provider side');
  await submit(`#settle-refund-${refund2}`);
  ok('payment tab: settled as refunded with the provider\'s id: refund processed, return refunded, order partly refunded, audited with the staff member', (await until(`!document.querySelector('[data-settle-refund="${refund2}"]')`, 15000))
    && JSON.stringify(await refundState(refund2)) === JSON.stringify({status: 'processed', ret: 'refunded', paid: 'partially_refunded'})
    && (await q(`select count(*)::int n from audit_logs a join staff_users s on s.id = a.staff_id where a.action = 'refund.settle_pending' and s.email = 'ls.root@test.local'`))[0].n === 2, JSON.stringify(await refundState(refund2)));
  const fresh = await stuck(1);
  await q(`update return_requests set status = 'refund_pending' where id = $1`, [ret.id]);
  await visit(`/orders/${ord.id}?tab=payment`, `!!document.querySelector('[data-settle-refund="${fresh}"]')`);
  await ev(`document.querySelector('[data-settle-refund="${fresh}"]').open = true`);
  await autoConfirm();
  await fill(`#settle-refund-${fresh} select[name=outcome]`, 'failed'); await fill(`#settle-refund-${fresh} input[name=note]`, 'Too early'); await submit(`#settle-refund-${fresh}`);
  ok('payment tab: a refund asked for a minute ago cannot be settled yet (it may still be on its way)', /less than 10 minutes ago/.test(await message(`#settle-refund-${fresh}`)) && (await refundState(fresh)).status === 'pending', await message(`#settle-refund-${fresh}`));

  // ================= nothing here touches stock or orders (the settle fixture is the one order and customer added) =================
  const stock1 = (await q(`select (select count(*)::int from inventory_movements) moves, (select coalesce(sum(stock_qty),0)::int from product_variants) units, (select count(*)::int from orders) orders, (select count(*)::int from customers) customers`))[0];
  ok('leads and content studio moved no stock and created no order or customer (the refund fixture added one of each)', stock1.moves === stock0.moves && stock1.units === stock0.units && stock1.orders === stock0.orders + 1 && stock1.customers === stock0.customers + 1, JSON.stringify({stock0, stock1}));

  // ================= sales: leads only; support: neither =================
  ok('sales signs in', await signIn('sales', 'Studio Sales'));
  const salesMods = await navModules();
  ok('sales: the sidebar has Leads and not Content studio', salesMods.includes('leads') && !salesMods.includes('studio'), salesMods.join());
  await visit('/leads', '!!document.querySelector("[data-lead-board]")');
  ok('sales: works the leads board', (await exists('[data-drawer-open=new-lead]')) && (await count('[data-lead]')) === 3);
  const salesGates = [];
  for (const p of ['/studio', '/studio/planning', `/studio/planning/${piece.id}`, '/studio/calendar']) { await visit(p); salesGates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-idea-board],[data-piece-board],[data-content-calendar],[data-entity]'))); }
  ok('sales: no content studio page is served', salesGates.every(Boolean), salesGates.join());
  ok('support signs in', await signIn('support', 'Studio Support'));
  const supMods = await navModules();
  const supGates = [];
  for (const p of ['/leads', '/leads?show=list', `/leads/${lead.id}`, '/leads/conversion', '/studio', '/studio/planning', '/studio/calendar']) { await visit(p); supGates.push((await exists('[data-gate=forbidden]')) && !(await exists('[data-lead-board],[data-leads-table],[data-entity],[data-conversion-figures],[data-idea-board],[data-piece-board],[data-content-calendar]'))); }
  const supCsv = await ev(`fetch('/leads/export').then(r => r.status)`);
  ok('support: neither module is in the sidebar, no page is served and the export is refused', !supMods.includes('leads') && !supMods.includes('studio') && supGates.every(Boolean) && supCsv === 403, supGates.join() + ' export ' + supCsv);

  // ================= phone width =================
  if (await login('ls.root@test.local')) {
    await b.viewport(390, 844, true);
    const wide = [];
    for (const p of ['/leads', '/leads?show=list', `/leads/${lead.id}`, '/leads/conversion', '/studio', '/studio/planning', `/studio/planning/${piece.id}`, '/studio/calendar', '/studio/calendar?view=month']) { await visit(p); if (!(await noOverflow())) wide.push(p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')); }
    ok('390px: no sideways page scroll on any leads or content studio page', wide.length === 0, wide.join(', '));
    await visit('/leads', '!!document.querySelector("[data-lead-board]")');
    ok('390px leads: the columns stack and every card fits the screen', await ev(`(()=>{const cols=[...document.querySelectorAll('[data-lead-column]')];return cols.every((c,i)=>i===0||c.getBoundingClientRect().top>cols[i-1].getBoundingClientRect().top) && [...document.querySelectorAll('[data-lead]')].every(c=>c.getBoundingClientRect().right<=innerWidth+1)})()`));
    await b.shot('ls-390-leads.png');
    await visit('/studio/calendar', '!!document.querySelector("[data-content-calendar]")'); await b.shot('ls-390-calendar.png');
    await b.viewport(1440, 900);
    await visit('/leads', '!!document.querySelector("[data-lead-board]")'); await b.shot('ls-leads.png');
    await visit('/studio', '!!document.querySelector("[data-idea-board]")'); await b.shot('ls-ideas.png');
    await visit('/studio/planning', '!!document.querySelector("[data-piece-board]")'); await b.shot('ls-planning.png');
    await visit('/studio/calendar', '!!document.querySelector("[data-content-calendar]")'); await b.shot('ls-calendar.png');
  } else ok('super admin signs in with the password (phone width)', false);
  ok('no page errors during the run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('run completed', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

console.log(out.join('\n'));
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
