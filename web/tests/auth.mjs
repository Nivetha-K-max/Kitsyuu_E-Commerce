/* Phase 4.4 checks: signup/login/logout, account, admin protection, role safety, secret exposure.
   Run with: npm run test:auth   (needs `npm start` on :3001 and web/.env.local)
   Setup uses the service-role key IN THIS TEST PROCESS ONLY to create pre-confirmed throwaway users (no emails are sent)
   and deletes them afterwards. The browser only ever talks to the app, which uses the public key.
   Signup-form checks answer the browser's /auth/v1/signup call with a stand-in response, so no confirmation email goes to a
   fake address (Supabase's built-in mailer is rate-limited); the real signup → profile trigger is checked against the DB. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {launch} from './cdp.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.WEB_URL || 'http://127.0.0.1:3001';
const {NEXT_PUBLIC_SUPABASE_URL: SB_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE} = process.env;
const admin = createClient(SB_URL, SERVICE, {auth: {persistSession: false, autoRefreshToken: false}});
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const w = ms => new Promise(r => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const PASSWORD = `Kts!${stamp}-Qa-9x`;
const CUSTOMER = `kitsyuu.qa.customer.${stamp}@example.com`, ADMIN = `kitsyuu.qa.admin.${stamp}@example.com`, UNCONFIRMED = `kitsyuu.qa.unconfirmed.${stamp}@example.com`;
const created = [];

async function makeUser(email, confirmed = true) {
  const {data, error} = await admin.auth.admin.createUser({email, password: PASSWORD, email_confirm: confirmed, user_metadata: {full_name: 'KITSYUU QA'}});
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  created.push(data.user.id); return data.user;
}
const promote = email => spawnSync(process.execPath, ['--env-file=.env.local', 'scripts/promote-admin.mjs'], {cwd: WEB, encoding: 'utf8', env: {...process.env, ADMIN_EMAIL: email}});

const b = await launch(9360);
// Stand-in for the browser's signup call, installed before any page script so supabase-js picks it up.
await b.send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    const mode = sessionStorage.getItem('qa-signup-mock');
    if (mode && u.includes('/auth/v1/signup')) {
      sessionStorage.setItem('qa-signup-body', typeof init?.body === 'string' ? init.body : '');
      const h = {'Content-Type': 'application/json', 'x-supabase-api-version': '2024-01-01'};
      const user = {id: '00000000-0000-4000-8000-000000000000', aud: 'authenticated', role: 'authenticated', email: 'new.customer@example.com', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}};
      if (mode === 'new') return new Response(JSON.stringify({...user, identities: [{id: 'x', identity_id: 'x', user_id: user.id, provider: 'email', identity_data: {}}], confirmation_sent_at: new Date().toISOString()}), {status: 200, headers: h});
      if (mode === 'duplicate') return new Response(JSON.stringify({...user, identities: []}), {status: 200, headers: h});
      if (mode === 'weak') return new Response(JSON.stringify({code: 422, error_code: 'weak_password', msg: 'Password is too weak'}), {status: 422, headers: h});
    }
    return real(input, init);
  };
})();`});

const READY = 'document.readyState==="complete"';
const go = async p => { await b.goto(B + p, READY); await w(700); };
const ev = s => b.eval(s);
const header = () => ev(`(()=>{const a=document.querySelector('.st-tool-account');return {text:a?.innerText.trim(),href:a?.getAttribute('href'),auth:a?.dataset.auth,admin:!!document.querySelector('.st-tool-admin')}})()`);
const setVal = (sel, v) => ev(`(()=>{const i=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const login = async (email, password) => {
  await go('/login'); await setVal('#st-a-email', email); await setVal('#st-a-password', password);
  await ev(`document.querySelector('.st-auth-form button[type=submit]').click()`);
  for (let i = 0; i < 40; i++) { await w(250); const p = await ev('location.pathname'); const a = await ev(`document.querySelector('#st-auth-alert')?.hidden===false`); if (p !== '/login' || a) break; }
  await w(600);
};
const logout = async () => { await go('/account'); await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent==='Log out')?.click()`); for (let i = 0; i < 30 && (await ev('location.pathname')) !== '/login'; i++) await w(250); await w(500); };

try {
  // ---------- setup: throwaway users (pre-confirmed via service role; no emails sent) ----------
  const cust = await makeUser(CUSTOMER);
  const adm = await makeUser(ADMIN);
  const unconf = await makeUser(UNCONFIRMED, false);

  // real signup path → profile trigger → customer role
  const {data: p1} = await admin.from('profiles').select('role, email, full_name').eq('id', cust.id).single();
  ok('new auth user gets a profile with role customer (existing trigger reused)', p1?.role === 'customer' && p1?.email === CUSTOMER && p1?.full_name === 'KITSYUU QA', JSON.stringify(p1));

  // server-side promotion flow (scripts/promote-admin.mjs with ADMIN_EMAIL)
  let r = promote(UNCONFIRMED);
  ok('promotion refuses an account whose email is not confirmed', r.status !== 0 && /not confirmed/.test(r.stderr), r.stderr.trim());
  r = promote(`nobody.${stamp}@example.com`);
  ok('promotion refuses an email with no account', r.status !== 0 && /No account/.test(r.stderr));
  r = promote(ADMIN);
  const {data: p2} = await admin.from('profiles').select('role').eq('id', adm.id).single();
  ok('ADMIN_EMAIL promotion (server-side script) makes the account admin', r.status === 0 && p2?.role === 'admin', (r.stdout + r.stderr).trim());

  // a customer session cannot make itself admin (public key + RLS/column grants)
  const anonClient = createClient(SB_URL, ANON, {auth: {persistSession: false}});
  await anonClient.auth.signInWithPassword({email: CUSTOMER, password: PASSWORD});
  const selfPromo = await anonClient.from('profiles').update({role: 'admin'}).eq('id', cust.id).select();
  const {data: p3} = await admin.from('profiles').select('role').eq('id', cust.id).single();
  ok('a signed-in customer cannot set their own role to admin', !!selfPromo.error && p3.role === 'customer', selfPromo.error?.message);
  const nameEdit = await anonClient.from('profiles').update({full_name: 'KITSYUU QA Customer'}).eq('id', cust.id).select('full_name');
  ok('a signed-in customer can still edit their own name', !nameEdit.error && nameEdit.data?.[0]?.full_name === 'KITSYUU QA Customer');
  await anonClient.auth.signOut();

  for (const [vw, vh, mob, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
    await b.viewport(vw, vh, mob);
    await go('/'); await ev('localStorage.clear();sessionStorage.clear()'); await b.send('Network.clearBrowserCookies');

    // ---------- guest ----------
    await go('/');
    let h = await header();
    ok(`[${tag}] guest header shows Log in → /login, no Admin`, h.text?.toLowerCase() === 'log in' && h.href === '/login' && h.auth === 'guest' && !h.admin, JSON.stringify(h));
    await go('/admin');
    ok(`[${tag}] guest → /admin is redirected to log in`, (await ev('location.pathname+location.search')) === '/login?next=%2Fadmin' && !(await ev(`!!document.querySelector('[data-admin-gate]')`)));
    await go('/account');
    ok(`[${tag}] guest → /account is redirected to log in`, (await ev('location.pathname+location.search')) === '/login?next=%2Faccount');
    // guest cart still local and working
    await go('/product/hook-closure-cropped-jacket');
    await ev(`document.querySelector('.st-size input[value="M"]').click()`); await w(50);
    await ev(`document.querySelector('.st-add').click()`); await w(200);
    ok(`[${tag}] guest can add to cart (local cart unchanged)`, (await ev(`document.querySelector('[data-badge=cart]').textContent`)) === '1' && JSON.parse(await ev(`localStorage.getItem('kitsyuu-cart-v1')`))[0]?.size === 'M');

    // ---------- login errors ----------
    await login(CUSTOMER, 'wrong-password-123');
    ok(`[${tag}] wrong password shows a friendly error`, (await ev('location.pathname')) === '/login' && (await ev(`document.querySelector('#st-auth-alert').textContent`)) === 'The email or password is incorrect.');
    await login(`nobody.${stamp}@example.com`, 'whatever-123');
    ok(`[${tag}] unknown email shows the same error (no account enumeration)`, (await ev(`document.querySelector('#st-auth-alert').textContent`)) === 'The email or password is incorrect.');
    await login(UNCONFIRMED, PASSWORD);
    ok(`[${tag}] unconfirmed email is asked to confirm first`, /confirm your email/i.test(await ev(`document.querySelector('#st-auth-alert').textContent`)));
    await go('/login'); await ev(`document.querySelector('.st-auth-form button[type=submit]').click()`); await w(150);
    ok(`[${tag}] empty login form shows field errors without calling Supabase`, (await ev(`document.querySelector('#st-ae-email').hidden===false && document.querySelector('#st-ae-password').hidden===false`)));

    // ---------- customer ----------
    await login(CUSTOMER, PASSWORD);
    let acc = await ev(`({path:location.pathname,email:document.querySelector('[data-account-email]')?.textContent,role:document.querySelector('[data-account-role]')?.textContent,adminSection:!!document.getElementById('st-acc-admin')})`);
    ok(`[${tag}] customer login lands on /account with email and Customer role`, acc.path === '/account' && acc.email === CUSTOMER && acc.role === 'Customer' && !acc.adminSection, JSON.stringify(acc));
    h = await header();
    ok(`[${tag}] customer header shows Account, no Admin`, h.text?.toLowerCase() === 'account' && h.href === '/account' && h.auth === 'customer' && !h.admin, JSON.stringify(h));
    ok(`[${tag}] guest cart survives login (still local)`, (await ev(`document.querySelector('[data-badge=cart]').textContent`)) === '1');
    await ev('location.reload()'); await w(1200);
    ok(`[${tag}] session persists across a reload`, (await ev('location.pathname')) === '/account' && (await ev(`document.querySelector('[data-account-email]')?.textContent`)) === CUSTOMER);
    await go('/admin');
    ok(`[${tag}] customer → /admin is refused server-side`, (await ev(`document.querySelector('[data-admin-gate]')?.dataset.adminGate`)) === 'forbidden' && (await ev(`document.querySelector('h1').textContent`)) === 'Not authorised.' && !(await ev(`document.body.innerText.includes('Store tools')`)));
    await go('/login');
    ok(`[${tag}] signed-in user visiting /login is sent to /account`, (await ev('location.pathname')) === '/account');
    await logout();
    ok(`[${tag}] logout returns to /login with a confirmation`, (await ev('location.pathname')) === '/login' && /logged out/i.test(await ev(`document.querySelector('.st-form-ok')?.textContent||''`)));
    await go('/account');
    h = await header();
    ok(`[${tag}] after logout /account requires login again and header shows Log in`, (await ev('location.pathname')) === '/login' && h.text?.toLowerCase() === 'log in');

    // ---------- admin ----------
    await login(ADMIN, PASSWORD);
    acc = await ev(`({role:document.querySelector('[data-account-role]')?.textContent,adminSection:!!document.getElementById('st-acc-admin')})`);
    ok(`[${tag}] admin account shows Admin role and admin link`, acc.role === 'Admin' && acc.adminSection, JSON.stringify(acc));
    h = await header();
    ok(`[${tag}] admin header shows Account${mob ? ' (Admin link in menu)' : ' + Admin'}`, h.auth === 'admin' && (mob ? (await ev(`!![...document.querySelectorAll('.st-nav-extra a')].find(a=>a.getAttribute('href')==='/admin')`)) : h.admin), JSON.stringify(h));
    await go('/admin');
    ok(`[${tag}] admin → /admin is allowed`, (await ev(`document.querySelector('[data-admin-gate]')?.dataset.adminGate`)) === 'admin');
    if (!mob) await b.shot('auth-admin-desktop.png'); else await b.shot('auth-admin-mobile.png');
    await logout();

    // ---------- expired / invalid session and bad email link ----------
    const ref = new URL(SB_URL).hostname.split('.')[0];
    await b.send('Network.setCookie', {name: `sb-${ref}-auth-token`, value: 'base64-eyJhY2Nlc3NfdG9rZW4iOiJiYWQifQ', url: B});
    await go('/account');
    ok(`[${tag}] invalid/expired session → log in again with a clear message`, (await ev('location.search')).includes('reason=session') && /session has ended/i.test(await ev(`document.body.innerText`)));
    await b.send('Network.clearBrowserCookies');
    await go('/auth/confirm?token_hash=invalid&type=signup');
    ok(`[${tag}] invalid confirmation link → friendly message`, (await ev('location.pathname+location.search')) === '/login?reason=link' && /invalid or has expired/i.test(await ev('document.body.innerText')));

    // ---------- signup form (stand-in responses; no email sent) ----------
    await go('/signup'); await ev(`document.querySelector('.st-auth-form button[type=submit]').click()`); await w(150);
    ok(`[${tag}] empty signup shows name/email/password errors`, await ev(`['full_name','email','password'].every(id=>document.querySelector('#st-ae-'+id).hidden===false)`));
    const fill = async () => { await setVal('#st-a-full_name', 'New Customer'); await setVal('#st-a-email', 'new.customer@example.com'); await setVal('#st-a-password', 'long-enough-pw'); await ev(`document.querySelector('.st-auth-form button[type=submit]').click()`); await w(900); };
    await ev(`sessionStorage.setItem('qa-signup-mock','new')`); await go('/signup'); await fill();
    const body = JSON.parse((await ev(`sessionStorage.getItem('qa-signup-body')`)) || '{}');
    ok(`[${tag}] signup (email confirmation on) shows "check your email"`, /sent a confirmation link/.test(await ev('document.body.innerText')));
    ok(`[${tag}] signup request never sends a role`, body.email === 'new.customer@example.com' && JSON.stringify(body.data) === JSON.stringify({full_name: 'New Customer'}) && !JSON.stringify(body).includes('"role"') && body.gotrue_meta_security !== undefined, JSON.stringify(body.data));
    await ev(`sessionStorage.setItem('qa-signup-mock','duplicate')`); await go('/signup'); await fill();
    ok(`[${tag}] duplicate signup email shows "already exists"`, /already exists/.test(await ev(`document.querySelector('#st-auth-alert').textContent`)));
    await ev(`sessionStorage.setItem('qa-signup-mock','weak')`); await go('/signup'); await fill();
    ok(`[${tag}] weak password from Supabase shows a friendly message`, /stronger password/.test(await ev(`document.querySelector('#st-auth-alert').textContent`)));
    await ev(`sessionStorage.removeItem('qa-signup-mock')`);
    ok(`[${tag}] no horizontal overflow on auth pages`, (await ev('document.documentElement.scrollWidth-innerWidth')) <= 0);
    ok(`[${tag}] no page errors`, b.errors.filter(e => !/^http (401|400|403|404|422)/.test(e) && !/status of (400|401|403|422)/.test(e)).length === 0, b.errors.slice(0, 3).join(' | '));
  }

  // ---------- catalogue still from Supabase ----------
  const html = await (await fetch(B + '/product/hook-closure-cropped-jacket')).text();
  ok('catalogue still served from Supabase (Storage image URL on product page)', html.includes('/storage/v1/object/public/product-images/products/ky-proto-015.webp'));

  // ---------- secrets never reach the browser ----------
  const env = Object.fromEntries(fs.readFileSync(path.join(WEB, '.env.local'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
  const secrets = {SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY, 'DB password (from SUPABASE_DB_URL)': (env.SUPABASE_DB_URL || '').match(/:([^:@/]+)@/)?.[1], RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET, ADMIN_EMAIL: env.ADMIN_EMAIL, 'test admin email': ADMIN}
  ;
  const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const bundle = walk(path.join(WEB, '.next/static')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const pages = (await Promise.all(['/', '/shop', '/login', '/signup', '/product/hook-closure-cropped-jacket', '/cart'].map(async p => (await fetch(B + p)).text()))).join('\n');
  for (const [name, val] of Object.entries(secrets)) {
    if (!val || /REPLACE_WITH/.test(val)) { ok(`${name} not in browser output`, true, 'not set yet (placeholder), nothing to leak'); continue; }
    ok(`${name} not in browser JS bundles or page HTML`, !bundle.includes(val) && !pages.includes(val));
  }
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'RAZORPAY_KEY_SECRET', 'ADMIN_EMAIL', 'SUPABASE_DB_URL']) ok(`variable name ${name} not referenced in browser bundles`, !bundle.includes(name));
} catch (e) {
  ok('auth suite ran', false, e.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  b.close();
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
  const {data} = await admin.from('profiles').select('id').in('id', created);
  ok('throwaway test users and their profiles deleted', (data || []).length === 0);
  console.log(out.join('\n'));
  const pass = out.filter(l => l.startsWith('PASS')).length;
  console.log(`\n${pass}/${out.length} Phase 4.4 checks passed`);
  process.exitCode = pass === out.length ? 0 : 1;
}
