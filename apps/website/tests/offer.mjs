/* The first-order offer popup (2026-10-12): browser tests. Started by tests/run-account.mjs (ONLY=offer runs just this file)
   with BASE (the store on a LOCAL test database), SERVER_LOG (the console mailer writes the confirmation email there) and
   KITSYUU_DB_URL (owner connection to the LOCAL test database, for the offer's set-up and for checks). Never touches a
   hosted database. The offer here is a coupon made for the test; nothing about it is in the store's code. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from './cdp.mjs';

const {BASE, SERVER_LOG, KITSYUU_DB_URL} = process.env;
if (!/@localhost[:/]/.test(KITSYUU_DB_URL || '')) throw new Error('offer tests only run against a local database');
const out = []; const ok = (n, p, x = '') => { const l = `${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`; out.push(l); console.log(l); };
const w = ms => new Promise(r => setTimeout(r, ms));
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const PW = 'correct horse battery staple';

const b = await launch(9443); const ev = e => b.eval(e);
const until = async (x, ms = 15000) => { for (let t = 0; t < ms; t += 120) { try { if (await ev(x)) return true; } catch {} await w(120); } return false; };
const go = async (p, ready = 'document.readyState === "complete" && !!document.querySelector("main")') => { await b.goto(BASE + p, ready); };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel}');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const key = async (k, code, vk, shift = false) => { for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', {type, key: k, code, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0}); await w(60); };
/** Scrolls into the store the way a visitor would (a real scroll event); on the home page, to the store section. */
const scrollIn = () => ev(`(()=>{const s=location.pathname==='/'?document.getElementById('store'):null;if(s)s.scrollIntoView();else scrollTo(0,Math.max(900,innerHeight));dispatchEvent(new Event('scroll'));return true})()`);
const shown = (ms = 8000) => until(`!!document.querySelector('[data-first-offer] [data-offer-dialog]')`, ms);
/** A fresh browser session for the popup. The popup reads its "closed" note when a page loads, so this is called BEFORE going to the page. */
const newSession = () => ev(`(()=>{try{sessionStorage.clear()}catch{}return true})()`);
const lastLink = to => {
  const log = fs.readFileSync(SERVER_LOG, 'utf8'), start = log.lastIndexOf(`[mail:begin] to=${to} `);
  if (start < 0) return null;
  return log.slice(start, log.indexOf('[mail:end]', start)).match(/https?:\/\/\S+token=[A-Za-z0-9_-]{43}/)?.[0] ?? null;
};
const submit = async () => {
  const sel = JSON.stringify('main form:not(:has([data-logout]))'), start = await ev('location.href');
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel});window.__seen=false;new MutationObserver(()=>{if(f.hasAttribute('aria-busy'))window.__seen=true}).observe(f,{attributes:true,attributeFilter:['aria-busy']});f.querySelector('button[type=submit]').click();return true})()`);
  await until(`location.href !== ${JSON.stringify(start)} || (window.__seen === true && !document.querySelector(${sel})?.hasAttribute('aria-busy'))`, 20000);
  await w(250);
};
const offerApi = (qs = '') => ev(`fetch('/api/offer${qs}', {cache: 'no-store'}).then(r => r.json())`);

try {
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');

  // ---------- nothing is configured: nothing is shown ----------
  await newSession(); await go('/shop'); await scrollIn();
  ok('no offer is named: scrolling the store shows no popup, and the server offers nothing', !(await shown(2500)) && (await offerApi()).offer === null);

  // The business's own coupon, named as the first-order offer (set up here in the LOCAL test database).
  await q(`insert into settings (key, value) values ('discounts.enabled', '"on"'), ('discounts.first_customer_code', '"FIRSTE2E"') on conflict (key) do update set value = excluded.value`);
  const [d] = await q(`insert into discounts (name, code, kind, value, scope, max_discount_paise, min_order_paise, is_active, per_customer_limit) values ('First order', 'FIRSTE2E', 'percent', 1000, 'order', 15000, 50000, true, 1) returning id`);

  // ---------- guest ----------
  await newSession(); await go('/shop');
  ok('guest: nothing interrupts before scrolling', !(await shown(1200)));
  await scrollIn();
  ok('guest: after scrolling into the store the offer opens as a dialog', (await shown()) && (await ev(`(()=>{const x=document.querySelector('[data-offer-dialog]');return x.getAttribute('role')==='dialog'&&x.getAttribute('aria-modal')==='true'&&!!document.getElementById(x.getAttribute('aria-labelledby'))&&!!document.getElementById(x.getAttribute('aria-describedby'))})()`)));
  const terms = await text('[data-offer-terms]');
  ok('the offer shown is the coupon as the business set it up: 10%, at most ₹150, from ₹500, its code', /^10% off your first order$/i.test((await text('[data-offer-title]')).trim()) && /Up to ₹150 off/.test(terms)
    && /orders of ₹500 or more/.test(terms) && (await text('[data-offer-code]')) === 'FIRSTE2E' && /not ordered from KITSYUU before/.test(terms), `${await text('[data-offer-title]')} | ${terms}`);
  ok('guest: asked to create an account or log in; nothing can be claimed without one', (await ev(`document.querySelector('[data-offer-signup]')?.getAttribute('href')`)) === '/signup'
    && (await ev(`document.querySelector('[data-offer-login]')?.getAttribute('href')`)) === '/login' && !(await exists('[data-offer-claim]')));
  ok('keyboard: focus starts inside the dialog, on the main action', await ev(`document.activeElement?.matches('[data-offer-primary]') === true`));
  let trapped = true;
  for (let i = 0; i < 7; i++) { await key('Tab', 'Tab', 9, i % 3 === 2); if (!(await ev(`!!document.activeElement?.closest('[data-offer-dialog]')`))) trapped = false; }
  ok('keyboard: Tab and Shift+Tab stay inside the dialog', trapped);
  ok('the close button has a name and a 44px target', (await ev(`(()=>{const c=document.querySelector('[data-offer-close]'),r=c.getBoundingClientRect();return c.getAttribute('aria-label')==='Close this offer'&&r.width>=44&&r.height>=44})()`)));
  await key('Escape', 'Escape', 27);

  // ---------- guest: their own welcome; looking grants nothing; the ways on (2026-10-12) ----------
  const raw = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? ''`);
  const granted = async () => (await q(`select (select count(*)::int from discount_redemptions) used, (select count(*)::int from carts where coupon_code is not null) carts,
    (select count(*)::int from audit_logs where action = 'offer.first_order_claim') claims`))[0];
  const g0 = await granted();
  await newSession(); await go('/shop'); await scrollIn(); await shown();
  ok('guest: welcomed in their own words, and told the offer is for a first order and is checked once they sign in', (await raw('[data-offer-eyebrow]')) === 'First time here? Enjoy a special welcome offer!'
    && /Create an account or sign in to use it\. Whether it applies to you is checked then/.test(await raw('[data-offer-guest-terms]')) && /not ordered from KITSYUU before/.test(await raw('[data-offer-terms]')), await raw('[data-offer-eyebrow]'));
  ok('guest: the actions are Create account, Sign in and Continue shopping', (await raw('[data-offer-signup]')) === 'Create account' && (await raw('[data-offer-login]')) === 'Sign in' && (await raw('[data-offer-dismiss]')) === 'Continue shopping');
  const api = await offerApi(), g1 = await granted();
  ok('guest: seeing the offer grants nothing: no redemption, no coupon put on a cart, no claim recorded; the server knows nobody is signed in', JSON.stringify(g1) === JSON.stringify(g0) && g1.used === 0 && g1.claims === 0
    && api.signedIn === false && api.offer?.code === 'FIRSTE2E', JSON.stringify({g0, g1, signedIn: api.signedIn}));
  await ev(`document.querySelector('[data-offer-dismiss]').click(), true`);
  const closed = await until(`!document.querySelector('[data-first-offer]')`, 4000);
  await go('/shop'); await scrollIn();
  ok('guest: "Continue shopping" closes it, and it does not interrupt again in the same visit', closed && !(await shown(2000)) && (await exists('main')));
  await newSession(); await go('/shop'); await scrollIn(); await shown();
  await ev(`document.querySelector('[data-offer-login]').click(), true`);
  ok('guest: Sign in opens the existing login page, where the offer never interrupts', (await until(`location.pathname === '/login' && !!document.querySelector('main [name=email]')`, 15000)) && !(await shown(1500)));
  await newSession(); await go('/shop'); await scrollIn(); await shown();
  await ev(`document.querySelector('[data-offer-signup]').click(), true`);
  ok('guest: Create account opens the existing sign-up page', (await until(`location.pathname === '/signup' && !!document.querySelector('main [name=email]')`, 15000)) && !(await shown(1500)));
  ok('guest: none of that granted anything either', JSON.stringify(await granted()) === JSON.stringify(g0));
  ok('Escape closes it', await until(`!document.querySelector('[data-first-offer]')`, 4000));
  await go('/shop?sort=newest'); await scrollIn();
  const [product] = await q(`select slug from products where status = 'active' order by id limit 1`);
  const again1 = await shown(2000);
  await go(`/product/${product.slug}`); await scrollIn();
  ok('once closed it does not come back on other pages in the same browser session', !again1 && !(await shown(2000)));
  // Tampering with the request changes nothing: the endpoint takes no input.
  const t = await offerApi('?customerId=00000000-0000-4000-8000-000000000000&code=FREE100&eligible=1&value=9999');
  ok('the offer endpoint ignores anything the browser sends (customer id, code, value) and takes no other method', t.signedIn === false && t.offer.code === 'FIRSTE2E' && t.offer.value === 1000
    && (await ev(`fetch('/api/offer', {method: 'POST', body: '{}'}).then(r => r.status)`)) === 405, JSON.stringify(t));

  // ---------- quiet pages: paying, signing in, the account ----------
  for (const p of ['/login', '/signup', '/forgot-password']) {
    await newSession(); await go(p); await scrollIn();
    ok(`never on ${p}`, !(await shown(1500)));
  }

  // ---------- a signed-in customer who has never ordered ----------
  const email = 'offer.e2e@test.local';
  await go('/signup', '!!document.querySelector("main [name=email]")');
  await fill('main [name=fullName]', 'Offer Customer'); await fill('main [name=email]', email); await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
  await submit();
  await b.goto(lastLink(email), 'document.readyState === "complete"');
  ok('a new customer signs up and confirms their email', await until(`location.pathname === '/account'`));
  const [me] = await q(`select id from customers where email = $1`, [email]);
  await newSession(); await scrollIn();
  ok('never on the account pages', !(await shown(1500)));
  await go('/checkout', 'document.readyState === "complete"'); await scrollIn();
  ok('never on checkout', !(await shown(1500)));
  await go('/shop'); await scrollIn();
  ok('eligible customer: the offer opens with the action to use it', (await shown()) && (await exists('[data-offer-claim]')) && !(await exists('[data-offer-signup]')));
  await ev(`document.querySelector('[data-offer-claim]').click(), true`);
  ok('using it: the server answers that it is on the cart; the dialog then offers to continue shopping', await until(`document.querySelector('[data-offer-result]')?.dataset.offerResult === 'ok'`, 15000)
    && /Added to your cart: coupon FIRSTE2E/.test(await text('[data-offer-result]')) && !(await exists('[data-offer-claim]')), await text('[data-offer-result]'));
  const [c1] = await q(`select (select coupon_code from carts where customer_id = $1 and status = 'active') code, (select count(*)::int from audit_logs where action = 'offer.first_order_claim' and customer_id = $1) claims,
    (select count(*)::int from discounts) discounts, (select count(*)::int from discount_redemptions) used`, [me.id]);
  ok('stored: the coupon is on this customer\'s cart, one claim is audited, no coupon was created and nothing was redeemed', c1.code === 'FIRSTE2E' && c1.claims === 1 && c1.discounts === 1 && c1.used === 0, JSON.stringify(c1));
  await ev(`document.querySelector('[data-offer-close]').click(), true`);
  ok('the close button closes it', await until(`!document.querySelector('[data-first-offer]')`, 4000));

  // ---------- the same customer once they have a successful order ----------
  const [past] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at) values ('KTS-OFFER-E2E', $1, 'paid', 'paid', 100000, 100000, '{}', '{}', now()) returning id`, [me.id]);
  await newSession(); await go('/shop'); await scrollIn();
  const api2 = await offerApi();
  ok('returning customer: the server offers nothing and no popup opens, even in a fresh browser session', !(await shown(2500)) && api2.signedIn === true && api2.offer === null, JSON.stringify(api2));
  await go('/checkout', 'document.readyState === "complete"');
  ok('returning customer at checkout: the coupon still on their cart is refused with the reason, and takes nothing off',
    await until(`document.querySelector('[data-coupon-state]')?.dataset.couponState === 'not-applied' || !document.querySelector('[data-coupon]')`, 8000)
    && (!(await exists('[data-coupon-state]')) || /first order only/.test(await text('[data-coupon]'))), await text('[data-coupon]'));
  await q(`update orders set status = 'cancelled', payment_status = 'unpaid' where id = $1`, [past.id]);
  ok('a cancelled order does not count: the customer is offered it again', (await offerApi()).offer?.code === 'FIRSTE2E');

  // ---------- the business switches the coupon off ----------
  await q(`update discounts set is_active = false where id = $1`, [d.id]);
  await b.send('Network.clearBrowserCookies');
  await newSession(); await go('/shop'); await scrollIn();
  ok('coupon switched off: nobody is shown the offer', !(await shown(2500)) && (await offerApi()).offer === null);
  await q(`update discounts set is_active = true where id = $1`, [d.id]);

  // ---------- home page: only once the visitor reaches the store ----------
  await newSession(); await go('/', 'document.readyState === "complete"');
  ok('home page: nothing over the landing film', !(await shown(1500)));
  await scrollIn();
  ok('home page: the offer opens once the store section is reached', await shown());
  await key('Escape', 'Escape', 27);

  // ---------- phone width, reduced motion ----------
  await b.viewport(390, 844, true);
  await b.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await newSession(); await go('/shop'); await scrollIn();
  ok('phone: the offer opens', await shown());
  const m = await ev(`(()=>{const x=document.querySelector('[data-offer-dialog]'),r=x.getBoundingClientRect(),c=document.querySelector('[data-offer-close]').getBoundingClientRect(),p=document.querySelector('[data-offer-primary]').getBoundingClientRect();
    return {fits:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,noScroll:document.documentElement.scrollWidth<=innerWidth+1,close:c.width>=44&&c.height>=44,primary:p.height>=44&&p.width>=200,anim:getComputedStyle(x).animationName}})()`);
  ok('phone: the dialog fits the screen with no sideways scrolling; the buttons are finger-sized', m.fits && m.noScroll && m.close && m.primary, JSON.stringify(m));
  ok('reduced motion: the dialog does not animate', m.anim === 'none', m.anim);
  await ev(`document.querySelector('[data-offer-dismiss]').click(), true`);
  ok('phone (guest): "Continue shopping" closes it and shopping carries on', await until(`!document.querySelector('[data-first-offer]')`, 4000) && (await exists('main')));
  ok('no page errors during the run', b.errors.filter(e => !/http 40[345]|favicon/.test(e)).length === 0, b.errors.filter(e => !/http 40[345]|favicon/.test(e)).slice(0, 3).join(' | '));
} catch (e) {
  ok('offer tests ran to the end', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); }

const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
