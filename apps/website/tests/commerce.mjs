/* M7 commerce browser tests: guest cart → login (cart merged) → saved cart → checkout → payment → confirmation, plus
   failure states and tampering. Started by tests/run-account.mjs with:
   BASE (test payment provider), RZP_BASE (Razorpay adapter + local fake Razorpay), DOWN_BASE (database unreachable),
   FAKE_RZP_URL, RZP_WEBHOOK_SECRET, SERVER_LOG (console mailer) and KITSYUU_DB_URL (owner connection to the LOCAL test DB).
   No real payments, no network beyond the public catalogue read. */
import fs from 'node:fs';
import {createHmac} from 'node:crypto';
import pg from 'pg';
import {launch} from './cdp.mjs';

const {BASE, RZP_BASE, DOWN_BASE, FAKE_RZP_URL, RZP_WEBHOOK_SECRET, SERVER_LOG, KITSYUU_DB_URL, TEST_REFUSED_BASE, NO_PROVIDER_BASE, TEST_REFUSED_LOG, CRON_SECRET, RZP_SERVER_LOG} = process.env;
const RETURNS_POLICY = 'All sales are final. We do not accept returns or offer refunds.';
const mailsAbout = (log, orderNumber) => fs.readFileSync(log, 'utf8').split(`subject="Your KITSYUU order ${orderNumber} is confirmed"`).length - 1;
if (!/@localhost[:/]/.test(KITSYUU_DB_URL || '')) throw new Error('commerce tests only run against a local database');
const out = []; const ok = (n, p, x = '') => { const l = `${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`; out.push(l); console.log(l); };
const w = ms => new Promise(r => setTimeout(r, ms));
const pool = new pg.Pool({connectionString: KITSYUU_DB_URL, max: 1});
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const PW = 'correct horse battery staple';

const b = await launch(9442); const ev = e => b.eval(e);
const until = async (x, ms = 15000) => { for (let t = 0; t < ms; t += 120) { if (await ev(x).catch(() => false)) return true; await w(120); } return false; };
const go = async (url, ready = 'document.readyState==="complete"') => { await b.goto(url.startsWith('http') ? url : BASE + url, ready); };
const fill = (sel, v) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no field ${sel}');
  const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('missing ${sel}');e.click();return true})()`);
const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const exists = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const loc = () => ev('location.pathname + location.search');
const MAIN_FORM = 'main form:not(:has([data-logout]))';
const submit = async (formSel = MAIN_FORM) => {
  const start = await ev('location.href'), sel = JSON.stringify(formSel);
  // Wait until React has hydrated the form (its handlers are attached); a click before that is a plain browser submission.
  await until(`(()=>{const f=document.querySelector(${sel});return !!f && Object.keys(f).some(k=>k.startsWith('__reactProps'))})()`, 20000);
  await ev(`(()=>{const f=document.querySelector(${sel});window.__submitSeen=false;const o=new MutationObserver(()=>{if(f.hasAttribute('aria-busy'))window.__submitSeen=true});
    o.observe(f,{attributes:true,attributeFilter:['aria-busy']});f.querySelector('button[type=submit]').click();return true})()`);
  await until(`location.href !== ${JSON.stringify(start)} || (window.__submitSeen === true && !document.querySelector(${sel})?.hasAttribute('aria-busy'))`, 20000);
  await w(300);
};
const lastLink = to => {
  const t = fs.readFileSync(SERVER_LOG, 'utf8'), start = t.lastIndexOf(`[mail:begin] to=${to} `);
  return start < 0 ? null : t.slice(start, t.indexOf('[mail:end]', start)).match(/https?:\/\/\S+token=[A-Za-z0-9_-]{43}/)?.[0] ?? null;
};
const cookieOf = async () => (await b.send('Network.getCookies', {urls: [BASE]})).cookies.find(c => c.name === '__Host-kitsyuu_customer');
const setCookie = c => b.send('Network.setCookie', {name: c.name, value: c.value, url: BASE, path: '/', secure: true, httpOnly: true, sameSite: 'Lax'});
const cartBadge = () => ev(`document.querySelector('[data-badge=cart]')?.textContent`);
const overflow = () => ev('document.documentElement.scrollWidth - innerWidth');
const errs = () => b.errors.filter(e => !/http 40[134]|http 503|http 500/.test(e));
const allErrors = [];
const check = () => allErrors.push(...errs());

const products = await q(`select p.id, p.slug, p.name, p.price_paise, v.id vid, v.size from products p
  join lateral (select id, size from product_variants where product_id = p.id and is_active order by sort_order limit 1) v on true
  where p.id in ('ky-proto-020','ky-proto-021','ky-proto-022') order by p.id`);
const [P1, P2, P3] = products;
const stock = async vid => (await q(`select stock_qty from product_variants where id = $1`, [vid]))[0].stock_qty;
const setStock = async (vid, to) => { const d = to - await stock(vid); if (d) await q(`select public.adjust_stock($1, $2, 'correction', null, 'browser test', null)`, [vid, d]); };
const customerId = async email => (await q(`select id from customers where email = $1`, [email]))[0]?.id;
const ordersOf = async email => q(`select o.order_number, o.status, o.payment_status, o.total_paise from orders o join customers c on c.id = o.customer_id where c.email = $1 order by o.created_at`, [email]);

async function addToCart(base, p, qty = 1) {
  await go(`${base}/product/${p.slug}`, '!!document.querySelector(".st-buy")');
  // Like a shopper, act once the page has settled: a guest is known, or a signed-in customer's saved cart has loaded
  // (/api/store answered). Clicking earlier puts the item in the browser cart until the next page view (known gap, reported).
  await until(`(()=>{const a=document.querySelector('.st-tool-account')?.dataset.auth;
    return a==='guest' || (a==='customer' && performance.getEntriesByType('resource').some(e=>/\\/api\\/store$/.test(e.name)))})()`);
  await w(200);
  await ev(`(document.querySelector('input[name=size][value="${p.size}"]').click(),true)`);
  await fill('#st-qty', String(qty));
  await ev(`(document.querySelector('.st-buy button[type=submit]').click(),true)`);
  return until(`/Added to cart|maximum/.test(document.querySelector('#st-buy-status')?.innerText || '')`);
}
async function signupAndConfirm(email, name) {
  await go('/signup', '!!document.querySelector("main [name=email]")');
  await fill('main [name=fullName]', name); await fill('main [name=email]', email); await fill('main [name=password]', PW); await fill('main [name=confirm]', PW);
  await submit();
  await go(lastLink(email), '!!document.querySelector("main h1")');
  return until(`location.pathname === '/account'`);
}
async function placeOrder(base = BASE) {
  await go(`${base}/checkout`, '!!document.querySelector("#st-checkout-form, [data-checkout-problems], [data-no-address], .st-empty")');
  const start = await ev('location.href');
  await ev(`(document.querySelector('#st-checkout-form button[type=submit]').click(),true)`);
  await until(`location.href !== ${JSON.stringify(start)} && location.pathname.startsWith('/checkout/pay/')`, 20000);
  await until(`!!document.querySelector('[data-payment-widget], [data-payment-unavailable]')`);
  return decodeURIComponent((await ev('location.pathname')).split('/').pop());
}

try {
  for (const [W, H, mob, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
    await b.viewport(W, H, mob);
    await b.send('Network.clearBrowserCookies');
    await go('/'); await ev('localStorage.clear(), sessionStorage.clear(), true');
    const email = `buyer.${tag}@test.local`;

    // ---------- guest ----------
    ok(`[${tag}] guest adds to cart (kept in this browser)`, await addToCart(BASE, P1, 2) && (await ev(`JSON.parse(localStorage.getItem('kitsyuu-cart-v1')||'[]').length`)) === 1);
    await go('/cart', '!!document.querySelector(".st-summary")');
    ok(`[${tag}] guest cart states that shipping is not set up yet (same wording as checkout)`, (await text('.st-summary [data-shipping]')) === 'Not set up yet');
    await go('/checkout', '!!document.querySelector("main h1")');
    ok(`[${tag}] guest checkout asks to log in; the cart is kept`, await exists('[data-checkout-login]') && !(await exists('#st-checkout-form'))
      && (await ev(`JSON.parse(localStorage.getItem('kitsyuu-cart-v1')||'[]').length`)) === 1);
    ok(`[${tag}] the prototype checkout is gone (no "not a real purchase" / prototype order wording)`, !/prototype (checkout|order)|not a real purchase/i.test(await text('main')));

    // ---------- login merges the guest cart ----------
    ok(`[${tag}] signs up and confirms`, await signupAndConfirm(email, 'Meera Iyer'));
    const cid = await customerId(email);
    const merged = await until(`JSON.parse(localStorage.getItem('kitsyuu-cart-v1')||'[]').length === 0`);
    const dbLines = await q(`select i.qty from cart_items i join carts c on c.id = i.cart_id where c.customer_id = $1 and c.status = 'active'`, [cid]);
    ok(`[${tag}] after login the guest cart moves to the account (saved in the database, cleared from the browser)`, merged && dbLines.length === 1 && dbLines[0].qty === 2, JSON.stringify(dbLines));
    await until(`document.querySelector('[data-badge=cart]')?.textContent === '2'`);
    ok(`[${tag}] header count shows the saved cart`, (await cartBadge()) === '2');

    // ---------- cart page: server totals ----------
    await go('/cart', '!!document.querySelector("[data-total]")');
    const total = await text('[data-total]');
    ok(`[${tag}] cart page shows server-priced totals; shipping is shown as not set up (nothing invented)`,
      total.includes(new Intl.NumberFormat('en-IN').format(P1.price_paise * 2 / 100)) && /Not set up yet/.test(await text('[data-shipping]')), total);
    await ev(`(document.querySelector('[data-line-step="1"]').click(),true)`);
    ok(`[${tag}] quantity change is saved on the server`, await until(`document.querySelector('[data-badge=cart]')?.textContent === '3'`)
      && (await q(`select i.qty from cart_items i join carts c on c.id = i.cart_id where c.customer_id = $1 and c.status = 'active'`, [cid]))[0].qty === 3);

    // ---------- checkout needs an address ----------
    await go('/checkout', '!!document.querySelector("main h1")');
    ok(`[${tag}] checkout without an address asks for one`, await exists('[data-no-address]'));
    await click('[data-no-address] a');
    await until(`location.pathname === '/account/addresses/new' && !!document.querySelector('main [name=fullName]')`);
    await fill('main [name=fullName]', 'Meera Iyer'); await fill('main [name=phone]', '9812345678'); await fill('main [name=line1]', '21 Lake View Road');
    await fill('main [name=city]', 'Bengaluru'); await fill('main [name=state]', 'Karnataka'); await fill('main [name=pin]', '560001');
    await submit();
    ok(`[${tag}] adding an address returns to checkout with it selected`, await until(`location.pathname === '/checkout' && !!document.querySelector('#st-checkout-form input[name=addressId]:checked')`));
    ok(`[${tag}] checkout shows the returns policy before payment (and the footer states it)`, (await text('#st-checkout-form [data-returns-policy]')) === RETURNS_POLICY
      && (await text('footer [data-returns-policy]')) === RETURNS_POLICY);

    // ---------- tampering and stale totals ----------
    await ev(`(document.querySelector('#st-checkout-form input[name=expectedTotalPaise]').value='100',true)`);
    await submit('#st-checkout-form');
    ok(`[${tag}] a changed total (tampered or stale) is refused and nothing is ordered`, /changed since/.test(await text('#st-checkout-form [data-form-message]')) && (await ordersOf(email)).length === 0,
      await text('#st-checkout-form [data-form-message]'));

    // ---------- out of stock ----------
    const before = await stock(P1.vid);
    await setStock(P1.vid, 1);
    await go('/checkout', '!!document.querySelector("main h1")');
    ok(`[${tag}] checkout explains a size that no longer has enough stock and offers no order button`, /Only 1 left/.test(await text('[data-checkout-problems]')) && !(await exists('#st-checkout-form')));
    await go('/cart', '!!document.querySelector("[data-line-problem]")');
    ok(`[${tag}] cart shows the problem on the line and blocks checkout`, /Only 1 left/.test(await text('[data-line-problem]')) && (await exists('[data-cart-blocked]')));
    await setStock(P1.vid, before);

    // ---------- place order (double click → one order) ----------
    await go('/checkout', '!!document.querySelector("#st-checkout-form")');
    await ev(`(()=>{const btn=document.querySelector('#st-checkout-form button[type=submit]');btn.click();btn.click();return true})()`);
    await until(`location.pathname.startsWith('/checkout/pay/')`, 20000);
    await until(`!!document.querySelector('[data-payment-widget=test]')`);
    let orders = await ordersOf(email);
    ok(`[${tag}] placing the order creates exactly one order (double click)`, orders.length === 1 && orders[0].status === 'pending_payment');
    const orderNumber = orders[0].order_number;
    ok(`[${tag}] stock is held by the order through the ledger`, (await stock(P1.vid)) === before - 3
      && (await q(`select sum(delta)::int n from inventory_movements m join orders o on o.id = m.order_id where o.order_number = $1`, [orderNumber]))[0].n === -3);

    // ---------- payment: declined, then paid ----------
    await click('[data-test-pay=failure]');
    ok(`[${tag}] a declined payment is explained; the order can still be paid`, await until(`document.querySelector('[data-payment-note]')?.dataset.paymentNote === 'declined'`)
      && (await ordersOf(email))[0].status === 'payment_failed');
    const payLayout = await ev(`(()=>{const h=document.getElementById('st-pay-title').getBoundingClientRect(),n=document.querySelector('[data-payment-note]').getBoundingClientRect();return {headingBottom:Math.round(h.bottom),noteTop:Math.round(n.top)}})()`);
    ok(`[${tag}] payment page: the alert starts below the Payment heading (no overlap)`, payLayout.noteTop >= payLayout.headingBottom, JSON.stringify(payLayout));
    await click('[data-test-pay=success]');
    ok(`[${tag}] a successful payment leads to the confirmation page`, await until(`location.pathname === '/checkout/complete/${orderNumber}'`, 20000));
    await until(`!!document.querySelector('[data-order-number]')`);
    ok(`[${tag}] confirmation: order number, paid status, items, contact and delivery details`,
      (await text('[data-order-number]')) === orderNumber && (await ev(`document.querySelector('[data-payment-status]').dataset.paymentStatus`)) === 'paid'
      && /Meera Iyer/.test(await text('main')) && /21 Lake View Road/.test(await text('main')) && /Thank you/i.test(await text('main h1')));
    orders = await ordersOf(email);
    ok(`[${tag}] the order is paid in the database; the cart is closed`, orders[0].status === 'paid' && orders[0].payment_status === 'paid'
      && (await until(`document.querySelector('[data-badge=cart]')?.textContent === '0'`)));
    ok(`[${tag}] confirmation page: no horizontal overflow`, (await overflow()) <= 0);
    ok(`[${tag}] order confirmation email sent once, to the customer`, mailsAbout(SERVER_LOG, orderNumber) === 1
      && fs.readFileSync(SERVER_LOG, 'utf8').includes(`[mail:begin] to=${email} subject="Your KITSYUU order ${orderNumber} is confirmed"`));
    // Customer texts state facts only: no notification promise (no email/notification service yet), no claim that nothing is processed.
    const confirmText = await ev('document.body.innerText');
    ok(`[${tag}] confirmation promises no shipment notification`, /Your order is confirmed./.test(confirmText) && !/let you know|notify|we will (email|send)/i.test(confirmText));
    ok(`[${tag}] footer no longer says that orders, payments or sign-ups are not processed`, !/No orders, payments or sign-ups are processed/i.test(confirmText)
      && !/prototype/i.test(await text('footer')) && (await text('footer [data-returns-policy]')) === RETURNS_POLICY);
    await b.shot(`m7-${tag}-confirmation.png`, true);
    await go(`/checkout/pay/${orderNumber}`, '!!document.querySelector("main h1")');
    ok(`[${tag}] a paid order cannot be paid again (sent to its confirmation)`, (await loc()) === `/checkout/complete/${orderNumber}`);
    await go(`/account/orders/${orderNumber}`, '!!document.querySelector("main h1")');
    ok(`[${tag}] account order history shows the order, without pay or cancel actions`, (await ev(`document.querySelector('[data-order-status]').dataset.orderStatus`)) === 'paid'
      && !(await exists('[data-pay-order]')) && !(await exists('#st-cancel-order')));
    // Layout: items and progress sit under their headings at full width; nothing is pushed past the screen edge.
    const layout = await ev(`(()=>{const item=document.querySelector('.st-order-item').getBoundingClientRect();
      const xs=[...document.querySelectorAll('.st-order-timeline li')].map(l=>Math.round(l.getBoundingClientRect().left));
      const past=[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).length;
      return {itemWidth:Math.round(item.width),itemTop:Math.round(item.top),heading:Math.round(document.getElementById('st-ord-items').getBoundingClientRect().bottom),timelineX:[...new Set(xs)],past}})()`);
    ok(`[${tag}] order detail layout: items under the heading at full width, one timeline column, nothing off-screen`, layout.itemTop >= layout.heading && layout.itemWidth >= (W > 500 ? 500 : 300)
      && layout.timelineX.length === 1 && layout.past === 0, JSON.stringify(layout));
    check();

    // ---------- another customer cannot reach it ----------
    const meera = await cookieOf();
    await b.send('Network.clearBrowserCookies');
    ok(`[${tag}] second customer signs up`, await signupAndConfirm(`other.${tag}@test.local`, 'Other Person'));
    for (const p of [`/checkout/complete/${orderNumber}`, `/checkout/pay/${orderNumber}`, `/account/orders/${orderNumber}`]) {
      await go(p, '!!document.querySelector("main")');
      ok(`[${tag}] another customer → ${p.split('/').slice(0, 3).join('/')}/… is not found`, /not found/i.test(await text('main')) && !(await text('main')).includes('Lake View'));
    }
    await b.send('Network.clearBrowserCookies'); await setCookie(meera);

    // ---------- cancel an unpaid order ----------
    await addToCart(BASE, P2, 1);
    const before2 = await stock(P2.vid);
    const second = await placeOrder();
    await go(`/account/orders/${second}`, '!!document.querySelector("#st-cancel-order")');
    ok(`[${tag}] an unpaid order offers Pay and Cancel`, (await exists('[data-pay-order]')) && (await exists('#st-cancel-order')));
    await ev(`window.confirm = () => true, true`);
    await submit('#st-cancel-order');
    await until(`/cancelled/i.test(document.querySelector('main')?.innerText || '')`);
    const cancelled = {main: (await text('.st-account-main') || await text('main')).slice(0, 160), stock: [before2, await stock(P2.vid)], status: (await ordersOf(email)).find(o => o.order_number === second)?.status};
    ok(`[${tag}] cancelling returns the stock and the order shows as cancelled`, /cancelled/i.test(cancelled.main)
      && cancelled.stock[1] === before2 && cancelled.status === 'cancelled', JSON.stringify(cancelled));   // before2 = stock before the order took its unit
    await go(`/account/orders/${second}`, '!!document.querySelector("main h1")');
    ok(`[${tag}] a cancelled order promises no refund (no refund policy or provider is configured)`, /This order was cancelled./.test(await text('main')) && !/refund/i.test(await text('main')));
    ok(`[${tag}] a cancelled unpaid order shows its payment as not paid (no active pending payment)`, (await ev(`document.querySelector('[data-payment-status]')?.dataset.paymentStatus`)) === 'unpaid'
      && (await q(`select p.status from payments p join orders o on o.id = p.order_id where o.order_number = $1`, [second])).every(p => p.status === 'failed'));

    // ---------- expired session at checkout ----------
    await addToCart(BASE, P3, 1);
    await go('/checkout', '!!document.querySelector("#st-checkout-form")');
    await b.send('Network.deleteCookies', {name: '__Host-kitsyuu_customer', url: BASE});
    await ev(`(document.querySelector('#st-checkout-form button[type=submit]').click(),true)`);
    ok(`[${tag}] an ended session at checkout leads to login (and back to checkout afterwards)`, await until(`location.pathname === '/login'`, 20000)
      && (await ev('location.search')).includes('next=%2Fcheckout'));
    await setCookie(meera);

    // ---------- network interruption during payment ----------
    const third = await placeOrder();
    await b.send('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await click('[data-test-pay=success]');
    const offlineNote = await until(`/could not reach/i.test(document.querySelector('[data-payment-note]')?.innerText || '')`);
    await b.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    ok(`[${tag}] network cut during payment: explained, nothing marked paid`, offlineNote && (await ordersOf(email)).find(o => o.order_number === third).status === 'pending_payment');
    await click('[data-test-pay=success]');
    ok(`[${tag}] after the connection returns the same order can be paid`, await until(`location.pathname === '/checkout/complete/${third}'`, 20000));

    // ---------- mobile / desktop layout ----------
    await addToCart(BASE, P1, 1);
    for (const p of ['/cart', '/checkout']) {
      await go(p, '!!document.querySelector("main h1")');
      ok(`[${tag}] ${p}: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    }
    await b.shot(`m7-${tag}-checkout.png`, true);
    check();
  }

  // ---------- Razorpay adapter in the browser (fake Razorpay; same database and session) ----------
  await b.viewport(1440, 900);
  const email = 'buyer.mobile@test.local';        // still signed in as the mobile customer from the loop above
  await go(`${RZP_BASE}/checkout`, '!!document.querySelector("#st-checkout-form")');
  const start = await ev('location.href');
  await ev(`(document.querySelector('#st-checkout-form button[type=submit]').click(),true)`);
  await until(`location.href !== ${JSON.stringify(start)} && !!document.querySelector('[data-pay-open]:not([disabled])')`, 20000);
  const rzpOrder = decodeURIComponent((await ev('location.pathname')).split('/').pop());
  await click('[data-pay-open]'); await until(`!!document.querySelector('[data-fake-razorpay]')`);
  await click('[data-fake-dismiss]');
  ok('[razorpay] closing the payment window keeps the order payable', await until(`/window was closed/.test(document.querySelector('[data-payment-note]')?.innerText || '')`));
  await click('[data-pay-open]'); await until(`!!document.querySelector('[data-fake-razorpay]')`);
  await click('[data-fake-pay=fail]');
  ok('[razorpay] a declined payment (confirmed with Razorpay) is explained', await until(`document.querySelector('[data-payment-note]')?.dataset.paymentNote === 'declined'`)
    && (await ordersOf(email)).find(o => o.order_number === rzpOrder).status === 'payment_failed');
  await click('[data-pay-open]'); await until(`!!document.querySelector('[data-fake-razorpay]')`);
  await click('[data-fake-pay=success]');
  const reached = await until(`location.pathname === '/checkout/complete/${rzpOrder}'`, 20000);
  const rows = (await q(`select p.status from payments p join orders o on o.id = p.order_id where o.order_number = $1 and p.provider = 'razorpay'`, [rzpOrder])).map(r => r.status).sort();
  ok('[razorpay] paying in the Razorpay window: signature + read-back → confirmation', reached && rows.join() === 'captured,failed',
    JSON.stringify({reached, at: await loc(), rows, note: await text('[data-payment-note]')}));

  // Razorpay not answering: the pay page explains; the order is kept.
  await addToCart(RZP_BASE, P2, 1);
  await fetch(`${FAKE_RZP_URL}/__test/mode`, {method: 'POST', body: JSON.stringify({down: true})});
  const down = await placeOrder(RZP_BASE);
  ok('[razorpay] payment service unavailable: explained, order kept', /not responding/.test(await text('[data-payment-unavailable]')) && (await ordersOf(email)).some(o => o.order_number === down && o.status === 'pending_payment'));
  await fetch(`${FAKE_RZP_URL}/__test/mode`, {method: 'POST', body: JSON.stringify({down: false})});
  await go(`${RZP_BASE}/checkout/pay/${down}`, '!!document.querySelector("[data-pay-open]")');
  ok('[razorpay] when the service is back the order can be paid', await exists('[data-pay-open]'));

  // Webhook: the order is paid by Razorpay's signed notification alone (the customer never returned to the site).
  const [{provider_order_id: session}] = await q(`select p.provider_order_id from payments p join orders o on o.id = p.order_id where o.order_number = $1`, [down]);
  const {payment} = await (await fetch(`${FAKE_RZP_URL}/__test/pay`, {method: 'POST', body: JSON.stringify({order_id: session, outcome: 'success'})})).json();
  const body = JSON.stringify({entity: 'event', event: 'payment.captured', payload: {payment: {entity: payment}}});
  const sig = createHmac('sha256', RZP_WEBHOOK_SECRET).update(body).digest('hex');
  const hook = (s, id = 'evt_browser000001') => fetch(`${RZP_BASE}/api/payments/webhook/razorpay`, {method: 'POST', headers: {'content-type': 'application/json', 'x-razorpay-signature': s, 'x-razorpay-event-id': id}, body});
  ok('[razorpay] webhook with a wrong signature → 401, nothing changes', (await hook('0'.repeat(64))).status === 401 && (await ordersOf(email)).find(o => o.order_number === down).status === 'pending_payment');
  ok('[razorpay] signed webhook marks the order paid', (await hook(sig)).status === 200 && (await ordersOf(email)).find(o => o.order_number === down).status === 'paid');
  ok('[razorpay] the same event again is acknowledged and ignored', (await hook(sig)).status === 200
    && (await q(`select count(*)::int n from payments p join orders o on o.id = p.order_id where o.order_number = $1 and p.status = 'captured'`, [down]))[0].n === 1);
  ok('[razorpay] an order paid by the webhook alone gets exactly one confirmation email (not one per delivery)', mailsAbout(RZP_SERVER_LOG, down) === 1);
  // Oversized webhook bodies are refused before being read into memory, with or without a Content-Length.
  const big = 'x'.repeat(300 * 1024);
  const declared = await fetch(`${RZP_BASE}/api/payments/webhook/razorpay`, {method: 'POST', headers: {'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_browser000002'}, body: big});
  ok('[webhook] oversized body with Content-Length → 413', declared.status === 413);
  const chunked = new ReadableStream({start(c) { for (let i = 0; i < 30; i++) c.enqueue(new TextEncoder().encode('y'.repeat(10 * 1024))); c.close(); }});
  const streamed = await fetch(`${RZP_BASE}/api/payments/webhook/razorpay`, {method: 'POST', duplex: 'half', headers: {'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_browser000003'}, body: chunked});
  ok('[webhook] oversized chunked body (no Content-Length) → 413', streamed.status === 413);
  ok('[webhook] a body under the limit is still verified as before (wrong signature → 401)', (await hook('1'.repeat(64), 'evt_browser000005')).status === 401);
  ok('[webhook] refused oversized events were not stored', (await q(`select count(*)::int n from payment_events where id in ('razorpay:evt_browser000002','razorpay:evt_browser000003')`))[0].n === 0);
  check();

  // ---------- payment provider configuration fails safe ----------
  // :3015 has PAYMENT_PROVIDER=test in a production build WITHOUT the explicit test flag; :3016 has no provider (the default).
  for (const [base, label] of [[TEST_REFUSED_BASE, 'test provider in production without the explicit flag'], [NO_PROVIDER_BASE, 'no payment provider configured']]) {
    const added = await addToCart(base, P3, 1);
    await go(`${base}/checkout`, '!!document.querySelector("main h1")');
    ok(`[config] ${label}: checkout says payment is not set up and offers no order button`, (await exists('[data-no-payments]')) && !(await exists('#st-checkout-form')),
      JSON.stringify({added, status: await text('#st-buy-status'), main: (await text('main')).slice(0, 200)}));
  }
  ok('[config] the refused test provider is logged as an error on that server', /PAYMENT_PROVIDER=test is refused in production/.test(fs.readFileSync(TEST_REFUSED_LOG, 'utf8')));
  ok('[config] a production build with the explicit test flag logs a loud warning', /WARNING: the TEST payment provider is enabled in a production build/.test(fs.readFileSync(SERVER_LOG, 'utf8')));
  ok('[config] the example environment leaves the payment provider unset', /^PAYMENT_PROVIDER=s*$/m.test(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8')));

  // ---------- demo polish: labels and captions ----------
  await b.viewport(1440, 900);
  const signedIn = await cookieOf();
  await b.send('Network.clearBrowserCookies');
  await go('/product/asymmetric-zip-collar-top', '!!document.querySelector(".st-pdp-meta")');
  const crumbs = await ev(`[...document.querySelectorAll('.st-crumbs li')].map(l=>l.innerText.trim())`);
  ok('[polish] a subcategory named like its category is shown once (product meta and breadcrumb)', (await text('.st-pdp-meta b')).toUpperCase() === 'TOPS'
    && !crumbs.some((c, i) => i > 0 && c.toUpperCase() === crumbs[i - 1].toUpperCase()), JSON.stringify({meta: await text('.st-pdp-meta b'), crumbs}));
  await go('/', '!!document.querySelector(".st-brand-hero")');
  await until(`document.querySelector('.st-tool-account')?.dataset.auth === 'guest'`);
  const account = await ev(`(()=>{const l=document.querySelector('.st-tool-account .st-tool-label');return {text:l.innerText,lines:l.getClientRects().length,height:Math.round(l.getBoundingClientRect().height)}})()`);
  ok('[polish] "Log in" stays on one line in the 1440 px header', account.lines === 1 && account.height < 20, JSON.stringify(account));
  ok('[polish] no "concept image / not a catalogue item" captions in the store (the preserved landing keeps its own wording)', !/not a catalogue item/i.test(await ev('document.body.innerText'))
    && !(await exists('main .st-caption')));
  ok('[polish] the 1440 px header does not overflow', (await ev('document.documentElement.scrollWidth - innerWidth')) <= 0);
  await setCookie(signedIn);

  // ---------- no prototype wording on the store ----------
  for (const p of ['/shop', `/product/${P1.slug}`, '/cart']) {
    await go(p, '!!document.querySelector("main h1")');
    const body = await ev('document.body.innerText + " " + document.title');
    ok(`[wording] ${p}: no "prototype" or estimated-price wording`, !/prototype|EST.|estimated|not confirmed company data/i.test(body), (body.match(/.{0,40}(prototype|EST.|estimated).{0,40}/i) || [''])[0]);
  }

  // ---------- scheduled expiry of unpaid orders (10-day hold, daily job) ----------
  await addToCart(BASE, P2, 1);
  const unpaid = await placeOrder(BASE);
  const [held] = await q(`select id, payment_expires_at from orders where order_number = $1`, [unpaid]);
  ok('[expiry] a new unpaid order holds its stock for 10 days', Math.abs(new Date(held.payment_expires_at) - Date.now() - 10 * 86_400_000) < 3_600_000);
  const stockHeld = await stock(P2.vid);
  await q(`update orders set payment_expires_at = now() - interval '1 minute' where id = $1`, [held.id]);
  const job = auth => fetch(`${BASE}/api/jobs/expire-orders`, {headers: auth ? {authorization: `Bearer ${auth}`} : {}});
  ok('[expiry] the job endpoint refuses a wrong or missing secret (404)', (await job('x'.repeat(48))).status === 404 && (await job()).status === 404);
  const run = await job(CRON_SECRET);
  const result = await run.json();
  ok('[expiry] the daily job (Vercel Cron, GET + CRON_SECRET) cancels the expired order and returns its stock', run.status === 200 && result.expired >= 1
    && (await q(`select status from orders where id = $1`, [held.id]))[0].status === 'cancelled' && (await stock(P2.vid)) === stockHeld + 1, JSON.stringify(result));

  // ---------- database unavailable ----------
  await go(`${DOWN_BASE}/checkout`, '!!document.querySelector("main h1")');
  await until(`/not available right now/i.test(document.body.innerText)`);
  const downText = await ev('document.body.innerText');
  ok('[db down] checkout shows a friendly message, no internal details', /Checkout is not available right now/i.test(downText) && !/ECONN|postgres|stack|at \w+ \(/i.test(downText), downText.slice(0, 300));
  const storeApi = await fetch(`${DOWN_BASE}/api/store`, {headers: {cookie: `__Host-kitsyuu_customer=${(await cookieOf()).value}`}});
  ok('[db down] /api/store answers 503 without details', storeApi.status === 503 && JSON.stringify(await storeApi.json()) === '{"status":"unavailable"}');
  await go(`${DOWN_BASE}/cart`, '!!document.querySelector("main h1")');
  ok('[db down] the store pages still load', /Cart/i.test(await text('main h1')));

  // ---------- endpoints that must stay closed ----------
  ok('provider webhook for a provider that is not configured → 404', (await fetch(`${BASE}/api/payments/webhook/razorpay`, {method: 'POST', body: '{}'})).status === 404);
  ok('scheduled-job endpoint is off without its secret → 404', (await fetch(`${BASE}/api/jobs/expire-orders`, {method: 'POST'})).status === 404);
  const bundles = fs.readdirSync(new URL('../.next/static/chunks/', import.meta.url), {recursive: true}).filter(f => String(f).endsWith('.js'))
    .map(f => fs.readFileSync(new URL(`../.next/static/chunks/${String(f).replace(/\\/g, '/')}`, import.meta.url), 'utf8')).join('\n');
  ok('browser bundles contain no payment secrets or provider secret names', !/RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|PAYMENTS_TEST_SECRET|JOBS_SECRET/.test(bundles));
  const ledger = await q(`select count(*)::int n from product_variants v where v.stock_qty <> (select coalesce(sum(m.delta),0) from inventory_movements m where m.variant_id = v.id)`);
  ok('stock always equals its ledger after every flow', ledger[0].n === 0);
  ok('no unexpected console errors', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('test run', false, e.stack?.split('\n').slice(0, 3).join(' '));
} finally {
  b.close(); await pool.end();
  const pass = out.filter(l => l.startsWith('PASS')).length;
  console.log(`SUMMARY ${pass}/${out.length}`);
  process.exitCode = pass === out.length ? 0 : 1;
}
