import {launch} from './cdp.mjs';
import fs from 'node:fs';
const B = process.env.WEB_URL || 'http://127.0.0.1:3001';
const STATIC = process.env.STATIC_URL || 'http://127.0.0.1:3000'; // original dist/ site, for the landing-page check
const data = JSON.parse(fs.readFileSync(new URL('../data/products.json', import.meta.url), 'utf8'));
const b = await launch();
const out = []; const ok = (name, pass, extra = '') => out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const READY = '!document.querySelector("main .st-status")&&!!document.querySelector(".st-footer .st-footer-top")';
const imgs = `[...document.querySelectorAll("main img,header img")].map(i=>({src:i.currentSrc||i.src,ok:i.complete&&i.naturalWidth>0}))`;
const overflow = 'document.documentElement.scrollWidth-innerWidth';
const skus = sel => `[...document.querySelectorAll("${sel} .st-card .st-tag:not(.st-tag-new)")].map(e=>e.textContent)`;
const bySku = Object.fromEntries(data.products.map(p => [p.sku, p]));

for (const [vw, vh, mobile, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
  await b.viewport(vw, vh, mobile);
  // Landing page
  await b.goto(STATIC + '/landing.html', 'document.readyState==="complete"');
  const land = await b.eval(`({title:document.title,nav:[...document.querySelectorAll('.nav nav a')].map(a=>a.textContent),word:document.querySelector('.hero-wordmark')?.textContent,poster:document.querySelector('.stage-poster').naturalWidth,store:!!document.querySelector('.st-header')})`);
  ok(`[${tag}] landing loads unchanged`, land.title.startsWith('Kitsyuu') && land.word === 'KITSYUU' && land.poster > 0 && !land.store && b.errors.length === 0, JSON.stringify(land) + (b.errors.length ? ' errors: ' + b.errors.join('; ') : ''));
  await b.shot(`${tag}-landing.png`);

  // M5: the homepage `/` is ONE page — the same landing first (plus one Store link to #store), then the store homepage.
  await b.goto(B + '/', READY);
  const home0 = await b.eval(`(()=>{const L=document.querySelector('[data-landing]'),S=document.querySelector('#store');const heads=[...document.querySelectorAll('.st-header')];
    return {title:document.title,nav:[...document.querySelectorAll('.kitsyuu-landing .nav nav a')].map(a=>a.textContent),store:[...document.querySelectorAll('.kitsyuu-landing .nav nav a')].filter(a=>a.getAttribute('href')==='#store'&&a.offsetParent!==null).length,
      word:document.querySelector('.kitsyuu-landing .hero-wordmark')?.textContent,poster:document.querySelector('.kitsyuu-landing .stage-poster')?.naturalWidth,
      order:!!(L&&S&&(L.compareDocumentPosition(S)&Node.DOCUMENT_POSITION_FOLLOWING)),storeHero:!!S?.querySelector('#st-hero-title'),storeHeader:heads.length===1&&!!S?.contains(heads[0]),
      landingHeaderFirst:!!(document.querySelector('.kitsyuu-landing header.nav')&&heads[0]&&(document.querySelector('.kitsyuu-landing header.nav').compareDocumentPosition(heads[0])&Node.DOCUMENT_POSITION_FOLLOWING)),
      mains:document.querySelectorAll('main').length}})()`);
  ok(`[${tag}] / = landing first (unchanged + Store link to #store), then the store homepage with its header`, home0.word === land.word && home0.poster > 0 && JSON.stringify(home0.nav) === JSON.stringify([...land.nav, 'Store'])
    && home0.store === 1 && home0.order && home0.storeHero && home0.storeHeader && home0.landingHeaderFirst && home0.mains === 1 && b.errors.length === 0, JSON.stringify(home0) + (b.errors.length ? ' errors: ' + b.errors.join('; ') : ''));

  // Store home
  await b.goto(B + '/', READY);
  const home = await b.eval(`({na:${skus('[aria-labelledby=st-na-title]')},ft:${skus('[aria-labelledby=st-ft-title]')},cats:[...document.querySelectorAll('.st-cat-name')].map(e=>e.textContent),nav:[...document.querySelectorAll('.st-nav-main>li>a')].map(a=>a.textContent),imgs:${imgs},ov:${overflow}})`);
  const naExpect = data.collections[0].productIds.map(id => data.products.find(p => p.id === id).sku);
  const ftExpect = data.products.filter(p => p.featured).map(p => p.sku);
  ok(`[${tag}] home New Arrivals = products.json collection`, JSON.stringify(home.na) === JSON.stringify(naExpect), home.na.join(', '));
  ok(`[${tag}] home Featured = products.json featured`, JSON.stringify(home.ft) === JSON.stringify(ftExpect), home.ft.join(', '));
  ok(`[${tag}] home has no held product in Featured/New Arrivals`, ![...home.na, ...home.ft].some(s => bySku[s].media.status === 'held'));
  ok(`[${tag}] home category tiles`, home.cats.join() === 'Tops,Bottoms,Outerwear', home.cats.join());
  ok(`[${tag}] header nav order`, home.nav.join() === 'Shop,New Arrivals,Tops,Bottoms,Outerwear', home.nav.join());
  ok(`[${tag}] home images resolve`, home.imgs.every(i => i.ok), home.imgs.filter(i => !i.ok).map(i => i.src).join());
  ok(`[${tag}] home no horizontal overflow / errors`, home.ov <= 0 && b.errors.length === 0, `overflow ${home.ov}px ${b.errors.join('; ')}`);
  await b.shot(`${tag}-home.png`, true);

  // Listing routes
  const routes = [['', data.products.length], ['?collection=new-arrivals', 4]];
  for (const c of data.categories) routes.push([`?category=${c.id}`, data.products.filter(p => p.category === c.id || p.subcategory === c.id).length]);
  for (const [q, n] of routes) {
    await b.goto(`${B}/shop${q}`, READY);
    const r = await b.eval(`({h1:document.querySelector('h1')?.innerText.replace(/\\n/g,' '),n:document.querySelectorAll('main .st-grid>li').length,count:document.querySelector('.st-result-count')?.textContent,cur:document.querySelector('.st-subnav [aria-current]')?.textContent,imgs:${imgs},ov:${overflow},heldOk:[...document.querySelectorAll('.st-card')].every(c=>{const s=c.querySelector('.st-tag').textContent,src=(${JSON.stringify(Object.fromEntries(data.products.map(p => [p.sku, p.media.status === 'held' ? null : 'storage/v1/object/public/product-images/products/' + p.id + '.webp'])))})[s];const photo=c.querySelector('img:not(.st-soon-mark)');return src===null?(!!c.querySelector('.st-soon .st-soon-title')&&!photo&&c.querySelector('.st-soon-title').textContent==='Photocoming soon'&&c.querySelector('.st-soon-label').textContent==='KITSYUU / PROTOTYPE'):(!c.querySelector('.st-soon')&&photo.src.endsWith('/'+src))})})`);
    ok(`[${tag}] shop.html${q || ' (all)'}`, r.n === n && r.imgs.every(i => i.ok) && r.heldOk && r.ov <= 0 && b.errors.length === 0, `${r.h1} | ${r.n}/${n} cards | ${r.count} | tab: ${r.cur ?? '-'}${b.errors.length ? ' | ' + b.errors.join('; ') : ''}${r.ov > 0 ? ' | overflow ' + r.ov : ''}`);
    if (q === '' || q === '?category=tops.hoodies') await b.shot(`${tag}-shop${q ? '-hoodies' : ''}.png`, true);
  }
  await b.goto(`${B}/shop?category=nope`, READY);
  ok(`[${tag}] unknown category shows not-found`, (await b.eval('document.querySelector("h1")?.textContent')) === 'Category not found');

  // All 22 product pages (desktop checks all; mobile checks a sample)
  const list = tag === 'desktop' ? data.products : data.products.filter(p => ['KTS-TOP-006', 'KTS-OUT-002', 'KTS-BTM-004'].includes(p.sku));
  let pdpFails = [];
  for (const p of list) {
    await b.goto(`${B}/product/${p.slug}`, READY);
    const r = await b.eval(`(()=>{const m=document.querySelector('#st-main-img');return{h1:document.querySelector('#st-pdp-title')?.textContent,src:m?.src,ok:m?m.complete&&m.naturalWidth>0:!!document.querySelector('.st-gallery-stage .st-soon[role=img]'),held:!!document.querySelector('.st-gallery-main.is-held .st-soon'),zoom:document.querySelector('.st-gallery').dataset.zoom,sizes:document.querySelectorAll('.st-size input').length,sku:document.querySelector('.st-pdp-meta').textContent,title:document.title,ov:${overflow},imgs:${imgs}}})()`);
    const held = p.media.status === 'held';
    const expectSrc = held ? undefined : `/storage/v1/object/public/product-images/products/${p.id}.webp`; // Phase 4.3: images come from Supabase Storage (product-images bucket)
    const pass = r.h1 === p.name && (held ? r.src === undefined : r.src.endsWith(expectSrc)) && r.ok && r.held === held && r.zoom === 'false' && r.sizes === p.variants.length && r.sku.includes(p.sku) && r.ov <= 0 && r.imgs.every(i => i.ok) && b.errors.length === 0;
    if (!pass) pdpFails.push(`${p.sku}: ${JSON.stringify({...r, imgs: undefined})} ${b.errors.join('; ')}`);
    if (p.sku === 'KTS-TOP-006' || p.sku === 'KTS-OUT-002') await b.shot(`${tag}-pdp-${p.sku}.png`, true);
  }
  ok(`[${tag}] product pages (${list.length}) render, image or placeholder correct, zoom off`, pdpFails.length === 0, pdpFails.join('\n      '));
  await b.goto(`${B}/product/missing`, READY);
  ok(`[${tag}] unknown product shows not-found`, (await b.eval('document.querySelector("h1")?.textContent')) === 'Product not found');

  // PDP interactions
  await b.goto(`${B}/product/${bySku['KTS-OUT-002'].slug}`, READY);
  const inter = await b.eval(`(async()=>{const s=document.querySelector('.st-size input[value=M]');s.click();await new Promise(r=>setTimeout(r,0));const lbl=document.querySelector('[data-size-label]').textContent;
    const inc=document.querySelector('[data-step="1"]'),dec=document.querySelector('[data-step="-1"]');for(let i=0;i<12;i++){inc.click();await new Promise(r=>setTimeout(r,0));}const max=document.querySelector('#st-qty').value+'/'+inc.disabled;
    for(let i=0;i<12;i++){dec.click();await new Promise(r=>setTimeout(r,0));}const min=document.querySelector('#st-qty').value+'/'+dec.disabled;
    localStorage.clear();document.querySelector('.st-add').click();await new Promise(r=>setTimeout(r,100));const toast=document.querySelector('#st-buy-status').textContent;localStorage.clear();
    return{lbl,max,min,toast,cart:localStorage.length}})()`);
  ok(`[${tag}] PDP size / qty / add to cart`, inter.lbl === 'Selected: M' && inter.max === '10/true' && inter.min === '1/true' && inter.toast.startsWith('Added to cart: size M'), JSON.stringify(inter));

  // Mobile menu
  if (mobile) {
    await b.goto(`${B}/shop?category=tops.hoodies`, READY);
    const m1 = await b.eval(`(async()=>{const t=document.querySelector('.st-menu-toggle');const before=getComputedStyle(document.querySelector('#st-nav')).display;t.click();await new Promise(r=>setTimeout(r,50));return{before,after:getComputedStyle(document.querySelector('#st-nav')).display,exp:t.getAttribute('aria-expanded'),focus:document.activeElement.textContent,inert:document.querySelector('main').inert,sub:document.querySelector('.st-nav-sub a[aria-current]')?.textContent}})()`);
    await b.shot('mobile-menu.png');
    await b.key('Escape', 'Escape', 27);
    const m2 = await b.eval(`({exp:document.querySelector('.st-menu-toggle').getAttribute('aria-expanded'),focus:document.activeElement.classList.contains('st-menu-toggle'),inert:document.querySelector('main').inert})`);
    ok('[mobile] menu opens, focuses first link, Esc closes & restores focus', m1.before === 'none' && m1.after === 'block' && m1.exp === 'true' && m1.inert && m2.exp === 'false' && m2.focus && !m2.inert, JSON.stringify({m1, m2}));
  }
}
// Keyboard: first Tab lands on skip link, then brand
await b.viewport(1440, 900); await b.goto(B + '/', READY);
await b.key('Tab', 'Tab', 9); const f1 = await b.eval('document.activeElement.textContent');
ok('[desktop] first Tab reaches skip link', f1 === 'Skip to content', f1);
b.close();
console.log(out.join('\n'));
