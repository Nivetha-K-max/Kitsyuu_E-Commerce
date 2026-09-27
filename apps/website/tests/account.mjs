/* M6 customer account browser tests. Started by tests/run-account.mjs with BASE (website on a LOCAL test database),
   SERVER_LOG (the console mailer writes confirmation / reset emails there) and KITSYUU_DB_URL (owner connection to the
   LOCAL test database, for fixtures and checks). Never touches Supabase data. */
import fs from 'node:fs';
import pg from 'pg';
import {launch} from './cdp.mjs';

const {BASE, SERVER_LOG, KITSYUU_DB_URL} = process.env;
if (!/@localhost[:/]/.test(KITSYUU_DB_URL || '')) throw new Error('account tests only run against a local database');
const out = []; const ok = (n, p, x = '') => { const l = `${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`; out.push(l); console.log(l); };
const w = ms => new Promise(r => setTimeout(r, ms));
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
/** The page's own form: account pages also have the navigation's Log out form inside main. */
const MAIN_FORM = 'main form:not(:has([data-logout]))';
const PW = 'correct horse battery staple', PW2 = 'a different long passphrase';

const b = await launch(9441); const ev = e => b.eval(e);
const until = async (x, ms = 15000) => { for (let t = 0; t < ms; t += 120) { if (await ev(x).catch(() => false)) return true; await w(120); } return false; };
const errs = () => b.errors.filter(e => !/http 40[34]/.test(e));
const go = async (p, ready = '!!document.querySelector("main h1")') => { await b.goto(BASE + p, ready); };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel}');
  const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
/** Submits the form and waits for this submission's answer: the form goes busy (aria-busy, seen by a MutationObserver set up
    before the click, so a fast answer is not missed) and then settles, or the page navigates. Stale messages or
    aria-invalid marks from an earlier attempt are therefore never mistaken for the new answer. */
const submit = async (formSel = MAIN_FORM) => {
  const start = await ev('location.href'), sel = JSON.stringify(formSel);
  // Wait until React has hydrated the form (its handlers are attached); a click before that is a plain browser submission.
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel});window.__submitSeen=false;const o=new MutationObserver(()=>{if(f.hasAttribute('aria-busy'))window.__submitSeen=true});
    o.observe(f,{attributes:true,attributeFilter:['aria-busy']});f.querySelector('button[type=submit]').click();return true})()`);
  await until(`location.href !== ${JSON.stringify(start)} || (window.__submitSeen === true && !document.querySelector(${sel})?.hasAttribute('aria-busy'))`, 20000);
  await w(250);
};
const message = (formSel = MAIN_FORM) => ev(`document.querySelector(${JSON.stringify(formSel + ' [data-form-message]')})?.innerText ?? ''`);
const fieldError = name => ev(`(()=>{const i=document.querySelector('main [name=${name}]');const d=i?.getAttribute('aria-describedby');return d?document.getElementById(d.split(' ')[0])?.innerText??'':''})()`);
const path = () => ev('location.pathname + location.search');
/** The last link emailed to `to` (the console mailer writes to the server log). */
const lastLink = to => {
  const text = fs.readFileSync(SERVER_LOG, 'utf8'), start = text.lastIndexOf(`[mail:begin] to=${to} `);
  if (start < 0) return null;
  const block = text.slice(start, text.indexOf('[mail:end]', start));
  return block.match(/https?:\/\/\S+token=[A-Za-z0-9_-]{43}/)?.[0] ?? null;
};
const mailCount = to => (fs.readFileSync(SERVER_LOG, 'utf8').match(new RegExp(`\\[mail:begin\\] to=${to.replace(/[.+]/g, '\\$&')} `, 'g')) || []).length;
const cookieOf = async () => (await b.send('Network.getCookies', {urls: [BASE]})).cookies.find(c => c.name === '__Host-kitsyuu_customer');
const meAs = async token => (await fetch(BASE + '/api/me', {headers: token ? {cookie: `__Host-kitsyuu_customer=${token}`} : {}})).json();

async function signupAndConfirm(email, name, password = PW) {
  await b.send('Network.clearBrowserCookies');
  await go('/signup');
  await fill('main [name=fullName]', name); await fill('main [name=email]', email); await fill('main [name=password]', password); await fill('main [name=confirm]', password);
  await submit();
  const link = lastLink(email);
  await b.goto(link, '!!document.querySelector("main h1")');
  return until(`location.pathname === '/account'`);
}

try {
  for (const [W, H, mob, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
    await b.viewport(W, H, mob);
    await b.send('Network.clearBrowserCookies');
    const email = `asha.${tag}@test.local`;

    // ---------- guests ----------
    await go('/account/orders', 'document.readyState==="complete"');
    ok(`[${tag}] guest → /account/orders is sent to log in (and back afterwards)`, (await path()) === '/login?next=%2Faccount%2Forders');
    await until(`document.querySelector('.st-tool-account')?.dataset.auth === 'guest'`);
    ok(`[${tag}] guest header shows Log in`, (await ev(`document.querySelector('.st-tool-account').dataset.auth`)) === 'guest');

    // ---------- signup ----------
    await go('/signup');
    await fill('main [name=fullName]', 'Asha Rao'); await fill('main [name=email]', email); await fill('main [name=password]', 'short'); await fill('main [name=confirm]', 'other');
    await submit();
    ok(`[${tag}] signup: weak password and mismatch are explained next to the fields, focus moves to the first`, /12 characters/.test(await fieldError('password')) && /do not match/.test(await fieldError('confirm'))
      && (await ev(`document.activeElement?.getAttribute('aria-invalid')`)) === 'true', `${await fieldError('password')} | ${await fieldError('confirm')}`);
    await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
    await submit();
    const answer = await message();
    ok(`[${tag}] signup: generic confirmation message, no session yet`, /Check .* for a confirmation link/.test(answer) && !(await cookieOf()), answer);
    ok(`[${tag}] signup: confirmation email sent`, mailCount(email) === 1 && !!lastLink(email));
    const [row] = await q(`select email_verified_at, password_hash from customers where email = $1`, [email]);
    ok(`[${tag}] signup: account stored unconfirmed with an Argon2id hash`, row.email_verified_at === null && /^\$argon2id\$/.test(row.password_hash));

    // ---------- login before confirming ----------
    await go('/login');
    await fill('main [name=email]', email); await fill('main [name=password]', PW); await submit();
    ok(`[${tag}] login before confirming explains it and sends a new link`, /confirm your email/i.test(await message()) && mailCount(email) === 2, await message());

    // ---------- confirmation link ----------
    const link = lastLink(email);
    await b.goto(link, '!!document.querySelector("main h1")');
    ok(`[${tag}] confirmation link signs in and opens the account`, await until(`location.pathname === '/account' && !!document.querySelector('[data-notice=welcome]')`));
    const c = await cookieOf();
    ok(`[${tag}] session cookie: __Host-, HttpOnly, Secure, SameSite=Lax, host-only, path /`, !!c && c.httpOnly && c.secure && c.sameSite === 'Lax' && c.path === '/' && !c.domain.startsWith('.'), JSON.stringify(c && {httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, domain: c.domain}));
    ok(`[${tag}] session token is not readable by page scripts`, !(await ev('document.cookie')).includes('kitsyuu_customer'));
    ok(`[${tag}] session cookie holds a random 256-bit token; the database stores only its SHA-256`, /^[A-Za-z0-9_-]{43}$/.test(c.value)
      && (await q(`select count(*)::int n from customer_sessions where token_hash = sha256(convert_to($1, 'UTF8'))`, [c.value]))[0].n === 1);
    // Signed out, as a stranger holding the old link would be (a signed-in visitor is sent on from /login to the account).
    await b.send('Network.clearBrowserCookies');
    await b.goto(link, 'document.readyState==="complete"');
    ok(`[${tag}] a used confirmation link is refused`, await until(`location.search === '?reason=link'`) && !(await cookieOf()));
    await b.send('Network.setCookie', {name: c.name, value: c.value, url: BASE, path: '/', secure: true, httpOnly: true, sameSite: 'Lax'});
    await go('/account');
    await until(`document.querySelector('.st-tool-account')?.dataset.auth === 'customer'`);
    ok(`[${tag}] header shows the signed-in state`, (await ev(`document.querySelector('.st-tool-account').dataset.auth`)) === 'customer');
    const me = await meAs(c.value);
    ok(`[${tag}] /api/me returns only the signed-in state and first name`, JSON.stringify(me) === JSON.stringify({status: 'user', firstName: 'Asha', emailVerified: true}), JSON.stringify(me));

    // ---------- profile ----------
    await go('/account/profile');
    await fill('main [name=phone]', '12345'); await submit();
    ok(`[${tag}] profile: invalid mobile number explained`, /10-digit/.test(await fieldError('phone')));
    await fill('main [name=phone]', '+91 98765 43210'); await fill('main [name=fullName]', 'Asha R Rao'); await submit();
    ok(`[${tag}] profile: saved`, /saved/.test(await message()));
    await go('/account');
    ok(`[${tag}] overview shows the new details`, (await ev(`document.querySelector('[data-account-name]').innerText`)) === 'Asha R Rao' && /9876543210/.test(await ev(`document.querySelector('main').innerText`)));

    // ---------- addresses ----------
    await go('/account/addresses/new');
    await fill('main [name=fullName]', 'Asha Rao'); await fill('main [name=phone]', '9876543210'); await fill('main [name=line1]', '12 MG Road');
    await fill('main [name=city]', 'Coimbatore'); await fill('main [name=pin]', '041001'); await submit();
    ok(`[${tag}] address: bad PIN and missing state explained`, /6-digit PIN/.test(await fieldError('pin')) && /state/i.test(await fieldError('state')));
    await fill('main [name=pin]', '641001'); await fill('main [name=state]', 'Tamil Nadu'); await submit();
    ok(`[${tag}] address: first address added as default`, await until(`location.search === '?notice=added' && document.querySelectorAll('[data-address]').length === 1 && !!document.querySelector('[data-default]')`));
    await go('/account/addresses/new');
    await fill('main [name=fullName]', 'Asha Office'); await fill('main [name=phone]', '9876543210'); await fill('main [name=line1]', '5 Beach Road');
    await fill('main [name=city]', 'Chennai'); await fill('main [name=pin]', '600001'); await fill('main [name=state]', 'Tamil Nadu'); await submit();
    await until(`document.querySelectorAll('[data-address]').length === 2`);
    const [office] = await q(`select a.id from addresses a join customers c on c.id = a.customer_id where c.email = $1 and a.line1 = '5 Beach Road'`, [email]);
    await ev(`(document.querySelector('[data-address="${office.id}"] form[aria-label^="Make"] button').click(),true)`);
    ok(`[${tag}] address: make default`, await until(`document.querySelector('[data-default]')?.dataset.address === '${office.id}'`));
    await go(`/account/addresses/${office.id}`);
    await fill('main [name=line1]', '6 Beach Road'); await submit();
    ok(`[${tag}] address: edited`, await until(`location.search === '?notice=updated' && document.querySelector('main').innerText.includes('6 Beach Road')`));
    await ev(`window.confirm = () => true, true`);
    await ev(`(document.querySelector('[data-address="${office.id}"] form[aria-label^="Remove"] button').click(),true)`);
    ok(`[${tag}] address: removed; the remaining address becomes default`, await until(`document.querySelectorAll('[data-address]').length === 1 && !!document.querySelector('[data-default]')`));
    const [home] = await q(`select a.id from addresses a join customers c on c.id = a.customer_id where c.email = $1`, [email]);

    // ---------- a second customer cannot reach the first one's data ----------
    const ashaCookie = await cookieOf();
    ok(`[${tag}] second customer signs up`, await signupAndConfirm(`ravi.${tag}@test.local`, 'Ravi Kumar'));
    await b.goto(`${BASE}/account/addresses/${home.id}`, 'document.readyState==="complete"');
    ok(`[${tag}] another customer's address id → not found (no data shown)`, /not found/i.test(await ev('document.body.innerText')) && !(await ev('document.body.innerText')).includes('12 MG Road'));

    // ---------- orders (fixture in the LOCAL DB) ----------
    const [{id: ashaId}] = await q(`select id from customers where email = $1`, [email]);
    const [{id: fixtureUser}] = await q(`insert into auth.users (email) values ($1) returning id`, [`fixture.${tag}@test.local`]);
    const [v] = await q(`select v.id, v.sku, v.size, p.id pid, p.name, p.price_paise from product_variants v join products p on p.id = v.product_id order by p.id limit 1`);
    const orderNo = `KTS-M6-${tag.toUpperCase()}`;
    const [{id: oid}] = await q(`insert into orders (order_number, user_id, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at)
      values ($1, $2, $3, 'shipped', 'paid', $4, $4, '{}', $5, now()) returning id`, [orderNo, fixtureUser, ashaId, v.price_paise * 2,
      JSON.stringify({name: 'Asha Rao', line1: '12 MG Road', city: 'Coimbatore', state: 'Tamil Nadu', pin: '641001', country: 'India', phone: '9876543210'})]);
    await q(`insert into order_items (order_id, product_id, variant_id, sku, name, size, unit_price_paise, qty, line_total_paise) values ($1,$2,$3,$4,$5,$6,$7,2,$8)`, [oid, v.pid, v.id, v.sku, v.name, v.size, v.price_paise, v.price_paise * 2]);
    await q(`insert into order_status_history (order_id, to_status) values ($1, 'paid'), ($1, 'shipped')`, [oid]);
    await b.goto(`${BASE}/account/orders/${orderNo}`, 'document.readyState==="complete"');
    ok(`[${tag}] another customer's order number → not found`, /not found/i.test(await ev('document.body.innerText')) && !(await ev('document.body.innerText')).includes(v.name));
    // back to the first customer
    await b.send('Network.clearBrowserCookies');
    await b.send('Network.setCookie', {name: ashaCookie.name, value: ashaCookie.value, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax', path: '/'});
    await go('/account/orders');
    ok(`[${tag}] orders: the customer's order is listed`, (await ev(`[...document.querySelectorAll('[data-order]')].map(r=>r.dataset.order).join()`)) === orderNo);
    await go(`/account/orders/${orderNo}`);
    const detail = await ev(`document.querySelector('main').innerText`);
    ok(`[${tag}] order detail: items, quantities, totals, payment, delivery and progress`, detail.includes(v.name) && /Size .* 2 ×/.test(detail) && /Shipped/.test(detail)
      && /Paid/.test(detail) && /Coimbatore/.test(detail) && (await ev(`document.querySelectorAll('.st-order-timeline li').length`)) === 2, detail.slice(0, 200));

    // ---------- sessions: a second device ----------
    await b.send('Network.clearBrowserCookies');
    await go('/login');
    await fill('main [name=email]', email); await fill('main [name=password]', PW); await submit();
    await until(`location.pathname === '/account'`);
    const device2 = (await cookieOf()).value;
    await b.send('Network.clearBrowserCookies');
    await b.send('Network.setCookie', {name: ashaCookie.name, value: ashaCookie.value, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax', path: '/'});
    await go('/account/security');
    ok(`[${tag}] security: this device and the other device are listed`, (await ev(`document.querySelectorAll('[data-session=current]').length`)) === 1 && (await ev(`document.querySelectorAll('[data-session=other]').length`)) === 1);
    ok(`[${tag}] device 2 is signed in`, (await meAs(device2)).status === 'user');
    await ev(`(document.querySelector('[data-session=other] button').click(),true)`);
    await until(`!document.querySelector('[data-session=other]') || /signed out/.test(document.querySelector('[data-session=other] [data-form-message]')?.innerText || '')`);
    ok(`[${tag}] ending the other device's session signs it out`, (await meAs(device2)).status === 'guest');

    // ---------- password change ----------
    await go('/login?x=1', 'document.readyState==="complete"');         // a signed-in visit to /login goes to the account
    ok(`[${tag}] signed-in visit to /login goes to the account`, (await ev('location.pathname')) === '/account');
    await b.send('Network.clearBrowserCookies');
    await go('/login'); await fill('main [name=email]', email); await fill('main [name=password]', PW); await submit(); await until(`location.pathname === '/account'`);
    const device3 = (await cookieOf()).value;
    await b.send('Network.clearBrowserCookies');
    await b.send('Network.setCookie', {name: ashaCookie.name, value: ashaCookie.value, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax', path: '/'});
    await go('/account/security');
    await fill('#st-password-form [name=current]', 'wrong password!!'); await fill('#st-password-form [name=password]', PW2); await fill('#st-password-form [name=confirm]', PW2);
    await submit('#st-password-form');
    ok(`[${tag}] change password: wrong current password explained`, /not your current password/.test(await fieldError('current')));
    await fill('#st-password-form [name=current]', PW); await fill('#st-password-form [name=password]', PW2); await fill('#st-password-form [name=confirm]', PW2);
    await submit('#st-password-form');
    ok(`[${tag}] change password: saved; other devices signed out; this one stays`, /Password changed/.test(await message('#st-password-form'))
      && (await meAs(device3)).status === 'guest' && (await meAs(ashaCookie.value)).status === 'user');

    // ---------- sign out everywhere ----------
    await ev(`window.confirm = () => true, true`);
    await ev(`(document.querySelector('[data-logout-everywhere]').click(),true)`);
    ok(`[${tag}] sign out everywhere → login page; the old session no longer works`, await until(`location.search === '?reason=loggedout'`) && (await meAs(ashaCookie.value)).status === 'guest');

    // ---------- forgot / reset password ----------
    await go('/forgot-password');
    await fill('#st-forgot-form [name=email]', email); await submit('#st-forgot-form');
    const generic = await message('#st-forgot-form');
    await fill('#st-forgot-form [name=email]', `nobody.${tag}@test.local`); await submit('#st-forgot-form');
    ok(`[${tag}] forgot password: same answer for known and unknown emails`, /If an account uses that email/.test(generic) && (await message('#st-forgot-form')) === generic);
    const reset = lastLink(email);
    ok(`[${tag}] reset link emailed`, /\/reset-password\?token=/.test(reset || ''));
    await b.goto(reset, '!!document.querySelector("main [name=password]")');
    await fill('main [name=password]', PW); await fill('main [name=confirm]', PW); await submit();
    ok(`[${tag}] reset password → log in with the new password`, await until(`location.search === '?reason=reset'`));
    await go('/login'); await fill('main [name=email]', email); await fill('main [name=password]', PW); await submit();
    ok(`[${tag}] login with the reset password works`, await until(`location.pathname === '/account'`));
    await b.goto(reset, '!!document.querySelector("main [name=password]")');
    await fill('main [name=password]', PW2); await fill('main [name=confirm]', PW2); await submit();
    ok(`[${tag}] a used reset link is refused with a friendly message`, /invalid, already used, or expired/.test(await message()));

    // ---------- logout ----------
    await go('/account');
    await ev(`(document.querySelector('.st-account-nav [data-logout]').click(),true)`);
    ok(`[${tag}] logout → login page with confirmation; the session cookie is gone`, await until(`location.search === '?reason=loggedout'`) && !(await cookieOf()));
    await go('/account', 'document.readyState==="complete"');
    ok(`[${tag}] after logout /account asks to log in`, (await ev('location.pathname')) === '/login');

    // ---------- throttling ----------
    for (let i = 0; i < 5; i++) { await go('/login'); await fill('main [name=email]', email); await fill('main [name=password]', 'wrong password ' + i); await submit(); }
    const wrong = await message();
    await go('/login'); await fill('main [name=email]', email); await fill('main [name=password]', PW); await submit();
    ok(`[${tag}] after 5 failures the account is throttled (even with the right password)`, /incorrect/.test(wrong) && /Too many attempts/.test(await message()), await message());
    await q(`delete from auth_attempts where email = $1`, [email]);          // local test DB: clear for the next viewport

    // ---------- layout ----------
    await b.send('Network.clearBrowserCookies');
    await go('/login'); await fill('main [name=email]', `ravi.${tag}@test.local`); await fill('main [name=password]', PW); await submit(); await until(`location.pathname === '/account'`);
    const over = [];
    for (const p of ['/account', '/account/profile', '/account/addresses', '/account/addresses/new', '/account/orders', '/account/security', '/account/wishlist', '/login', '/signup', '/forgot-password']) {
      await go(p, 'document.readyState==="complete"'); await w(200);
      if (await ev('document.documentElement.scrollWidth > innerWidth + 1')) over.push(p);
      const unlabelled = await ev(`[...document.querySelectorAll('main input:not([type=hidden]),main select')].filter(i=>!i.labels?.length).map(i=>i.name).join()`);
      if (unlabelled) over.push(`${p} unlabelled: ${unlabelled}`);
    }
    ok(`[${tag}] account and auth pages: no horizontal overflow, every field labelled`, over.length === 0, over.join('; '));
    ok(`[${tag}] no console errors`, errs().length === 0, errs().slice(0, 3).join(' | '));
    b.errors.length = 0;
  }

  // ---------- secrets never reach the browser ----------
  const staticDir = new URL('../.next/static/', import.meta.url);
  const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(new URL(e.name + '/', d)) : [new URL(e.name, d)]);
  const bundle = walk(staticDir).filter(f => /\.(js|css)$/.test(f.pathname)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  ok('browser bundles contain no database URL, role name or server-only variable names', !/postgres(ql)?:\/\//.test(bundle) && !/kitsyuu_website/.test(bundle)
    && !/WEBSITE_DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|argon2/i.test(bundle));
  const [{n}] = await q(`select count(*)::int n from audit_logs where actor_type = 'customer'`);
  ok('customer actions were audited', n > 20, `${n} audit rows`);
} catch (e) {
  ok('test run', false, e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  console.log(`SUMMARY ${out.filter(l => l.startsWith('PASS')).length}/${out.length}`);
  b.close(); await pool.end();
}
process.exit(out.every(l => l.startsWith('PASS')) ? 0 : 1);
