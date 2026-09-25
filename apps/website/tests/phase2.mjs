import {launch} from './cdp.mjs';
import fs from 'node:fs';
const B = (process.env.WEB_URL || 'http://127.0.0.1:3001') + '/';
const data = JSON.parse(fs.readFileSync(new URL('../data/products.json', import.meta.url), 'utf8'));
const P = Object.fromEntries(data.products.map(p => [p.sku, p]));
const b = await launch(9341);
const w = ms => new Promise(r => setTimeout(r, ms));
const R = '!document.querySelector("main .st-status")&&!!document.querySelector(".st-footer-top")';
const out = []; const ok = (n, pass, extra = '') => { out.push(`${pass ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); };
const ev = s => b.eval(s);
const allErrors = []; const go = async u => { allErrors.push(...b.errors); await b.goto(B + u, R); };
const counts = `({cart:document.querySelector('[data-badge=cart]').textContent,wish:document.querySelector('[data-badge=wish]').textContent})`;
const store = `({cart:JSON.parse(localStorage.getItem('kitsyuu-cart-v1')||'[]'),wish:JSON.parse(localStorage.getItem('kitsyuu-wishlist-v1')||'[]')})`;
const ov = 'document.documentElement.scrollWidth-innerWidth';
const settle = async (cond, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await ev(cond).catch(() => false)) return; await w(100); } };
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('missing '+${JSON.stringify(sel)});e.click();return true})()`);
const status = () => ev(`document.querySelector('#st-buy-status').textContent`);

for (const [vw, vh, mob, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
  await b.viewport(vw, vh, mob);
  await go(''); await ev('localStorage.clear();sessionStorage.clear()'); await go('');
  // Empty states
  let c = await ev(counts); ok(`[${tag}] header counts start at 0`, c.cart === '0' && c.wish === '0', JSON.stringify(c));
  await go('cart'); ok(`[${tag}] empty cart state`, (await ev(`document.querySelector('.st-empty-inline h2')?.textContent`)) === 'Your cart is empty.');
  await go('wishlist'); ok(`[${tag}] empty wishlist state`, (await ev(`document.querySelector('.st-empty-inline h2')?.textContent`)) === 'Your wishlist is empty.');
  await go('checkout'); ok(`[${tag}] checkout with empty cart shows empty state`, (await ev(`!document.querySelector('.st-checkout-form')&&!!document.querySelector('.st-empty-inline')`)));

  // PDP: size required
  const hood = P['KTS-TOP-006'], jeans = P['KTS-BTM-004'];
  await go('product/' + hood.slug);
  ok(`[${tag}] prototype-only note removed`, !(await ev(`document.body.innerText.includes('connect in the next phase')`)));
  await click('.st-add'); await w(100);
  let s = await status(); let st = await ev(store);
  ok(`[${tag}] add without size is blocked`, s.includes('Select a size') && st.cart.length === 0 && (await ev(`document.activeElement.name==='size'`)), s);
  // Select size M, qty 2
  await click('.st-size input[value="M"]'); await click('[data-step="1"]'); await click('.st-add'); await w(100);
  st = await ev(store); c = await ev(counts); s = await status();
  const l0 = st.cart[0];
  ok(`[${tag}] add M × 2 creates line with required fields`, st.cart.length === 1 && l0.id === hood.id && l0.sku === hood.sku && l0.name === hood.name && l0.image.endsWith('/storage/v1/object/public/product-images/products/' + hood.id + '.webp') && l0.price === hood.price && l0.size === 'M' && l0.qty === 2, JSON.stringify(l0));
  ok(`[${tag}] header cart count updates immediately`, c.cart === '2', `cart=${c.cart} | status: ${s}`);
  // Same product + same size merges
  await click('.st-add'); await w(100); st = await ev(store);
  ok(`[${tag}] same product + same size merges`, st.cart.length === 1 && st.cart[0].qty === 4, JSON.stringify(st.cart.map(l => l.size + '×' + l.qty)));
  // Same product + different size → new line
  await click('.st-size input[value="L"]'); await ev(`document.querySelector('#st-qty').value=1`); await click('.st-add'); await w(100); st = await ev(store);
  ok(`[${tag}] same product + different size is a new line`, st.cart.length === 2 && st.cart[1].size === 'L' && st.cart[1].qty === 1, JSON.stringify(st.cart.map(l => l.size + '×' + l.qty)));
  // Cap at 10
  await click('.st-size input[value="M"]'); await ev(`document.querySelector('#st-qty').value=10;document.querySelector('#st-qty').dispatchEvent(new Event('change',{bubbles:true}))`); await click('.st-add'); await w(100);
  st = await ev(store); s = await status();
  ok(`[${tag}] quantity per line capped at 10`, st.cart.find(l => l.size === 'M').qty === 10 && s.includes('maximum'), s);
  // Wishlist on PDP
  await click('.st-wish-btn'); await w(50);
  c = await ev(counts); let pressed = await ev(`document.querySelector('.st-wish-btn').getAttribute('aria-pressed')+'|'+document.querySelector('[data-wish-label]').textContent`);
  ok(`[${tag}] PDP heart saves to wishlist + count`, c.wish === '1' && pressed === 'true|Saved to wishlist', `${c.wish} ${pressed}`);
  // Jeans (numeric sizes) add 32
  await go('product/' + jeans.slug);
  await click('.st-size input[value="32"]'); await click('.st-add'); await w(100);
  // Refresh persistence
  await go('cart');
  let cartView = await ev(`[...document.querySelectorAll('.st-line')].map(l=>({k:l.dataset.line,name:l.querySelector('.st-line-name').textContent,meta:l.querySelector('.st-line-meta').innerText.replace(/\\s+/g,' '),qty:l.querySelector('[data-line-qty]').value,unit:l.querySelector('.st-line-unit').textContent,total:l.querySelector('.st-line-total').textContent,img:l.querySelector('img').src}))`);
  const sub = await ev(`document.querySelector('.st-summary dl dd').textContent`);
  const expectSub = hood.price * 11 + jeans.price;
  ok(`[${tag}] cart page shows actual contents after navigation`, cartView.length === 3 && cartView[0].meta.toUpperCase().includes('SKU KTS-TOP-006') && cartView[0].meta.toUpperCase().includes('SIZE M') && cartView[2].meta.toUpperCase().includes('SIZE 32') && cartView.every(v => v.img.includes('/storage/v1/object/public/product-images/products/')), JSON.stringify(cartView.map(v => `${v.name} ${v.meta} q${v.qty} ${v.total}`)));
  ok(`[${tag}] subtotal correct`, sub.replace(/[^0-9]/g, '') === String(expectSub), `${sub} vs ${expectSub}`);
  await ev('location.reload()'); await w(900); await b.eval(R);
  const afterReload = await ev(`document.querySelectorAll('.st-line').length`); c = await ev(counts);
  ok(`[${tag}] cart persists after refresh`, afterReload === 3 && c.cart === '12', `lines ${afterReload}, count ${c.cart}`);
  // Qty − / + on cart page (hoodie L line = index 1)
  await click('[data-line$="|L"] [data-line-step="1"]'); await w(80);
  let q = await ev(`document.querySelector('[data-line$="|L"] [data-line-qty]').value`); c = await ev(counts);
  const focusKept = await ev(`!!document.activeElement.closest('[data-line$="|L"]')`);
  ok(`[${tag}] cart + increases qty, count and keeps focus`, q === '2' && c.cart === '13' && focusKept, `qty ${q} count ${c.cart}`);
  await click('[data-line$="|L"] [data-line-step="-1"]'); await w(80);
  q = await ev(`document.querySelector('[data-line$="|L"] [data-line-qty]').value`); c = await ev(counts);
  const minusDisabled = await ev(`document.querySelector('[data-line$="|L"] [data-line-step="-1"]').disabled`);
  ok(`[${tag}] cart − decreases qty (min 1, button disabled at 1)`, q === '1' && c.cart === '12' && minusDisabled, `qty ${q} count ${c.cart}`);
  // Remove
  await click('[data-line$="|L"] [data-line-remove]'); await w(80);
  st = await ev(store); c = await ev(counts);
  ok(`[${tag}] remove item`, st.cart.length === 2 && !st.cart.some(l => l.size === 'L') && c.cart === '11', `${st.cart.length} lines, count ${c.cart}`);
  ok(`[${tag}] cart page no overflow`, (await ev(ov)) <= 0, 'overflow ' + (await ev(ov)));
  await b.shot(`p2-${tag}-cart.png`, true);

  // Wishlist from cards (shop grid) + wishlist page + persistence
  await go('shop?category=outerwear');
  await click(`[data-wish="${P['KTS-OUT-002'].id}"]`); await w(50);
  c = await ev(counts);
  ok(`[${tag}] card heart toggles on + count`, c.wish === '2' && (await ev(`document.querySelector('[data-wish="${P['KTS-OUT-002'].id}"]').getAttribute('aria-pressed')`)) === 'true', c.wish);
  await ev('location.reload()'); await w(300); await settle(`document.readyState==='complete' && document.querySelector('[data-wish="${P['KTS-OUT-002'].id}"]')?.getAttribute('aria-pressed')==='true'`);
  ok(`[${tag}] wishlist persists after refresh (heart still pressed)`, (await ev(`document.querySelector('[data-wish="${P['KTS-OUT-002'].id}"]').getAttribute('aria-pressed')`)) === 'true' && (await ev(counts)).wish === '2');
  await go('wishlist');
  let wl = await ev(`[...document.querySelectorAll('.st-card .st-tag:not(.st-tag-new)')].map(e=>e.textContent)`);
  ok(`[${tag}] wishlist page shows saved products`, JSON.stringify(wl) === JSON.stringify(['KTS-TOP-006', 'KTS-OUT-002']), wl.join());
  await b.shot(`p2-${tag}-wishlist.png`);
  await click(`[data-wish="${hood.id}"]`); await w(80);
  wl = await ev(`[...document.querySelectorAll('.st-card .st-tag:not(.st-tag-new)')].map(e=>e.textContent)`); c = await ev(counts);
  ok(`[${tag}] remove from wishlist page`, wl.join() === 'KTS-OUT-002' && c.wish === '1', wl.join());
  await click(`[data-wish="${P['KTS-OUT-002'].id}"]`); await w(80);
  ok(`[${tag}] wishlist empties to empty state`, (await ev(`document.querySelector('.st-empty-inline h2')?.textContent`)) === 'Your wishlist is empty.' && (await ev(counts)).wish === '0');

  // Search
  await go('search');
  const q1 = async t => { await ev(`(()=>{const i=document.querySelector('#st-q');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(t)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`); await w(300); return ev(`[...document.querySelectorAll('#st-results .st-card .st-tag:not(.st-tag-new)')].map(e=>e.textContent)`); };
  const cases = [['hoodie', ['KTS-TOP-004', 'KTS-TOP-006']], ['KTS-BTM-004', ['KTS-BTM-004']], ['kts btm 004', ['KTS-BTM-004']], ['jeans', ['KTS-BTM-004', 'KTS-BTM-010']], ['outerwear', ['KTS-OUT-001', 'KTS-OUT-002']], ['shorts', ['KTS-BTM-002', 'KTS-BTM-007']], ['FLAME', ['KTS-TOP-006', 'KTS-BTM-006']], ['tops shirts', ['KTS-TOP-002', 'KTS-TOP-005', 'KTS-TOP-009', 'KTS-TOP-010']]];
  const sres = [];
  for (const [t, exp] of cases) { const got = await q1(t); sres.push(`${t}→${got.length}${JSON.stringify(got) === JSON.stringify(exp) ? '' : ' ✗ ' + got.join('/')}`); if (JSON.stringify(got) !== JSON.stringify(exp)) ok(`[${tag}] search "${t}"`, false, got.join()); }
  ok(`[${tag}] search by name / SKU / category / subcategory`, sres.every(x => !x.includes('✗')), sres.join(' · '));
  const none = await q1('zzqx'); const emptyTxt = await ev(`document.querySelector('.st-search-empty h2')?.textContent`);
  ok(`[${tag}] search empty state`, none.length === 0 && emptyTxt === 'No products match “zzqx”.' && (await ev(`document.querySelectorAll('.st-search-browse a').length`)) === 10, emptyTxt);
  ok(`[${tag}] search URL keeps query`, (await ev('location.search')) === '?q=zzqx');
  await q1('jeans'); await b.shot(`p2-${tag}-search.png`);

  // Category navigation + sorting
  await go('shop?category=bottoms');
  const priceOf = `[...document.querySelectorAll('#st-results .st-card .st-tag:not(.st-tag-new)')].map(e=>e.textContent)`;
  const base = await ev(priceOf);
  await ev(`(()=>{const s=document.querySelector('#st-sort');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'price-asc');s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await w(100);
  const asc = await ev(priceOf); const ascP = asc.map(s => P[s].price);
  await ev(`(()=>{const s=document.querySelector('#st-sort');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'price-desc');s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await w(100);
  const desc = await ev(priceOf); const descP = desc.map(s => P[s].price);
  const sortedOk = ascP.every((v, i) => !i || ascP[i - 1] <= v) && descP.every((v, i) => !i || descP[i - 1] >= v) && asc.length === 10;
  ok(`[${tag}] sort price low→high / high→low`, sortedOk, `asc ${ascP.join(',')} | desc ${descP.join(',')}`);
  await ev(`(()=>{const s=document.querySelector('#st-sort');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'new');s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await w(100);
  const nw = await ev(priceOf);
  ok(`[${tag}] sort new arrivals first (collection order)`, nw.slice(0, 3).join() === 'KTS-BTM-008,KTS-BTM-010,KTS-BTM-002', nw.slice(0, 4).join());
  ok(`[${tag}] sort in URL + tabs keep sort`, (await ev('location.search')).includes('sort=new') && (await ev(`document.querySelector('.st-subnav a[href*="trousers"]').getAttribute('href')`)).includes('sort=new'));
  await click('[data-reset-sort]'); await w(100);
  ok(`[${tag}] reset sort restores catalogue order`, JSON.stringify(await ev(priceOf)) === JSON.stringify(base) && !(await ev('location.search')).includes('sort'));
  await click('.st-subnav a[href*="jeans"]'); await w(900);
  ok(`[${tag}] subcategory navigation`, (await ev(`document.querySelectorAll('#st-results .st-card').length`)) === 2 && (await ev('location.search')) === '?category=bottoms.jeans');
  await b.shot(`p2-${tag}-shop.png`);

  // Checkout prototype
  await go('checkout');
  ok(`[${tag}] checkout labelled prototype, no payment inputs`, (await ev(`document.body.innerText.includes('not a real purchase')&&!document.querySelector('input[autocomplete^="cc-"],input[name*=card],input[name*=upi]')`)));
  await click('.st-place'); await w(100);
  const alertTxt = await ev(`document.querySelector('#st-form-alert').textContent`); st = await ev(store);
  ok(`[${tag}] invalid checkout blocked, errors shown, cart kept`, alertTxt.includes('7 fields') && (await ev(`document.activeElement.name`)) === 'name' && st.cart.length === 2, alertTxt);
  await b.shot(`p2-${tag}-checkout-errors.png`);
  await ev(`(()=>{const v={name:'Test Person',email:'test@example.com',phone:'9876543210',address1:'12 Linking Road',city:'Mumbai',state:'Maharashtra',pin:'400050'};for(const [k,x] of Object.entries(v)){const i=document.querySelector('[name='+k+']');i.value=x;}})()`);
  await ev(`document.querySelector('[name=pin]').value='12345'`); await click('.st-place'); await w(100);
  ok(`[${tag}] bad PIN blocked`, (await ev(`document.querySelector('#st-e-pin').textContent`)) === 'Enter a 6-digit PIN code.' && (await ev(store)).cart.length === 2);
  await ev(`document.querySelector('[name=pin]').value='400050'`);
  await ev(`document.querySelector('.st-place').click()`); await w(1500); await b.eval(R);
  const conf = await ev(`({url:location.pathname,ref:document.querySelector('.st-confirm-ref dd')?.textContent,h1:document.querySelector('h1').textContent,lead:document.querySelector('.st-confirm-lead')?.textContent,items:document.querySelectorAll('.st-mini li').length,ship:document.querySelectorAll('.st-form-group')[1]?.innerText})`);
  st = await ev(store); c = await ev(counts);
  ok(`[${tag}] confirmation page with prototype reference`, conf.url.endsWith('/confirmation') && /^KTS-PROTO-\d{6}-[A-Z2-9]{4}$/.test(conf.ref) && conf.items === 2 && conf.ship.includes('Mumbai'), JSON.stringify({ref: conf.ref, h1: conf.h1, items: conf.items}));
  ok(`[${tag}] confirmation does not claim a real order`, conf.lead.includes('No order was placed') && conf.h1.includes('Prototype'));
  ok(`[${tag}] cart cleared after confirmation`, st.cart.length === 0 && c.cart === '0');
  ok(`[${tag}] confirmation no overflow`, (await ev(ov)) <= 0);
  await b.shot(`p2-${tag}-confirmation.png`, true);

  // Header + mobile nav
  await go('');
  ok(`[${tag}] header links: search/wishlist/cart + account (guest → /login)`, (await ev(`[...document.querySelectorAll('.st-tools a')].map(a=>a.getAttribute('href')).join()`)) === '/search,/wishlist,/cart,/login');
  if (mob) {
    await click('.st-menu-toggle'); await w(100);
    const m = await ev(`({open:getComputedStyle(document.querySelector('#st-nav')).display,wish:document.querySelector('.st-nav-extra a').textContent})`);
    ok('[mobile] menu opens and shows Wishlist (count)', m.open === 'block' && m.wish === 'Wishlist (0)', JSON.stringify(m));
    await b.key('Escape', 'Escape', 27);
  }
  allErrors.push(...b.errors); ok(`[${tag}] no page errors during run`, allErrors.length === 0, allErrors.join('; ')); allErrors.length = 0;
}
b.close();
console.log(out.join('\n'));
console.log(`\n${out.filter(l => l.startsWith('PASS')).length} PASS, ${out.filter(l => l.startsWith('FAIL')).length} FAIL`);
