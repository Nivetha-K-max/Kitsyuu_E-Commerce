/* Referrals in the store (2026-10-12): browser tests. Started by tests/run-account.mjs (ONLY=referral runs just this file)
   with BASE (the store on a LOCAL test database), SERVER_LOG (the console mailer writes the confirmation email there) and
   KITSYUU_DB_URL (owner connection to the LOCAL test database, for set-up and checks). Never touches a hosted database.
   Covers what the customer sees: their code and link, sign-up with a code, where a referral stands, and the reward
   coupons once the server has given them (the reward check itself is the core's, run here against the same database). */
import fs from 'node:fs';
import pg from 'pg';
import {createDb} from '@kitsyuu/db';
import {processReferralRewards} from '@kitsyuu/core';
import {launch} from './cdp.mjs';

const {BASE, SERVER_LOG, KITSYUU_DB_URL} = process.env;
if (!/@localhost[:/]/.test(KITSYUU_DB_URL || '')) throw new Error('referral tests only run against a local database');
const out = []; const ok = (n, p, x = '') => { const l = `${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`; out.push(l); console.log(l); };
const w = ms => new Promise(r => setTimeout(r, ms));
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const jobDb = createDb({connectionString: KITSYUU_DB_URL, max: 2});
const PW = 'correct horse battery staple';

const b = await launch(9444); const ev = e => b.eval(e);
const until = async (x, ms = 15000) => { for (let t = 0; t < ms; t += 120) { try { if (await ev(x)) return true; } catch {} await w(120); } return false; };
const go = async (p, ready = 'document.readyState === "complete" && !!document.querySelector("main")') => { await b.goto(BASE + p, ready); };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel}');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
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
/** Creates an account through the sign-up page (optionally from a referral link) and confirms its email. */
async function signUp(email, name, ref) {
  await b.send('Network.clearBrowserCookies');
  await go(`/signup${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, '!!document.querySelector("main [name=email]")');
  const carried = await ev(`document.querySelector('main input[name=ref]')?.value ?? null`);
  await fill('main [name=fullName]', name); await fill('main [name=email]', email); await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
  await submit();
  await b.goto(lastLink(email), 'document.readyState === "complete"');
  await until(`location.pathname === '/account'`);
  return carried;
}
async function logIn(email) {
  await b.send('Network.clearBrowserCookies');
  await go('/login', '!!document.querySelector("main [name=email]")');
  await fill('main [name=email]', email); await fill('main [name=password]', PW);
  await submit();
  return until(`location.pathname.startsWith('/account')`);
}

try {
  await b.viewport(1440, 900);
  await b.send('Network.clearBrowserCookies');
  await go('/account/referrals', 'document.readyState === "complete"');
  ok('guest → the referral page asks to log in', (await ev('location.pathname + location.search')) === '/login?next=%2Faccount%2Freferrals');

  // ---------- referrals switched off (the default) ----------
  await signUp('ref.e2e.anu@test.local', 'Anu Referrer');
  await go('/account/referrals', '!!document.querySelector("main h1")');
  ok('switched off: the page says so and shows no code', (await exists('[data-referrals-off]')) && !(await exists('[data-referral-code]')) && (await q(`select count(*)::int n from referral_codes`))[0].n === 0);
  ok('the account menu has "Refer a friend"', await ev(`[...document.querySelectorAll('nav a')].some(a => a.getAttribute('href') === '/account/referrals' && /Refer a friend/.test(a.textContent))`));

  // ---------- switched on (in this LOCAL test database; the reward values are the ones the migration set) ----------
  await q(`insert into settings (key, value) values ('referrals.enabled', '"on"') on conflict (key) do update set value = excluded.value`);
  await go('/account/referrals', '!!document.querySelector("[data-referral-code]")');
  const code = (await text('[data-referral-code]')).trim();
  const terms = await text('[data-referral-terms]');
  ok('the customer gets their own code and a sign-up link carrying it', /^[A-Z2-9]{8}$/.test(code) && (await text('[data-referral-link]')).includes(`/signup?ref=${code}`) && (await q(`select code from referral_codes`))[0].code === code, code);
  ok('the terms shown are the configured ones: ₹200 each, on ₹1,000 or more, valid 30 days, after the first delivered order', /you each receive a ₹200(.00)? coupon for an order of ₹1,000(.00)? or more, valid for 30 days/.test(terms) && /only for new customers, once, and not for your own account/.test(terms), terms);
  ok('nothing yet: no rewards, nobody referred', (await exists('[data-no-rewards]')) && (await exists('[data-no-referrals]')));
  await go('/account/referrals', '!!document.querySelector("[data-referral-code]")');
  ok('opening the page again keeps the same code', (await text('[data-referral-code]')).trim() === code && (await q(`select count(*)::int n from referral_codes`))[0].n === 1);

  // ---------- a friend signs up from the link ----------
  await b.send('Network.clearBrowserCookies');
  await go('/signup?ref=%3Cscript%3Ealert(1)%3C%2Fscript%3E', '!!document.querySelector("main [name=email]")');
  ok('a link with something that is not a code carries nothing into the form', !(await exists('main input[name=ref]')) && !(await exists('[data-signup-referral]')));
  const carried = await signUp('ref.e2e.bala@test.local', 'Bala Friend', code.toLowerCase());
  const [bala] = await q(`select id from customers where email = 'ref.e2e.bala@test.local'`);
  const [anu] = await q(`select id from customers where email = 'ref.e2e.anu@test.local'`);
  const [r1] = await q(`select referrer_id, status, code from referrals where referred_id = $1`, [bala.id]);
  ok('sign-up from the link: the form carries the code and the new account is attributed to the referrer, waiting', carried === code && r1?.referrer_id === anu.id && r1.status === 'pending' && r1.code === code, JSON.stringify(r1));
  await go('/account/referrals', '!!document.querySelector("[data-referral-code]")');
  ok('the new customer sees their own code and no reward yet (a code entered is not a reward)', (await text('[data-referral-code]')).trim() !== code && (await exists('[data-no-rewards]')) && (await exists('[data-no-referrals]')));
  // Signing up again with the referrer's own email and their own code changes nothing (no self-referral, no second attribution).
  await b.send('Network.clearBrowserCookies');
  await go(`/signup?ref=${code}`, '!!document.querySelector("main [name=email]")');
  await fill('main [name=fullName]', 'Anu Again'); await fill('main [name=email]', 'ref.e2e.anu@test.local'); await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
  await submit();
  ok('an existing account using its own code: nothing is attributed', (await q(`select count(*)::int n from referrals`))[0].n === 1);

  // ---------- the referrer's view; then the reward, once the friend's first order is delivered ----------
  ok('the referrer logs in', await logIn('ref.e2e.anu@test.local'));
  await go('/account/referrals', '!!document.querySelector("[data-referrals]")');
  ok('the referrer sees one referral, waiting, without the friend\'s name or email', (await ev(`[...document.querySelectorAll('[data-referrals] li')].map(l=>l.dataset.referralState).join()`)) === 'pending'
    && /Waiting for their first delivered order/.test(await text('[data-referrals]')) && !/bala|Bala|@/.test(await text('#st-ref-list')) && (await exists('[data-no-rewards]')));
  const [o] = await q(`insert into orders (order_number, customer_id, status, payment_status, subtotal_paise, total_paise, contact, shipping_address, paid_at) values ('KTS-REF-E2E', $1, 'delivered', 'paid', 250000, 250000, '{}', '{}', now()) returning id`, [bala.id]);
  await q(`insert into order_status_history (order_id, from_status, to_status) values ($1, 'shipped', 'delivered')`, [o.id]);
  const run = await processReferralRewards(jobDb);
  ok('the reward check (returns are off here, so no return period): the referral is rewarded, one coupon each', run.rewarded === 1 && (await q(`select count(*)::int n from referral_rewards`))[0].n === 2, JSON.stringify(run));
  await go('/account/referrals', '!!document.querySelector("[data-referral-rewards]")');
  const mine = await text('[data-referral-rewards]');
  ok('the referrer now sees the referral as rewarded and holds a ₹200 coupon: its code, its minimum order and its end date', (await ev(`document.querySelector('[data-referrals] li').dataset.referralState`)) === 'rewarded'
    && /₹200/.test(mine) && /REF-[A-Z2-9]{10}/.test(mine) && /Available/.test(mine) && /For referring a friend/.test(mine) && /on orders of ₹1,000(\.00)? or more/.test(mine) && /until /.test(mine), mine.split('\n').join(' | '));
  const myCode = (await text('[data-reward-code]')).trim();
  ok('the friend logs in', await logIn('ref.e2e.bala@test.local'));
  await go('/account/referrals', '!!document.querySelector("[data-referral-rewards]")');
  const theirs = await text('[data-referral-rewards]');
  ok('the friend holds their own welcome coupon, a different code; neither sees the other\'s', /Welcome reward/.test(theirs) && /₹200/.test(theirs) && !theirs.includes(myCode) && (await ev(`document.querySelectorAll('[data-referral-rewards] li').length`)) === 1, theirs);

  // ---------- phone width ----------
  await b.viewport(390, 844, true);
  await go('/account/referrals', '!!document.querySelector("[data-referral-code]")');
  ok('phone: the referral page has no sideways scrolling (the long link wraps)', await ev('document.documentElement.scrollWidth <= innerWidth + 1'));
  ok('no page errors during the run', b.errors.filter(e => !/http 40[34]|favicon/.test(e)).length === 0, b.errors.filter(e => !/http 40[34]|favicon/.test(e)).slice(0, 3).join(' | '));
} catch (e) {
  ok('referral tests ran to the end', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally { b.close(); await pool.end(); await jobDb.destroy(); }

const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
