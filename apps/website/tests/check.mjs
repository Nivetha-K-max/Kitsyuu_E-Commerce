import {launch} from './cdp.mjs';
import fs from 'node:fs';
const B = process.env.WEB_URL || 'http://127.0.0.1:3001';
const STATIC = process.env.STATIC_URL || 'http://127.0.0.1:3000'; // original dist/ site, for the landing-page check
const data = JSON.parse(fs.readFileSync(new URL('../data/products.json', import.meta.url), 'utf8'));
const b = await launch();
const out = []; const ok = (name, pass, extra = '') => out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const READY = '!document.querySelector("main .st-status")&&!!document.querySelector(".st-footer .st-footer-top")';
/* The images a visitor can see. Images inside a hidden (display:none) part of the page — e.g. the desktop mega-menu's
   lazy pictures on a phone — are correctly never downloaded by the browser, so they are not counted. */
const SHOWN = `[...document.querySelectorAll("main img,header img")].filter(i=>i.checkVisibility())`;
const imgs = `${SHOWN}.map(i=>({src:i.currentSrc||i.src,ok:i.complete&&i.naturalWidth>0}))`;
const overflow = 'document.documentElement.scrollWidth-innerWidth';
/* Waits for the shown images to actually finish (load or error), bringing lazy ones into view first; then back to the top.
   No fixed sleep: each image resolves on its own load / error event (10 s cap per image). The checks then read complete +
   naturalWidth, so a broken image still fails. */
const SETTLE = `(async()=>{for(const i of ${SHOWN}){if(i.complete&&i.naturalWidth>0)continue;
  i.scrollIntoView({block:'center'});await new Promise(r=>{if(i.complete&&i.naturalWidth>0)return r();i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true});setTimeout(r,10000);});}
  scrollTo(0,0);return true})()`;
const settle = () => b.eval(SETTLE);
/* The store menu: Home, Shop, then the collections the store can see (Men / Women / Sale / New Arrivals… whichever staff made
   visible, in their admin order: the same public read the store makes), then the top-level categories. */
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const visibleCollections = await (await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/collections?select=label,sort_order&order=sort_order`,
  {headers: {apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`}})).json();
const navExpect = ['Home', 'Shop', ...visibleCollections.map(c => c.label), 'Tops', 'Bottoms', 'Outerwear'];
const skus = sel => `[...document.querySelectorAll("${sel} .st-card[data-sku]")].map(e=>e.dataset.sku)`;
const bySku = Object.fromEntries(data.products.map(p => [p.sku, p]));

for (const [vw, vh, mobile, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'mobile']]) {
  await b.viewport(vw, vh, mobile);
  // Landing page
  await b.goto(STATIC + '/landing.html', 'document.readyState==="complete"');
  const land = await b.eval(`({title:document.title,nav:[...document.querySelectorAll('.nav nav a')].map(a=>a.textContent),word:document.querySelector('.hero-wordmark')?.textContent,poster:document.querySelector('.stage-poster').naturalWidth,store:!!document.querySelector('.st-header')})`);
  ok(`[${tag}] landing loads unchanged`, land.title.startsWith('Kitsyuu') && land.word === 'KITSYUU' && land.poster > 0 && !land.store && b.errors.length === 0, JSON.stringify(land) + (b.errors.length ? ' errors: ' + b.errors.join('; ') : ''));
  await b.shot(`${tag}-landing.png`);

  // The homepage `/` is the store: ONE store header, the brand hero (landing poster + wordmark), the store sections, ONE footer.
  await b.goto(B + '/', READY);
  const home0 = await b.eval(`(()=>{const heads=[...document.querySelectorAll('header')].filter(h=>getComputedStyle(h).display!=='none');
    return {heads:heads.length,storeHeaderFirst:!!heads[0]?.matches('.st-header')&&Math.abs(heads[0].getBoundingClientRect().top)<=1,
      landing:!!document.querySelector('.kitsyuu-landing'),footers:[...document.querySelectorAll('footer')].filter(f=>getComputedStyle(f).display!=='none').length,
      h1:[...document.querySelectorAll('h1')].map(h=>h.textContent),poster:document.querySelector('.st-brand-hero-img')?.naturalWidth,
      shop:!!document.querySelector('.st-brand-hero a[href="/shop"]'),story:!!document.querySelector('.st-brand-hero a[href="/our-story"]'),
      heroFirst:document.querySelector('main')?.firstElementChild?.classList.contains('st-brand-hero'),storeHero:!!document.querySelector('#st-hero-title'),mains:document.querySelectorAll('main').length}})()`);
  ok(`[${tag}] / = one store header, brand hero (poster + KITSYUU), store sections, one footer`, home0.heads === 1 && home0.storeHeaderFirst && !home0.landing && home0.footers === 1
    && home0.h1.join() === land.word && home0.poster > 0 && home0.shop && home0.story && home0.heroFirst && home0.storeHero && home0.mains === 1 && b.errors.length === 0,
    JSON.stringify(home0) + (b.errors.length ? ' errors: ' + b.errors.join('; ') : ''));

  // /our-story = the unchanged landing (film, style studies, our world) under the same one store header, above the one footer.
  await b.goto(B + '/our-story', READY);
  const story = await b.eval(`(()=>{const vis=el=>getComputedStyle(el).display!=='none';
    return {nav:[...document.querySelectorAll('.kitsyuu-landing .nav nav a')].map(a=>a.textContent),word:document.querySelector('.kitsyuu-landing .hero-wordmark')?.textContent,
      poster:document.querySelector('.kitsyuu-landing .stage-poster')?.naturalWidth,heads:[...document.querySelectorAll('header')].filter(vis).length,
      storeHeader:vis(document.querySelector('.st-header')),footers:[...document.querySelectorAll('footer')].filter(vis).length,
      sections:['story','edit','about'].every(id=>!!document.getElementById(id)),mains:document.querySelectorAll('main').length}})()`);
  ok(`[${tag}] /our-story = the landing (unchanged content) with the one store header and footer`, story.word === land.word && story.poster > 0
    && JSON.stringify(story.nav) === JSON.stringify([...land.nav, 'Store']) && story.heads === 1 && story.storeHeader && story.footers === 1 && story.sections && story.mains === 1
    && b.errors.length === 0, JSON.stringify(story) + (b.errors.length ? ' errors: ' + b.errors.join('; ') : ''));

  // Store home
  await b.goto(B + '/', READY); await settle();
  const home = await b.eval(`({na:${skus('[aria-labelledby=st-na-title]')},ft:${skus('[aria-labelledby=st-ft-title]')},cats:[...document.querySelectorAll('.st-cat-name')].map(e=>e.textContent),nav:[...document.querySelectorAll('.st-nav-main>li>a')].map(a=>a.textContent),imgs:${imgs},ov:${overflow}})`);
  const naExpect = data.collections[0].productIds.map(id => data.products.find(p => p.id === id).sku);
  const ftExpect = data.products.filter(p => p.featured).map(p => p.sku);
  ok(`[${tag}] home New Arrivals = products.json collection`, JSON.stringify(home.na) === JSON.stringify(naExpect), home.na.join(', '));
  ok(`[${tag}] home Featured = products.json featured`, JSON.stringify(home.ft) === JSON.stringify(ftExpect), home.ft.join(', '));
  ok(`[${tag}] home has no held product in Featured/New Arrivals`, ![...home.na, ...home.ft].some(s => bySku[s].media.status === 'held'));
  ok(`[${tag}] home category tiles`, home.cats.join() === 'Tops,Bottoms,Outerwear', home.cats.join());
  ok(`[${tag}] header nav order (visible collections, e.g. Men / Women / Sale, then categories)`, home.nav.join() === navExpect.join(), `${home.nav.join()} | expected ${navExpect.join()}`);
  // Men / Women / Sale are each in the menu exactly when their collection is active, in that order.
  const groups = ['Men', 'Women', 'Sale'], active = groups.filter(g => visibleCollections.some(c => c.label === g));
  ok(`[${tag}] Men / Women / Sale in the menu when active (${active.join(', ') || 'none'} active)`, JSON.stringify(home.nav.filter(l => groups.includes(l))) === JSON.stringify(active), home.nav.join());
  ok(`[${tag}] home images resolve`, home.imgs.every(i => i.ok), home.imgs.filter(i => !i.ok).map(i => i.src).join());
  ok(`[${tag}] home no horizontal overflow / errors`, home.ov <= 0 && b.errors.length === 0, `overflow ${home.ov}px ${b.errors.join('; ')}`);
  await b.shot(`${tag}-home.png`, true);

  // Listing routes
  const routes = [['', data.products.length], ['?collection=new-arrivals', 4]];
  for (const c of data.categories) routes.push([`?category=${c.id}`, data.products.filter(p => p.category === c.id || p.subcategory === c.id).length]);
  for (const [q, n] of routes) {
    await b.goto(`${B}/shop${q}`, READY); await settle();
    const r = await b.eval(`({h1:document.querySelector('h1')?.innerText.replace(/\\n/g,' '),n:document.querySelectorAll('main .st-grid>li').length,count:document.querySelector('.st-result-count')?.textContent,cur:document.querySelector('.st-subnav [aria-current]')?.textContent,imgs:${imgs},ov:${overflow},heldOk:[...document.querySelectorAll('.st-card')].every(c=>{const s=c.dataset.sku,src=(${JSON.stringify(Object.fromEntries(data.products.map(p => [p.sku, p.media.status === 'held' ? null : 'storage/v1/object/public/product-images/products/' + p.id + '.webp'])))})[s];const photo=c.querySelector('img:not(.st-soon-mark)');return src===null?(!!c.querySelector('.st-soon .st-soon-title')&&!photo&&c.querySelector('.st-soon-title').textContent==='Photocoming soon'&&c.querySelector('.st-soon-label').textContent==='KITSYUU'):(!c.querySelector('.st-soon')&&photo.src.endsWith('/'+src))})})`);
    ok(`[${tag}] shop.html${q || ' (all)'}`, r.n === n && r.imgs.every(i => i.ok) && r.heldOk && r.ov <= 0 && b.errors.length === 0, `${r.h1} | ${r.n}/${n} cards | ${r.count} | tab: ${r.cur ?? '-'}${b.errors.length ? ' | ' + b.errors.join('; ') : ''}${r.ov > 0 ? ' | overflow ' + r.ov : ''}`);
    if (q === '' || q === '?category=tops.hoodies') await b.shot(`${tag}-shop${q ? '-hoodies' : ''}.png`, true);
  }
  // Collections have their own pages (2026-10-01); /shop?collection= shows the same list with the collection URL as canonical.
  await b.goto(`${B}/collections/new-arrivals`, READY);
  const colPage = await b.eval(`({n:document.querySelectorAll('main .st-grid>li').length,canon:document.querySelector('link[rel=canonical]')?.href,ld:[...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s=>[JSON.parse(s.textContent)].flat()).map(x=>x['@type']).join()})`);
  ok(`[${tag}] /collections/new-arrivals: 4 products, canonical, CollectionPage JSON-LD`, colPage.n === 4 && !!colPage.canon?.endsWith('/collections/new-arrivals') && colPage.ld === 'CollectionPage,BreadcrumbList' && b.errors.length === 0, JSON.stringify(colPage));
  // Dark by default; the header switch turns the page light, the choice is kept, and switching back restores dark.
  await b.goto(`${B}/shop`, READY);
  const th = await b.eval(`(async()=>{const w=c=>new Promise(r=>{const t=Date.now();(function f(){if(c()||Date.now()-t>5000)return r();setTimeout(f,50)})()});localStorage.removeItem('kitsyuu-theme');
    const bg=()=>getComputedStyle(document.body).backgroundColor,d=document.documentElement,btn=()=>document.querySelector('[data-theme-toggle]');
    await w(()=>btn()?.dataset.themeToggle==='dark');const a=[d.dataset.theme,bg()];btn().click();await w(()=>d.dataset.theme==='light');const b=[d.dataset.theme,bg(),localStorage.getItem('kitsyuu-theme')];
    btn().click();await w(()=>d.dataset.theme==='dark');const c=[d.dataset.theme,bg()];localStorage.removeItem('kitsyuu-theme');return {a,b,c}})()`);
  ok(`[${tag}] theme: dark by default; the switch turns it light (kept) and back`, th.a[0] === 'dark' && th.b[0] === 'light' && th.b[1] !== th.a[1] && th.b[2] === 'light' && th.c[0] === 'dark' && th.c[1] === th.a[1], JSON.stringify(th));
  await b.goto(`${B}/shop?category=nope`, READY);
  ok(`[${tag}] unknown category shows not-found`, (await b.eval('document.querySelector("h1")?.textContent')) === 'Category not found');

  // All 22 product pages (desktop checks all; mobile checks a sample)
  const list = tag === 'desktop' ? data.products : data.products.filter(p => ['KTS-TOP-006', 'KTS-OUT-002', 'KTS-BTM-004'].includes(p.sku));
  let pdpFails = [], seoFails = [];
  for (const p of list) {
    await b.goto(`${B}/product/${p.slug}`, READY); await settle();
    const r = await b.eval(`(()=>{const m=document.querySelector('#st-main-img');return{h1:document.querySelector('#st-pdp-title')?.textContent,src:m?.src,ok:m?m.complete&&m.naturalWidth>0:!!document.querySelector('.st-gallery-stage .st-soon[role=img]'),held:!!document.querySelector('.st-gallery-main.is-held .st-soon'),zoom:document.querySelector('.st-gallery').dataset.zoom,sizes:document.querySelectorAll('.st-size input').length,sku:document.querySelector('.st-pdp-meta').textContent,title:document.title,ov:${overflow},imgs:${imgs}}})()`);
    const held = p.media.status === 'held';
    const expectSrc = held ? undefined : `/storage/v1/object/public/product-images/products/${p.id}.webp`; // Phase 4.3: images come from Supabase Storage (product-images bucket)
    const pass = r.h1 === p.name && (held ? r.src === undefined : r.src.endsWith(expectSrc)) && r.ok && r.held === held && r.zoom === 'false' && r.sizes === p.variants.length && !/SKU/i.test(r.sku) && !r.sku.includes(p.sku) && r.ov <= 0 && r.imgs.every(i => i.ok) && b.errors.length === 0;
    if (!pass) pdpFails.push(`${p.sku}: ${JSON.stringify({...r, imgs: r.imgs.filter(i => !i.ok)})} ${b.errors.join('; ')}`);
    // SEO (2026-10-01): JSON-LD Product + BreadcrumbList and the canonical URL, generated from the product itself; the Open Graph
    // title is the page title (staff's SEO title when set, e.g. on live, else the name).
    const seo = await b.eval(`({ld:[...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s=>[JSON.parse(s.textContent)].flat()),canon:document.querySelector('link[rel=canonical]')?.href,og:document.querySelector('meta[property="og:title"]')?.content,title:document.title})`);
    const pld = seo.ld.find(x => x['@type'] === 'Product');
    if (!pld || pld.name !== p.name || pld.sku !== p.sku || pld.brand?.name !== 'KITSYUU' || pld.offers?.priceCurrency !== 'INR' || !(Number(pld.offers?.price) > 0)
      || !/schema\.org\/(InStock|OutOfStock)$/.test(pld.offers?.availability) || pld.url !== seo.canon || !seo.canon?.endsWith('/product/' + p.slug) || seo.og !== seo.title.replace(/ \| KITSYUU Store$/, '')
      || !seo.ld.some(x => x['@type'] === 'BreadcrumbList') || ('aggregateRating' in pld && !(pld.aggregateRating.reviewCount > 0)))
      seoFails.push(`${p.sku}: ${JSON.stringify({pld, canon: seo.canon, og: seo.og}).slice(0, 300)}`);
    if (p.sku === 'KTS-TOP-006' || p.sku === 'KTS-OUT-002') await b.shot(`${tag}-pdp-${p.sku}.png`, true);
  }
  ok(`[${tag}] product pages (${list.length}) render, image or placeholder correct, zoom off`, pdpFails.length === 0, pdpFails.join('\n      '));
  ok(`[${tag}] product pages (${list.length}): JSON-LD Product (name, SKU, brand, INR offer, availability, URL) + breadcrumbs, canonical = /product/<slug>`, seoFails.length === 0, seoFails.join(' | '));
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
