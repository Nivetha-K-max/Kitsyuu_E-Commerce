/* The store's help window (2026-10-12): browser tests. Started by tests/run-account.mjs (ONLY=help runs just this file)
   with BASE (the store on a LOCAL test database, no request limits), LIMIT_BASE (the same store with request limits
   counted in a local fake Redis and the "a limiter is required" rule on), HELP_STRICT_BASE (that rule on, NO limiter), SERVER_LOG and KITSYUU_DB_URL (owner connection to the LOCAL test database, for the
   fixtures and checks). Never touches a hosted database. The orders here are rows written for the test. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from './cdp.mjs';

const {BASE, LIMIT_BASE, LIMIT_DOWN_BASE, HELP_STRICT_BASE, SERVER_LOG, KITSYUU_DB_URL} = process.env;
if (!/@localhost[:/]/.test(KITSYUU_DB_URL || '')) throw new Error('help tests only run against a local database');
const out = []; const ok = (n, p, x = '') => { const l = `${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`; out.push(l); console.log(l); };
const w = ms => new Promise(r => setTimeout(r, ms));
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const PW = 'correct horse battery staple';

const b = await launch(9444); const ev = e => b.eval(e);
const until = async (x, ms = 15000) => { for (let t = 0; t < ms; t += 120) { try { if (await ev(x)) return true; } catch {} await w(120); } return false; };
const READY = 'document.readyState === "complete" && !!document.querySelector("main")';
const go = async (p, base = BASE, ready = READY) => { await b.goto(base + p, ready); };
/** Sets a field the way typing or choosing does (inputs, selects and text areas). */
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel}');
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async sel => { await until(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return !!e && Object.keys(e).some(k=>k.startsWith('__reactProps'))})()`, 20000); await ev(`document.querySelector(${JSON.stringify(sel)}).click(),true`); };
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', {type, key: k, code, windowsVirtualKeyCode: vk}); await w(80); };
const openHelp = async () => { await click('[data-help-open]'); return until(`!!document.querySelector('[data-help-panel]') && !!document.querySelector('[data-help-topics] [data-help-topic]')`, 15000); };
const tab = async id => { await click(`[data-help-tab=${id}]`); return until(`document.querySelector('[data-help-view]')?.dataset.helpView === '${id}'`); };
const asked = () => ev(`performance.getEntriesByType('resource').some(r => r.name.includes('/api/help'))`);
/** Looks an order up in the open window and returns what the window then says. */
const lookup = async (orderNumber, contact) => {
  await ev(`document.querySelector('[data-help-order-result]')?.setAttribute('data-old','1'),true`);
  await fill('[data-help-order-form] [name=orderNumber]', orderNumber); await fill('[data-help-order-form] [name=contact]', contact);
  await click('[data-help-order-form] button[type=submit]');
  await until(`!!document.querySelector('[data-help-order-result]:not([data-old])')`, 15000);
  return {state: await ev(`document.querySelector('[data-help-order-result]')?.dataset.helpOrderResult ?? ''`), text: await text('[data-help-order-result]')};
};
const message = async fields => {
  for (const [name, v] of Object.entries(fields)) await fill(`[data-help-message-form] [name=${name}]`, v);
  await click('[data-help-message-form] button[type=submit]');
  await until(`!!document.querySelector('[data-help-sent],[data-help-message-error]')`, 15000);
  return {sent: await text('[data-help-sent]'), error: await text('[data-help-message-error]')};
};
const lastLink = to => {
  const log = fs.readFileSync(SERVER_LOG, 'utf8'), start = log.lastIndexOf(`[mail:begin] to=${to} `);
  if (start < 0) return null;
  return log.slice(start, log.indexOf('[mail:end]', start)).match(/https?:\/\/\S+token=[A-Za-z0-9_-]{43}/)?.[0] ?? null;
};
const tickets = async () => (await q(`select count(*)::int n from support_tickets`))[0].n;

try {
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  // Fixtures in the LOCAL test database: one customer's shipped order with tracking, and another person's order.
  const [buyer] = await q(`insert into customers (email, full_name, email_verified_at) values ('help.buyer@test.local', 'Help Buyer', now()) returning id`);
  const [order] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address)
    values ('KTS-HELP-0001', $1, 'shipped', 'paid', 349900, 349900, '{"name":"Meera Pillai","email":"meera.orders@example.com","phone":"+91 90000 12345"}', '{"line1":"7 Hill View","city":"Munnar","pin":"685612"}') returning id`, [buyer.id]);
  await q(`insert into shipments (order_id, carrier_code, tracking_number, shipped_at) values ($1, 'manual', 'TRK-HELP-42', now())`, [order.id]);
  await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address) values ('KTS-HELP-0002', $1, 'paid', 'paid', 100, 100, '{"email":"someone.else@example.com","phone":"9111111111"}', '{}')`, [buyer.id]);
  const [cat] = await q(`select code, label from support_categories where is_active order by sort_order limit 1`);

  // ---------- the button, and nothing until it is used ----------
  await go('/shop');
  ok('store: a Help button is offered; the window is closed and the server has not been asked for anything', (await until(`!!document.querySelector('[data-help-open]')`)) && !(await exists('[data-help-panel]')) && !(await asked()));
  ok('the Help button carries a robot picture next to the word Help (decorative for screen readers)', (await ev(`(()=>{const b=document.querySelector('[data-help-open]'),s=b.querySelector('svg[data-help-bot]');return !!s && s.getAttribute('aria-hidden')==='true' && b.textContent.trim()==='Help' && s.getBoundingClientRect().width>=16})()`)));
  await go('/');
  const before = await exists('[data-help-open]');
  await ev(`(()=>{const s=document.getElementById('store');if(s)s.scrollIntoView();else scrollTo(0,Math.max(900,innerHeight));dispatchEvent(new Event('scroll'));return true})()`);
  ok('home page: the Help button stays out of the landing film and appears once the visitor is in the store', !before && (await until(`!!document.querySelector('[data-help-open]')`, 8000)));
  await go('/checkout', BASE, 'document.readyState === "complete"');
  if ((await ev('location.pathname')) === '/checkout') ok('checkout: no Help button sits over paying', !(await exists('[data-help-open]')));

  // ---------- help topics ----------
  await go('/shop');
  ok('opening: the window is a labelled dialog listing the six help topics, and only now asks the server', (await openHelp()) && (await asked())
    && (await ev(`(()=>{const p=document.querySelector('[data-help-panel]');return p.getAttribute('role')==='dialog' && !!document.getElementById(p.getAttribute('aria-labelledby')) && !!document.getElementById(p.getAttribute('aria-describedby'))})()`))
    && (await ev(`[...document.querySelectorAll('[data-help-topic]')].map(e=>e.dataset.helpTopic).join('|')`)) === 'order-status|returns|change-order|delivery-charge|sizes|contact');
  const panelText = await text('[data-help-panel]');
  ok('it says what it is: automated answers, not a live chat; nothing claims to be an AI, an assistant or a person', /Automated answers from our help topics\. This is not a live chat/.test(await text('[data-help-notice]'))
    && !/\b(AI|artificial intelligence|assistant|chatbot|bot|agent is typing|online now)\b/i.test(panelText), panelText.slice(0, 160));
  ok('focus moves into the window when it opens', await ev(`document.querySelector('[data-help-panel]').contains(document.activeElement)`));
  ok('returns answer is the business\'s own rule (returns are off: all sales are final)', /All sales are final/.test(await ev(`document.querySelector('[data-help-topic=returns] details p').textContent`)));
  await fill('[data-help-ask] [name=q]', 'Where is my order? It has not arrived'); await click('[data-help-ask] button[type=submit]');
  ok('a typed question is matched to the topic about order status, opened with its answer and a way to check an order', (await until(`!!document.querySelector('[data-help-matched]')`))
    && (await ev(`[...document.querySelectorAll('[data-help-topic]')].map(e=>e.dataset.helpTopic).join('|')`)) === 'order-status' && (await ev(`document.querySelector('[data-help-topic=order-status] details').open`)) && (await exists('[data-help-go=order]')));
  await fill('[data-help-ask] [name=q]', 'zzzz qqqq'); await click('[data-help-ask] button[type=submit]');
  ok('a question no topic covers says so and offers a message to the team (no made-up answer)', (await until(`!!document.querySelector('[data-help-nomatch]')`)) && /No help topic matches/.test(await text('[data-help-nomatch]')) && !(await exists('[data-help-topic]')));
  await key('Escape', 'Escape', 27);
  ok('Escape closes the window and focus returns to the Help button', (await until(`!document.querySelector('[data-help-panel]') && document.activeElement === document.querySelector('[data-help-open]')`, 5000)));

  // ---------- order status for a guest ----------
  await openHelp(); await tab('order');
  const wrongContact = await lookup('KTS-HELP-0001', 'not.me@example.com');
  const wrongNumber = await lookup('KTS-HELP-9999', 'meera.orders@example.com');
  ok('order status: a wrong contact and a wrong order number are refused with exactly the same words', wrongContact.state === 'refused' && wrongNumber.state === 'refused' && wrongContact.text === wrongNumber.text && /could not find an order with that number and contact/.test(wrongContact.text), wrongContact.text);
  const others = await lookup('KTS-HELP-0002', 'meera.orders@example.com');
  ok('order status: another person\'s order is not shown for this contact', others.state === 'refused' && others.text === wrongContact.text);
  const bad = await lookup('KTS-HELP-0001', '12345');
  ok('order status: something that is neither an email nor a phone number is asked for again', bad.state === 'refused' && /email address or the 10-digit phone number/.test(bad.text));
  const found = await lookup('kts-help-0001', 'Meera.Orders@Example.com');
  ok('order status: the order number with the email it was placed with shows status and tracking', found.state === 'found' && (await text('[data-help-order-status]')).trim() === 'Shipped' && (await text('[data-help-order-number]')).trim() === 'KTS-HELP-0001'
    && /TRK-HELP-42/.test(await text('[data-help-order-tracking]')), found.text);
  ok('order status: nothing personal is shown (no name, address, phone, email or amount)', !/Meera|Pillai|Hill View|Munnar|685612|90000|12345|example\.com|3,?499/.test(found.text), found.text);
  const byPhone = await lookup('KTS-HELP-0001', '090000 12345');
  ok('order status: the phone number the order was placed with works too, however it is typed', byPhone.state === 'found');

  // ---------- a message from a guest ----------
  await tab('message');
  ok('message (guest): asks for a name and an email to reply to', (await exists('[data-help-message-form] [name=name]')) && (await exists('[data-help-message-form] [name=email]')));
  const t0 = await tickets();
  const m1 = await message({name: 'Meera Pillai', email: 'meera.orders@example.com', categoryCode: cat.code, subject: 'Parcel not here yet', orderNumber: 'KTS-HELP-0001', body: 'It was due yesterday. Can you check?'});
  const number = m1.sent.match(/TCK-[A-Z0-9]{8}/)?.[0];
  const [row] = await q(`select t.customer_id, t.contact_email, t.contact_name, t.order_id, t.status, t.channel, (select body from support_messages where ticket_id = t.id) body from support_tickets t where t.number = $1`, [number ?? '']);
  ok('message (guest): sent as a support ticket with no account, linked to the order placed with that email; the reply is promised by email', !!number && /We reply by email to meera\.orders@example\.com/.test(m1.sent)
    && row?.customer_id === null && row.contact_email === 'meera.orders@example.com' && row.order_id === order.id && row.status === 'open' && row.channel === 'store' && row.body === 'It was due yesterday. Can you check?', m1.sent || m1.error);
  await click('[data-help-sent] ~ button');
  await until(`!!document.querySelector('[data-help-message-form]')`);
  const m2 = await message({name: 'Stranger', email: 'stranger@example.com', categoryCode: cat.code, subject: 'About an order', orderNumber: 'KTS-HELP-0001', body: 'Tell me about this order.'});
  const [row2] = await q(`select order_id, (select body from support_messages where ticket_id = t.id) body from support_tickets t where t.number = $1`, [m2.sent.match(/TCK-[A-Z0-9]{8}/)?.[0] ?? '']);
  ok('message (guest): someone else\'s order number is not linked, the form answers the same, and staff are told it was not matched', /Your message has been sent/.test(m2.sent) && row2?.order_id === null && /not matched to this email/.test(row2.body), m2.sent || m2.error);
  await click('[data-help-sent] ~ button');
  await until(`!!document.querySelector('[data-help-message-form]')`);
  const t1 = await tickets();
  await fill('[data-help-message-form] [name=website]', 'http://spam.example');
  const m3 = await message({name: 'Bot', email: 'bot@example.com', categoryCode: cat.code, subject: 'Buy now', body: 'Spam.'});
  ok('message: a form that fills the hidden field is answered politely and nothing is stored', /has been sent/.test(m3.sent) && !/TCK-/.test(m3.sent) && (await tickets()) === t1 && t1 === t0 + 2);

  // ---------- a signed-in customer ----------
  const email = 'help.e2e@test.local';
  await go('/signup', BASE, '!!document.querySelector("main [name=email]")');
  await fill('main [name=fullName]', 'Help Customer'); await fill('main [name=email]', email); await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
  await click('main form:not(:has([data-logout])) button[type=submit]');
  let link = null; for (let i = 0; i < 80 && !(link = lastLink(email)); i++) await w(250);
  await b.goto(link, 'document.readyState === "complete"');
  ok('a new customer signs up and confirms their email', await until(`location.pathname === '/account'`));
  const [me] = await q(`select id from customers where email = $1`, [email]);
  await go('/shop'); await openHelp(); await tab('message');
  ok('message (signed in): the name and email are not asked for again', !(await exists('[data-help-message-form] [name=name]')) && !(await exists('[data-help-message-form] [name=email]')));
  const m4 = await message({categoryCode: cat.code, subject: 'Size advice', body: 'Between M and L, which one?'});
  const [row4] = await q(`select customer_id, contact_email from support_tickets where number = $1`, [m4.sent.match(/TCK-[A-Z0-9]{8}/)?.[0] ?? '']);
  ok('message (signed in): the ticket is the customer\'s own and can be followed in their account', row4?.customer_id === me.id && row4.contact_email === email && /My account → Support/.test(m4.sent), m4.sent || m4.error);
  await go('/account/support');
  ok('the customer\'s account lists that ticket', /Size advice/.test(await text('main')));

  // ---------- phone width ----------
  await b.viewport(390, 844, true);
  await go('/shop'); await openHelp();
  ok('390px: the window fits the screen and the page does not scroll sideways', await ev(`(()=>{const r=document.querySelector('[data-help-panel]').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1})()`));
  await tab('message');
  ok('390px: every field and button is at least 44px tall (touch) and inside the window', await ev(`(()=>{const p=document.querySelector('[data-help-panel]').getBoundingClientRect();return [...document.querySelectorAll('[data-help-message-form] :is(input:not([name=website]),select,textarea,button)')].every(e=>{const r=e.getBoundingClientRect();return r.height>=44 && r.left>=p.left && r.right<=p.right+1})})()`));
  await b.shot('help-390.png');
  await b.viewport(1440, 900);
  await go('/shop'); await openHelp(); await b.shot('help.png');

  // ---------- the window could not load its content: it says so, offers no unusable form, and can try again (2026-10-12) ----------
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  await go('/shop');
  // The first request for the window's content fails (as when the connection drops); later ones go through.
  await ev(`(()=>{const real=window.fetch;let failedOnce=false;window.fetch=(...a)=>{if(String(a[0]).includes('/api/help')&&!failedOnce){failedOnce=true;return Promise.reject(new TypeError('Failed to fetch'));}return real(...a);};return true})()`);
  await click('[data-help-open]');
  ok('could not load: the window says so and offers "Try again"', (await until(`!!document.querySelector('[data-help-unavailable] [data-help-retry]')`, 10000)) && /could not be loaded/.test(await text('[data-help-unavailable]')) && !(await exists('[data-help-topic]')));
  await tab('message');
  ok('could not load: no message form is offered while its topics are missing (nothing that cannot be sent)', !(await exists('[data-help-message-form]')) && (await exists('[data-help-retry]')));
  await tab('order');
  ok('could not load: no order form is offered either', !(await exists('[data-help-order-form]')));
  await click('[data-help-retry]');
  await tab('message');
  ok('could not load: "Try again" loads it; the message form then has its topics and can be sent', (await until(`document.querySelectorAll('[data-help-message-form] select[name=categoryCode] option').length > 1 && !document.querySelector('[data-help-unavailable]')`, 12000))
    && (await ev(`!document.querySelector('[data-help-message-form] button[type=submit]').disabled`)));
  await tab('topics');
  ok('could not load: after trying again the six help topics are there', (await ev(`document.querySelectorAll('[data-help-topic]').length`)) === 6);
  // Closing and opening again also tries again by itself.
  await go('/shop');
  await ev(`(()=>{const real=window.fetch;let failedOnce=false;window.fetch=(...a)=>{if(String(a[0]).includes('/api/help')&&!failedOnce){failedOnce=true;return Promise.reject(new TypeError('Failed to fetch'));}return real(...a);};return true})()`);
  await click('[data-help-open]');
  await until(`!!document.querySelector('[data-help-unavailable]')`, 10000);
  await key('Escape', 'Escape', 27); await until(`!document.querySelector('[data-help-panel]')`, 5000);
  await click('[data-help-open]');
  ok('could not load: opening the window again tries again without being asked', await until(`document.querySelectorAll('[data-help-topic]').length === 6 && !document.querySelector('[data-help-unavailable]')`, 12000));

  // ---------- the robot mascot: a second way to the same window (2026-10-12) ----------
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  const freshVisit = () => ev(`(()=>{try{sessionStorage.clear()}catch{}return true})()`);
  const panels = () => ev(`document.querySelectorAll('[data-help-panel]').length`);
  await freshVisit(); await go('/shop');
  await until(`!!document.querySelector('[data-help-robot] [data-help-bubble]')`, 8000);
  ok('mascot: a robot button named "Open customer support" stands above the Help button, saying exactly "Need help?"; its drawing is hidden from screen readers', await ev(`(()=>{const r=document.querySelector('[data-help-robot]'),h=document.querySelector('[data-help-open]'),s=r?.querySelector('svg');
    if(!r||!h||!s)return false;const a=r.getBoundingClientRect(),c=h.getBoundingClientRect();
    return r.tagName==='BUTTON' && r.getAttribute('aria-label')==='Open customer support' && r.querySelector('[data-help-bubble]').textContent==='Need help?' && r.querySelector('[data-help-bubble]').getAttribute('aria-hidden')==='true'
      && s.getAttribute('aria-hidden')==='true' && a.bottom<=c.top+1 && r.closest('[data-help-trigger]')===h.closest('[data-help-trigger]') && h.textContent.trim()==='Help'})()`));
  ok('mascot: it is drawn in the page (inline, no image request) and nothing is asked of the server by showing it', (await ev(`!!document.querySelector('[data-help-robot] svg ellipse') && !document.querySelector('[data-help-robot] img') && !performance.getEntriesByType('resource').some(r=>['.gif','.png','.webp','.mp4'].some(x=>r.name.split('?')[0].endsWith(x)) && ['robot','mascot'].some(x=>r.name.toLowerCase().includes(x)))`)) && !(await asked()));
  await click('[data-help-robot]');
  ok('mascot: clicking the robot opens the help window; while it is open the robot, the bubble and the Help button are not in the page', (await until(`!!document.querySelector('[data-help-panel]') && !!document.querySelector('[data-help-topics] [data-help-topic]')`, 15000))
    && (await panels()) === 1 && !(await exists('[data-help-robot],[data-help-bubble],[data-help-open]')));
  await key('Escape', 'Escape', 27);
  ok('mascot: closing brings the robot and the Help button back, and the bubble does not return in this visit', (await until(`!document.querySelector('[data-help-panel]') && !!document.querySelector('[data-help-robot]')`, 5000))
    && !(await exists('[data-help-bubble]')) && (await exists('[data-help-open]')));
  await click('[data-help-open]');
  ok('mascot: the Help button opens the same single window (the topics are already there, no second panel)', (await until(`!!document.querySelector('[data-help-panel] [data-help-topic]')`, 10000)) && (await panels()) === 1);
  await key('Escape', 'Escape', 27); await until(`!document.querySelector('[data-help-panel]')`, 5000);
  // Clicking twice quickly: one window, and nothing is submitted by opening it.
  const tk0 = await tickets();
  await ev(`(()=>{const r=document.querySelector('[data-help-robot]');r.click();r.click();document.querySelector('[data-help-open]')?.click();return true})()`);
  await until(`!!document.querySelector('[data-help-panel]')`, 10000); await w(400);
  ok('mascot: repeated clicks open one window and send nothing', (await panels()) === 1 && (await tickets()) === tk0);
  await key('Escape', 'Escape', 27); await until(`!document.querySelector('[data-help-panel]')`, 5000);
  // Keyboard: Enter and Space on the robot, with a visible focus ring.
  const press = async (k, code, vk, typed) => { await b.send('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: typed, unmodifiedText: typed}); await b.send('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk}); await w(80); };
  await key('Tab', 'Tab', 9);
  await ev(`document.querySelector('[data-help-robot]').focus(),true`);
  ok('mascot: keyboard focus on the robot is visible', await ev(`(()=>{const r=document.querySelector('[data-help-robot]'),s=getComputedStyle(r);return document.activeElement===r && r.matches(':focus-visible') && s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>=2})()`));
  await press('Enter', 'Enter', 13, '\r');
  const byEnter = await until(`!!document.querySelector('[data-help-panel]')`, 8000);
  await key('Escape', 'Escape', 27); await until(`!document.querySelector('[data-help-panel]')`, 5000);
  await ev(`document.querySelector('[data-help-robot]').focus(),true`);
  await press(' ', 'Space', 32, ' ');
  const bySpace = await until(`!!document.querySelector('[data-help-panel]')`, 8000);
  ok('mascot: Enter and Space on the robot open the help window', byEnter && bySpace && (await panels()) === 1);
  await key('Escape', 'Escape', 27); await until(`!document.querySelector('[data-help-panel]')`, 5000);
  ok('mascot: it moves gently (float, wave, blink) when motion is allowed', await ev(`['.st-help-mascot-body','.st-help-mascot-arm','.st-help-mascot-eyes'].every(s=>getComputedStyle(document.querySelector(s)).animationName!=='none')`));
  await b.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await freshVisit(); await go('/shop'); await until(`!!document.querySelector('[data-help-robot]')`, 8000);
  ok('mascot: with reduced motion nothing moves', await ev(`['.st-help-mascot-body','.st-help-mascot-arm','.st-help-mascot-eyes'].every(s=>getComputedStyle(document.querySelector(s)).animationName==='none')`));
  await b.send('Emulation.setEmulatedMedia', {features: []});
  await go('/cart', BASE, 'document.readyState === "complete"');
  if ((await ev('location.pathname')) === '/cart') ok('mascot: on the cart page only the Help button is shown, so nothing sits over the way to checkout', (await until(`!!document.querySelector('[data-help-open]')`, 8000)) && !(await exists('[data-help-robot]')));
  await b.viewport(390, 844, true);
  await freshVisit(); await go('/shop'); await until(`!!document.querySelector('[data-help-robot] [data-help-bubble]')`, 8000);
  ok('mascot at 390px: robot, bubble and Help button are inside the screen, the robot is a comfortable target, and the page does not scroll sideways', await ev(`(()=>{const inside=e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1};
    const r=document.querySelector('[data-help-robot]'),box=r.getBoundingClientRect();
    return inside(r)&&inside(document.querySelector('[data-help-bubble]'))&&inside(document.querySelector('[data-help-open]'))&&box.width>=44&&box.height>=44&&document.documentElement.scrollWidth<=innerWidth+1})()`));
  await b.shot('help-mascot-390.png');
  await click('[data-help-robot]');
  ok('mascot at 390px: the robot opens the window, which fits the screen with the robot out of its way', (await until(`!!document.querySelector('[data-help-panel]')`, 10000)) && !(await exists('[data-help-robot]'))
    && (await ev(`(()=>{const r=document.querySelector('[data-help-panel]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`)));
  await b.viewport(1440, 900);
  await freshVisit(); await go('/shop'); await until(`!!document.querySelector('[data-help-robot] [data-help-bubble]')`, 8000); await b.shot('help-mascot.png');

  // ---------- no rate limiter where one is required: the guest features are closed by the server (2026-10-12) ----------
  // HELP_STRICT_BASE is the same store with the production rule switched on and NO limiter configured.
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  const helpApi = base => ev(`fetch(${JSON.stringify(base + '/api/help')}, {cache: 'no-store'}).then(r => r.json()).then(d => ({guest: d.guest, signedIn: d.signedIn, topics: d.topics.length}))`);
  await go('/shop', HELP_STRICT_BASE);
  const strictApi = await helpApi(HELP_STRICT_BASE);
  ok('no limiter: the server says the guest features are closed, and still serves the help topics', strictApi.guest === false && strictApi.signedIn === false && strictApi.topics === 6, JSON.stringify(strictApi));
  await openHelp();
  await fill('[data-help-ask] [name=q]', 'where is my order'); await click('[data-help-ask] button[type=submit]');
  ok('no limiter: help topics and the topic search work as before', (await until(`!!document.querySelector('[data-help-matched]')`)) && (await exists('[data-help-topic=order-status]')));
  await tab('order');
  ok('no limiter: "Check an order" offers no form; it says so and points to signing in', (await exists('[data-help-order-closed]')) && !(await exists('[data-help-order-form]')) && /not available right now/.test(await text('[data-help-order-closed]'))
    && (await ev(`document.querySelector('[data-help-order-closed] a')?.getAttribute('href')`)) === '/login');
  await tab('message');
  ok('no limiter: a guest is offered no message form; they are asked to sign in or create an account', (await exists('[data-help-message-closed]')) && !(await exists('[data-help-message-form]')));
  // A request sent straight to the server, as if the page had offered the forms: the answer the page gets from /api/help
  // is changed in the browser to say "open", so the real forms appear and post to the real server actions.
  await go('/shop', HELP_STRICT_BASE);
  await ev(`(()=>{const real=window.fetch;window.fetch=async(...a)=>{const r=await real(...a);if(String(a[0]).includes('/api/help')){const d=await r.json();return new Response(JSON.stringify({...d,guest:true}),{status:200,headers:{'Content-Type':'application/json'}});}return r;};return true})()`);
  await openHelp(); await tab('order');
  ok('bypass: with the page told otherwise, the lookup form appears', await exists('[data-help-order-form]'));
  const forced = await lookup('KTS-HELP-0002', 'someone.else@example.com');
  ok('bypass: the server refuses the lookup itself, even with the right order number and contact, and reveals nothing', forced.state === 'refused' && /not available right now\. Sign in to see your orders/.test(forced.text) && !/Confirmed|Shipped|could not find/.test(forced.text), forced.text);
  await tab('message');
  const t3 = await tickets();
  const forcedMsg = await message({name: 'Guest', email: 'direct@example.com', categoryCode: cat.code, subject: 'Direct request', body: 'Sent past the page.'});
  ok('bypass: the server refuses a guest\'s message itself and stores nothing', /Please sign in to send us a message/.test(forcedMsg.error) && !forcedMsg.sent && (await tickets()) === t3, JSON.stringify(forcedMsg));
  // A signed-in customer is not affected: their own message goes through; the order lookup stays closed for everyone.
  await go('/login', HELP_STRICT_BASE, '!!document.querySelector("main [name=email]")');
  await fill('main [name=email]', email); await fill('main [name=password]', PW);
  await click('main form:not(:has([data-logout])) button[type=submit]');
  const inStrict = await until(`location.pathname.startsWith('/account')`, 20000);
  await go('/shop', HELP_STRICT_BASE);
  const signedApi = await helpApi(HELP_STRICT_BASE);
  await openHelp(); await tab('message');
  const mine = inStrict ? await message({categoryCode: cat.code, subject: 'Still works signed in', body: 'A customer message with no limiter.'}) : {sent: '', error: 'could not sign in'};
  const [mineRow] = await q(`select customer_id from support_tickets where number = $1`, [mine.sent.match(/TCK-[A-Z0-9]{8}/)?.[0] ?? '']);
  ok('no limiter: a signed-in customer still sends a message (their own ticket)', inStrict && signedApi.signedIn === true && signedApi.guest === false && mineRow?.customer_id === me.id && (await tickets()) === t3 + 1, mine.sent || mine.error);
  await tab('order');
  ok('no limiter: the order lookup is closed for a signed-in customer too; they are pointed to their own orders', (await exists('[data-help-order-closed]')) && !(await exists('[data-help-order-form]'))
    && (await ev(`document.querySelector('[data-help-order-closed] a')?.getAttribute('href')`)) === '/account/orders');
  // With a limiter configured (LIMIT_BASE, the same rule switched on) the guest features are open: the limit checks below use them.
  await b.send('Network.clearBrowserCookies');
  await go('/shop', LIMIT_BASE);
  const limitApi = await helpApi(LIMIT_BASE);
  ok('limiter configured, same rule on: the guest features are open', limitApi.guest === true, JSON.stringify(limitApi));

  // ---------- request limits (the store with limits counted in a local fake Redis) ----------
  // The limiter counts in fixed ten-minute windows (and hourly ones that end on the same boundaries). Nine lookups that
  // straddle a boundary are two short counts, not one long one, so the checks below start well inside a window.
  { const left = 600000 - (Date.now() % 600000); if (left < 90000) await w(left + 2000); }
  await b.send('Network.clearBrowserCookies');
  await go('/shop', LIMIT_BASE); await openHelp(); await tab('order');
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await lookup('KTS-HELP-0001', `guess${i}@example.com`)).text);
  const locked = await lookup('KTS-HELP-0001', 'meera.orders@example.com');
  ok('limits: six wrong contacts for one order number, and that order is closed to lookups for a while, even with the right contact', tries.every(t => /could not find an order/.test(t)) && locked.state === 'refused' && /Too many attempts\. Please try again/.test(locked.text), locked.text);
  const other = await lookup('KTS-HELP-0002', 'someone.else@example.com');
  ok('limits: a different order can still be checked from this address', other.state === 'found', other.text);
  const flood = await lookup('KTS-HELP-0003', 'x@example.com');
  ok('limits: the ninth lookup from one address in ten minutes is refused whatever it asks', flood.state === 'refused' && /Too many attempts/.test(flood.text), flood.text);
  await tab('message');
  const t2 = await tickets();
  const sends = [];
  for (let i = 0; i < 4; i++) {
    const r = await message({name: 'Guest', email: `guest${i}@example.com`, categoryCode: cat.code, subject: `Question ${i}`, body: 'Hello.'});
    sends.push(r);
    if (r.sent) { await click('[data-help-sent] ~ button'); await until(`!!document.querySelector('[data-help-message-form]')`); }
  }
  ok('limits: three messages an hour from one address; the fourth is refused and stores nothing', sends.slice(0, 3).every(r => /TCK-/.test(r.sent)) && /Too many attempts/.test(sends[3].error) && (await tickets()) === t2 + 3, JSON.stringify(sends[3]));

  // ---------- the limiter is configured but cannot be reached (LIMIT_DOWN_BASE): guest features are refused, not let through uncounted ----------
  if (LIMIT_DOWN_BASE) {
    await b.send('Network.clearBrowserCookies');
    await go('/shop', LIMIT_DOWN_BASE);
    ok('limiter down: the help topics still open (reading them does not depend on the limiter)', await openHelp());
    await tab('order');
    const down = await lookup('KTS-HELP-0002', 'someone.else@example.com');
    ok('limiter down: a guest order lookup with the RIGHT contact is refused, nothing about the order is shown', down.state === 'refused' && /not available right now/.test(down.text) && !/KTS-HELP-0002.*(Placed|Delivered|Shipped)/.test(down.text), JSON.stringify(down));
    await tab('message');
    const t3 = await tickets();
    const dm = await message({name: 'Guest', email: 'down.guest@example.com', categoryCode: cat.code, subject: 'Question', body: 'Hello.'});
    ok('limiter down: a guest message is refused and nothing is stored', /not available right now/.test(dm.error ?? '') && (await tickets()) === t3, JSON.stringify(dm));
  }

  ok('no page errors during the run', b.errors.filter(e => !/http 40[345]|favicon/.test(e)).length === 0, b.errors.filter(e => !/http 40[345]|favicon/.test(e)).slice(0, 3).join(' | '));
} catch (e) {
  ok('help tests ran to the end', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
