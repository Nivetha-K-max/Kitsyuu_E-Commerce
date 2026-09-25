/* KITSYUU store: every page is rendered from store/products.json. Cart and wishlist are client-side only (localStorage);
   checkout is a prototype that collects no payment details and sends nothing. */
'use strict';
(()=>{
const here=document.currentScript.src;
const ROOT=new URL('../',here),DATA_URL=new URL('products.json',here);
const page=document.body.dataset.page;
const params=new URLSearchParams(location.search);
const main=document.querySelector('main');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const pad=n=>String(n).padStart(2,'0');
const asset=path=>new URL(path,ROOT).href;
const plural=(n,word)=>`${pad(n)} ${word}${n===1?'':'s'}`;
try{if(localStorage.getItem('kietsu-reduce-motion')==='true')document.documentElement.classList.add('st-reduce');}catch{}

const ICONS={
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
  heart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z"/></svg>',
  bag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>',
  menu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 9h16M4 15h16"/></svg>'
};
const url={
  home:'./',
  shop:q=>'shop.html'+(q?'?'+new URLSearchParams(q):''),
  product:p=>'product.html?p='+encodeURIComponent(p.slug),
  cart:'cart.html',wishlist:'wishlist.html',checkout:'checkout.html',confirmation:'confirmation.html',
  search:q=>'search.html'+(q?'?'+new URLSearchParams({q}):'')
};
/* The brand landing page is parked (dist/landing.html) while the store is built. Set to asset('') once it is restored as the site root. */
const LANDING=null;

let C;
function catalogue(d){
  const byId=new Map(d.products.map(p=>[p.id,p]));
  const cats=new Map(d.categories.map(c=>[c.id,c]));
  const money=new Intl.NumberFormat('en-IN',{style:'currency',currency:d.meta.currency||'INR',maximumFractionDigits:0});
  return {
    d,byId,cats,money,
    bySlug:key=>d.products.find(p=>p.slug===key||p.id===key||p.sku.toLowerCase()===String(key).toLowerCase()),
    top:d.categories.filter(c=>!c.parent),
    children:id=>d.categories.filter(c=>c.parent===id),
    inCategory:id=>d.products.filter(p=>p.category===id||p.subcategory===id),
    collection:id=>{const c=d.collections.find(c=>c.id===id);return c&&{...c,products:c.productIds.map(i=>byId.get(i)).filter(Boolean)};},
    featured:()=>d.products.filter(p=>p.featured)
  };
}

/* Cart and wishlist state, kept in this browser's localStorage. Stored lines carry the product details the brief asks for,
   but every read is re-checked against products.json: unknown products or sizes are dropped and name, SKU, image and price
   always come from the catalogue. */
const KEYS={cart:'kitsyuu-cart-v1',wish:'kitsyuu-wishlist-v1',order:'kitsyuu-prototype-order'};
const MAX_QTY=10;
const clampQty=n=>Math.min(MAX_QTY,Math.max(1,Math.round(Number(n))||1));
function readList(key){try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v:[];}catch{return[];}}
function writeList(key,list){
  try{localStorage.setItem(key,JSON.stringify(list));return true;}
  catch{toast('This browser blocked saving, so the change may not survive a refresh.');return false;}
}
const lineFor=(p,size,qty)=>({id:p.id,sku:p.sku,name:p.name,image:p.media?.primary?.src||null,price:p.price,size,qty:clampQty(qty)});
const cart={
  lines(){
    const raw=readList(KEYS.cart).filter(l=>l&&typeof l.id==='string');
    if(!C)return raw;
    return raw.filter(l=>C.byId.get(l.id)?.variants.some(v=>v.size===l.size&&v.available)).map(l=>lineFor(C.byId.get(l.id),l.size,l.qty));
  },
  save(lines){const ok=writeList(KEYS.cart,lines);updateCounts();return ok;},
  count(){return this.lines().reduce((n,l)=>n+(clampQty(l.qty)),0);},
  subtotal(lines=this.lines()){return lines.reduce((s,l)=>s+l.price*l.qty,0);},
  /* Same product + same size merges into one line; a different size is a separate line. */
  add(p,size,qty){
    const lines=this.lines(),hit=lines.find(l=>l.id===p.id&&l.size===size),want=(hit?hit.qty:0)+clampQty(qty);
    if(hit)hit.qty=Math.min(MAX_QTY,want);else lines.push(lineFor(p,size,qty));
    return{ok:this.save(lines),merged:!!hit,capped:want>MAX_QTY,qty:Math.min(MAX_QTY,want)};
  },
  setQty(id,size,qty){const lines=this.lines(),l=lines.find(l=>l.id===id&&l.size===size);if(l){l.qty=clampQty(qty);this.save(lines);}return l;},
  remove(id,size){this.save(this.lines().filter(l=>!(l.id===id&&l.size===size)));},
  clear(){return this.save([]);}
};
const wish={
  ids(){const raw=[...new Set(readList(KEYS.wish).filter(id=>typeof id==='string'))];return C?raw.filter(id=>C.byId.has(id)):raw;},
  has(id){return this.ids().includes(id);},
  toggle(id){const ids=this.ids(),on=!ids.includes(id);writeList(KEYS.wish,on?[...ids,id]:ids.filter(x=>x!==id));updateCounts();return on;}
};
function updateCounts(){
  const n={cart:cart.count(),wish:wish.ids().length};
  document.querySelectorAll('[data-badge]').forEach(el=>{el.textContent=n[el.dataset.badge];});
}

/* Held products (and any product without a primary image) have no photo; they render the coming-soon panel below. */
function imageOf(p){
  const m=p.media||{};
  if(m.status!=='held'&&m.primary?.src)return{src:asset(m.primary.src),width:m.primary.width,height:m.primary.height,alt:m.primary.alt||p.name,held:false,zoom:m.primary.zoom===true,quality:m.primary.quality||m.status};
  return{src:asset(m.placeholder||C.d.meta.images.placeholder),width:600,height:800,alt:`${p.name}: product image unavailable`,held:true,zoom:false,quality:'held'};
}
/* Primary image first, then any future official photos listed in media.gallery. */
function imagesOf(p){
  const first=imageOf(p);
  if(first.held)return[first];
  const extra=(p.media.gallery||[]).filter(g=>g&&g.src).map(g=>({src:asset(g.src),width:g.width,height:g.height,alt:g.alt||p.name,held:false,zoom:g.zoom===true,quality:g.quality||'official'}));
  return[first,...extra];
}
/* Shared by cards and the product page. On cards it is decorative (the card text says "Photo coming soon"). */
function comingSoon(p,{label=false}={}){
  const a11y=label?`role="img" aria-label="${esc(`${p.name}: photo coming soon`)}"`:'aria-hidden="true"';
  return `<div class="st-soon" ${a11y}><img class="st-soon-mark" src="${asset('assets/kitsyuu-icon.svg')}" alt="" width="1024" height="1024"><span class="st-soon-title">Photo<br>coming soon</span><span class="st-soon-label">KITSYUU / PROTOTYPE</span></div>`;
}
const catLabel=id=>C.cats.get(id)?.label||'';
const categoryPath=p=>[catLabel(p.category),catLabel(p.subcategory)].filter(Boolean).join(' / ');
const price=p=>`${esc(C.money.format(p.price))}<small aria-hidden="true">EST.</small><span class="sr-only">, estimated prototype price</span>`;

function card(p,{level=3,isNew=false,index=0}={}){
  const img=imageOf(p);
  return `<li><article class="st-card">
<div class="st-card-media${img.held?' is-held':''}"><span class="st-tag">${esc(p.sku)}</span>${isNew?'<span class="st-tag st-tag-new">New</span>':''}${index?`<span class="st-index" aria-hidden="true">${pad(index)}</span>`:''}${img.held?comingSoon(p):`<img src="${esc(img.src)}" alt="" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`}</div>
<div class="st-card-body"><h${level} class="st-card-name"><a href="${url.product(p)}">${esc(p.name)}</a></h${level}><p class="st-card-cat">${esc(categoryPath(p))}${img.held?'<span class="sr-only">. Photo coming soon</span>':''}</p><p class="st-price">${price(p)}</p></div>
<button class="st-wish" type="button" data-wish="${esc(p.id)}" aria-pressed="${wish.has(p.id)}" aria-label="Save ${esc(p.name)} to wishlist">${ICONS.heart}</button>
</article></li>`;
}
const grid=(list,opts)=>`<ul class="st-grid">${list.map((p,i)=>card(p,typeof opts==='function'?opts(p,i):opts)).join('')}</ul>`;

/* Header, menu and footer */
function navItems(){
  const items=C.d.navigation.map(n=>n.all?{key:'all',label:'Shop',href:url.shop()}
    :n.collection?{key:'col:'+n.collection,label:n.label,href:url.shop({collection:n.collection})}
    :{key:'cat:'+n.category,label:n.label,href:url.shop({category:n.category}),children:C.children(n.category)});
  return[...items.filter(i=>i.key==='all'),...items.filter(i=>i.key!=='all')];
}
function renderHeader(active={}){
  const el=document.querySelector('[data-store-header]'),cur=tool=>active.tool===tool?' aria-current="page"':'';
  el.innerHTML=`<a class="st-brand" href="${url.home}" aria-label="KITSYUU store home"><span class="logo-crop"><img src="${asset('assets/kitsyuu-icon.svg')}" alt="" width="1024" height="1024"></span><span class="st-wordmark" aria-hidden="true">KITSYUU</span></a>
<nav class="st-nav" id="st-nav" aria-label="Store"><ul class="st-nav-main">${C?navItems().map(i=>{
    const current=active.key===i.key?(active.exact?' aria-current="page"':' class="is-active"'):'';
    const subs=i.children?.length?`<ul class="st-nav-sub">${i.children.map(c=>`<li><a href="${url.shop({category:c.id})}"${active.sub===c.id?' aria-current="page"':''}>${esc(c.label)}</a></li>`).join('')}</ul>`:'';
    return `<li><a href="${i.href}"${current}>${esc(i.label)}</a>${subs}</li>`;}).join(''):''}</ul>
<ul class="st-nav-extra"><li><a href="${url.wishlist}"${cur('wishlist')}>Wishlist (<span data-badge="wish">0</span>)</a></li>${LANDING?`<li><a href="${LANDING}">The KITSYUU story</a></li>`:''}</ul></nav>
<div class="st-tools">
<a class="st-tool" href="${url.search()}"${cur('search')}>${ICONS.search}<span class="st-tool-label">Search</span></a>
<a class="st-tool st-tool-wish" href="${url.wishlist}"${cur('wishlist')}>${ICONS.heart}<span class="st-tool-label">Wishlist</span> <span class="st-count-badge">(<span data-badge="wish">0</span>)<span class="sr-only"> saved</span></span></a>
<a class="st-tool" href="${url.cart}"${cur('cart')}>${ICONS.bag}<span class="st-tool-label">Cart</span> <span class="st-count-badge">(<span data-badge="cart">0</span>)<span class="sr-only"> items</span></span></a>
<button class="st-tool st-menu-toggle" type="button" aria-expanded="false" aria-controls="st-nav">${ICONS.menu}<span class="st-menu-label">Menu</span></button>
</div>`;
  setupMenu();updateCounts();
}
function setupMenu(){
  const header=document.querySelector('[data-store-header]'),btn=header.querySelector('.st-menu-toggle'),nav=header.querySelector('#st-nav');
  const behind=[main,document.querySelector('[data-store-footer]'),document.querySelector('.st-notice')].filter(Boolean);
  const isOpen=()=>btn.getAttribute('aria-expanded')==='true';
  const set=open=>{
    btn.setAttribute('aria-expanded',String(open));btn.querySelector('.st-menu-label').textContent=open?'Close':'Menu';
    nav.classList.toggle('is-open',open);document.documentElement.classList.toggle('st-menu-open',open);behind.forEach(el=>el.inert=open);
    if(open){document.documentElement.style.setProperty('--st-menu-top',header.getBoundingClientRect().bottom+'px');nav.querySelector('a')?.focus();}
  };
  btn.addEventListener('click',()=>set(!isOpen()));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&isOpen()){set(false);btn.focus();}});
  nav.addEventListener('click',e=>{if(e.target.closest('a'))set(false);});
  matchMedia('(max-width: 900px)').addEventListener('change',()=>{if(isOpen())set(false);});
}
function renderFooter(){
  const el=document.querySelector('[data-store-footer]');
  const shop=C?navItems().map(i=>`<li><a href="${i.href}">${esc(i.key==='all'?'All products':i.label)}</a></li>`).join(''):'';
  el.innerHTML=`<div class="st-wrap"><div class="st-footer-top">
<div class="st-footer-brand"><a class="st-brand" href="${url.home}" aria-label="KITSYUU store home"><span class="logo-crop"><img src="${asset('assets/kitsyuu-icon.svg')}" alt="" width="1024" height="1024" loading="lazy"></span><span class="st-wordmark" aria-hidden="true">KITSYUU</span></a><p>JAPANESE STREETWEAR.<br>INDIAN STREETS.</p></div>
<nav aria-labelledby="st-f-shop"><h2 id="st-f-shop">Shop</h2><ul>${shop}</ul></nav>
${LANDING?`<nav aria-labelledby="st-f-brand"><h2 id="st-f-brand">KITSYUU</h2><ul><li><a href="${LANDING}">The story</a></li><li><a href="${LANDING}#edit">Style studies</a></li><li><a href="${LANDING}#about">Our world</a></li></ul></nav>`:''}
<div><h2>Prototype store</h2><p class="st-footer-note">Product names, sizes, prices and descriptions come from a prototype catalogue and are estimates, not confirmed company data. Product images are prototype-quality catalogue cutouts, not final product photography. Photography and commercial details may be updated. No orders, payments or sign-ups are processed.</p></div>
</div><div class="st-footer-bottom"><span>KITSYUU STORE / PROTOTYPE BUILD</span><a href="#main">Back to top ↑</a></div></div>`;
}

/* Status messages */
const toastEl=document.querySelector('.st-toast');let toastTimer=0;
function toast(msg){toastEl.textContent='';requestAnimationFrame(()=>{toastEl.textContent=msg;});clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toastEl.textContent='';},4200);}

/* Every heart (cards and product page) toggles the same wishlist entry. */
function syncWish(id,on){
  document.querySelectorAll(`[data-wish="${CSS.escape(id)}"]`).forEach(b=>{
    b.setAttribute('aria-pressed',String(on));const l=b.querySelector('[data-wish-label]');if(l)l.textContent=on?'Saved to wishlist':'Add to wishlist';
  });
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-wish]');if(!b||!C)return;
  e.preventDefault();const p=C.byId.get(b.dataset.wish);if(!p)return;
  const on=wish.toggle(p.id);syncWish(p.id,on);
  toast(on?`Saved ${p.name} to your wishlist.`:`Removed ${p.name} from your wishlist.`);
  if(page==='wishlist'&&!on)renderWishlist();
});
/* Keep counts and the cart/wishlist pages in step with other tabs. */
addEventListener('storage',e=>{
  if(!C||(e.key!==KEYS.cart&&e.key!==KEYS.wish))return;
  updateCounts();
  if(page==='cart')renderCart();else if(page==='wishlist')renderWishlist();
  else document.querySelectorAll('[data-wish]').forEach(b=>syncWish(b.dataset.wish,wish.has(b.dataset.wish)));
});

function crumbs(list){
  return `<nav class="st-crumbs" aria-label="Breadcrumb"><ol>${list.map((c,i)=>i===list.length-1?`<li><span aria-current="page">${esc(c.label)}</span></li>`:`<li><a href="${c.href}">${esc(c.label)}</a></li>`).join('')}</ol></nav>`;
}
function notFound(title,text){
  document.title=`${title} | KITSYUU Store`;
  main.innerHTML=`<div class="st-wrap"><section class="st-empty"><p class="eyebrow"><span></span>NOT IN THE PROTOTYPE CATALOGUE</p><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="button" href="${url.shop()}">Shop all products</a></section></div>`;
}

/* Store home */
function renderHome(){
  renderHeader();
  const na=C.collection('new-arrivals'),featured=C.featured();
  const fill=(slot,html)=>{const el=main.querySelector(`[data-slot="${slot}"]`);if(el)el.outerHTML=html;};
  const count=(slot,text)=>{const el=main.querySelector(`[data-count="${slot}"]`);if(el)el.textContent=text;};
  if(na){fill('new-arrivals',grid(na.products,{isNew:true}));count('new-arrivals',plural(na.products.length,'piece'));}
  fill('featured',grid(featured,(p,i)=>({index:i+1})));count('featured',plural(featured.length,'piece'));
  fill('categories',`<ul class="st-cat-grid">${C.top.map((c,i)=>{
    const list=C.inCategory(c.id),lead=list.find(p=>!imageOf(p).held),img=lead&&imageOf(lead);
    return `<li><a class="st-cat" href="${url.shop({category:c.id})}"><span class="st-cat-media">${img?`<img src="${esc(img.src)}" alt="" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`:''}</span><span class="st-cat-index" aria-hidden="true">${pad(i+1)}</span><span class="st-cat-meta"><span class="st-cat-name">${esc(c.label)}</span><span class="st-cat-count">${plural(list.length,'piece')}</span></span></a>
<ul class="st-cat-subs" aria-label="${esc(c.label)} categories">${C.children(c.id).map(s=>`<li><a href="${url.shop({category:s.id})}">${esc(s.label)}</a></li>`).join('')}</ul></li>`;}).join('')}</ul>`);
  const outer=C.inCategory('outerwear').filter(p=>!imageOf(p).held);
  fill('outerwear',`<ul class="st-feature-items">${outer.slice(0,2).map(p=>card(p)).join('')}</ul>`);
  const form=main.querySelector('.st-news-form');
  form?.addEventListener('submit',e=>{
    e.preventDefault();const input=form.querySelector('input'),msg=form.querySelector('.st-news-msg');
    if(!input.checkValidity()){input.setAttribute('aria-invalid','true');msg.textContent='Enter a valid email address.';input.focus();return;}
    input.removeAttribute('aria-invalid');msg.textContent='Thanks. This is a prototype, so the address was not sent or stored.';
  });
}

/* Listing: all products, a category or subcategory, or a collection */
function renderShop(){
  const catId=params.get('category'),colId=params.get('collection');
  let title,list,trail=[{label:'Store',href:url.home},{label:'Shop',href:url.shop()}],sub=null,aside='',active,tabs=null,isNew=false;
  if(colId){
    const col=C.collection(colId);
    if(!col)return renderHeader({}),notFound('Collection not found','This collection is not part of the prototype catalogue.');
    title=col.label;list=col.products;isNew=colId==='new-arrivals';trail.push({label:col.label});active={key:'col:'+colId,exact:true};
    aside=col.dataStatus==='prototype'?'A prototype selection for store development. These are not confirmed new arrivals.':'';
  }else if(catId){
    const cat=C.cats.get(catId);
    if(!cat)return renderHeader({}),notFound('Category not found','This category is not part of the prototype catalogue.');
    const top=cat.parent?C.cats.get(cat.parent):cat;
    title=cat.label;list=C.inCategory(cat.id);
    trail.push({label:top.label,href:url.shop({category:top.id})});if(cat.parent)trail.push({label:cat.label});else trail[trail.length-1]={label:top.label};
    sub=cat.parent?top.label:null;active={key:'cat:'+top.id,exact:!cat.parent,sub:cat.parent?cat.id:null};
    tabs={label:`${top.label} categories`,items:[{label:`All ${top.label.toLowerCase()}`,id:top.id,n:C.inCategory(top.id).length},...C.children(top.id).map(c=>({label:c.label,id:c.id,n:C.inCategory(c.id).length}))],current:cat.id,href:id=>url.shop({category:id})};
  }else{
    title='All products';list=C.d.products;trail[trail.length-1]={label:'Shop'};active={key:'all',exact:true};
    tabs={label:'Categories',items:[{label:'All products',id:'',n:C.d.products.length},...C.top.map(c=>({label:c.label,id:c.id,n:C.inCategory(c.id).length}))],current:'',href:id=>id?url.shop({category:id}):url.shop()};
  }
  renderHeader(active);
  document.title=`${title} | KITSYUU Store`;
  const sorts=SORTS(colId?'Collection order':'Catalogue order');
  let sort=sorts.some(s=>s.id===params.get('sort'))?params.get('sort'):'default';
  const withSort=href=>sort==='default'?href:href+(href.includes('?')?'&':'?')+'sort='+sort;
  main.innerHTML=`<div class="st-wrap">${crumbs(trail)}
<header class="st-plp-head"><h1>${sub?`<small>${esc(sub.toUpperCase())} /</small>`:''}${esc(title)}</h1><div class="st-plp-aside"><p class="st-result-count">${plural(list.length,'product')}</p>${aside?`<p>${esc(aside)}</p>`:''}</div></header>
${tabs?`<nav class="st-subnav" aria-label="${esc(tabs.label)}"><ul>${tabs.items.map(t=>`<li><a href="${tabs.href(t.id)}" data-keep-sort${t.id===tabs.current?' aria-current="page"':''}>${esc(t.label)}<sup>${pad(t.n)}</sup></a></li>`).join('')}</ul></nav>`:''}
${list.length>1?`<div class="st-toolbar"><label for="st-sort">Sort</label><select id="st-sort">${sorts.map(s=>`<option value="${s.id}"${s.id===sort?' selected':''}>${esc(s.label)}</option>`).join('')}</select><button class="st-clear" type="button" data-reset-sort${sort==='default'?' hidden':''}>Reset</button></div>`:''}
<div id="st-results">${list.length?grid(sortList(list,sort),{level:2,isNew}):`<p class="st-status">No products in this category yet.</p>`}</div>
<p class="sr-only" role="status" aria-live="polite" id="st-sort-status"></p>
<p class="st-footnote">Prototype catalogue: names, sizes, prices and descriptions are estimates and not confirmed company data. Prices in INR; tax inclusion not yet confirmed. Images are prototype catalogue cutouts without zoom.</p></div>`;
  const select=main.querySelector('#st-sort'),reset=main.querySelector('[data-reset-sort]');
  const apply=next=>{
    sort=next;select.value=sort;reset.hidden=sort==='default';
    const q=new URLSearchParams(location.search);if(sort==='default')q.delete('sort');else q.set('sort',sort);
    history.replaceState(null,'',location.pathname+(q.size?'?'+q:''));
    main.querySelector('#st-results').innerHTML=grid(sortList(list,sort),{level:2,isNew});
    main.querySelectorAll('[data-keep-sort]').forEach(a=>{const h=new URL(a.href);if(sort==='default')h.searchParams.delete('sort');else h.searchParams.set('sort',sort);a.href=h.pathname.split('/').pop()+h.search;});
    main.querySelector('#st-sort-status').textContent=`Sorted by ${sorts.find(s=>s.id===sort).label.toLowerCase()}.`;
  };
  select?.addEventListener('change',()=>apply(select.value));
  reset?.addEventListener('click',()=>{apply('default');select.focus();});
  if(sort!=='default')main.querySelectorAll('[data-keep-sort]').forEach(a=>{a.href=withSort(a.getAttribute('href'));});
}
/* Sorting only uses fields the catalogue already has: order, the New Arrivals collection, featured, and price. Ties keep catalogue order. */
const SORTS=base=>[{id:'default',label:base},{id:'new',label:'New arrivals first'},{id:'featured',label:'Featured first'},{id:'price-asc',label:'Price: low to high'},{id:'price-desc',label:'Price: high to low'}];
function sortList(list,sort){
  const na=C.collection('new-arrivals')?.productIds||[],rank=p=>{const i=na.indexOf(p.id);return i<0?Infinity:i;};
  const by={new:(a,b)=>rank(a)-rank(b),featured:(a,b)=>b.featured-a.featured,'price-asc':(a,b)=>a.price-b.price,'price-desc':(a,b)=>b.price-a.price}[sort];
  return by?list.map((p,i)=>[p,i]).sort((x,y)=>by(x[0],y[0])||x[1]-y[1]).map(x=>x[0]):list;
}

/* Product detail */
function renderProduct(){
  const p=C.bySlug(params.get('p')||'');
  if(!p)return renderHeader({}),notFound('Product not found','This product is not part of the prototype catalogue.');
  renderHeader({key:'cat:'+p.category,exact:false,sub:p.subcategory});
  document.title=`${p.name} | KITSYUU Store`;
  const imgs=imagesOf(p),img=imgs[0];
  const sizes=p.variants.map((v,i)=>`<label class="st-size"><input type="radio" name="size" value="${esc(v.size)}"${v.available?'':' disabled'}><span>${esc(v.size)}${v.available?'':'<span class="sr-only"> (unavailable)</span>'}</span></label>`).join('');
  const styled=(p.styledWith||[]).map(id=>C.byId.get(id)).filter(Boolean);
  const more=C.inCategory(p.subcategory).filter(x=>x!==p&&!styled.includes(x)).slice(0,4);
  const caption=img.held?['Photo coming soon','Product photography in preparation']:[img.quality==='prototype'?'Prototype image / catalogue cutout':'Product image','Official photography pending'];
  main.innerHTML=`<div class="st-wrap">${crumbs([{label:'Store',href:url.home},{label:'Shop',href:url.shop()},{label:catLabel(p.category),href:url.shop({category:p.category})},{label:catLabel(p.subcategory),href:url.shop({category:p.subcategory})},{label:p.name}])}
<article class="st-pdp" aria-labelledby="st-pdp-title">
<section class="st-gallery" aria-label="Product images" data-zoom="${img.zoom}">
<figure class="st-gallery-main${img.held?' is-held':''}"><div class="st-gallery-stage">${img.held?comingSoon(p,{label:true}):`<img id="st-main-img" src="${esc(img.src)}" alt="${esc(img.alt)}" width="${img.width}" height="${img.height}" style="--w:${img.width}px" decoding="async" fetchpriority="high">`}</div><figcaption><span>${esc(caption[0])}</span><span>${esc(caption[1])}</span></figcaption></figure>
${imgs.length>1?`<ul class="st-thumbs" aria-label="Choose an image">${imgs.map((m,i)=>`<li><button type="button" data-image="${i}" aria-pressed="${i===0}" aria-label="Show image ${i+1} of ${imgs.length}"><img src="${esc(m.src)}" alt="" loading="lazy"></button></li>`).join('')}</ul>`:''}
</section>
<div class="st-info">
<p class="st-pdp-meta"><b>${esc(categoryPath(p))}</b><br>SKU ${esc(p.sku)}</p>
<h1 id="st-pdp-title">${esc(p.name)}</h1>
<p class="st-pdp-price">${esc(C.money.format(p.price))}<small>Prototype price, estimated${C.d.meta.priceIncludesTax===null?'. Tax inclusion unconfirmed':''}</small></p>
<p class="st-colour"><i style="background:${esc(p.colour?.swatches?.[0]||'transparent')}" aria-hidden="true"></i>Colour <b>${esc(p.colour?.label)}</b></p>
<p class="st-desc">${esc(p.description)}</p>
<form class="st-buy" novalidate>
<fieldset class="st-fieldset"><legend>Size <span aria-hidden="true" data-size-label>Select a size</span></legend><div class="st-sizes">${sizes}</div></fieldset>
<div class="st-qty-row"><div class="st-qty" role="group" aria-label="Quantity"><button type="button" data-step="-1" aria-label="Decrease quantity">−</button><input id="st-qty" type="number" inputmode="numeric" min="1" max="10" value="1" aria-label="Quantity"><button type="button" data-step="1" aria-label="Increase quantity">+</button></div>
<button class="button st-add" type="submit">Add to cart</button></div>
<button class="st-wish-btn" type="button" data-wish="${esc(p.id)}" aria-pressed="${wish.has(p.id)}">${ICONS.heart}<span data-wish-label>${wish.has(p.id)?'Saved to wishlist':'Add to wishlist'}</span></button>
<p class="st-phase-note st-buy-status" id="st-buy-status" role="status" aria-live="polite"></p>
</form>
<div class="st-details">
${p.features?.length?`<details open><summary>Details</summary><ul>${p.features.map(f=>`<li>${esc(f)}</li>`).join('')}</ul></details>`:''}
<details><summary>Material &amp; care</summary><p>${[p.material,p.care,p.origin].filter(Boolean).map(esc).join('<br>')||'Material, care and origin details have not been supplied yet.'}</p></details>
<details><summary>Product data</summary><dl><dt>SKU</dt><dd>${esc(p.sku)}</dd><dt>Catalogue ref</dt><dd>${esc(p.catalogueRef)}</dd><dt>Category</dt><dd>${esc(categoryPath(p))}</dd><dt>Data</dt><dd>Prototype. Not confirmed company data.</dd><dt>Image</dt><dd>${img.held?'Withheld pending clearance':'Prototype catalogue cutout, no zoom'}</dd></dl></details>
</div>
</div>
</article>
${styled.length?`<section class="st-rail" aria-labelledby="st-styled"><div class="section-label"><span>STYLED WITH</span><span>AS PAIRED IN THE PROTOTYPE CATALOGUE</span></div><div class="st-section-head"><h2 id="st-styled">Complete<br><em>the look.</em></h2></div>${grid(styled,{level:3})}</section>`:''}
${more.length?`<section class="st-rail" aria-labelledby="st-more"><div class="section-label"><span>MORE ${esc(catLabel(p.subcategory).toUpperCase())}</span><span>${plural(more.length,'piece')}</span></div><div class="st-section-head"><h2 id="st-more">More<br><em>${esc(catLabel(p.subcategory))}.</em></h2><a class="text-link" href="${url.shop({category:p.subcategory})}">View all <span aria-hidden="true">↗</span></a></div>${grid(more,{level:3})}</section>`:''}
<p class="st-footnote">Prototype catalogue: names, sizes, prices and descriptions are estimates and not confirmed company data.</p></div>`;

  const form=main.querySelector('.st-buy'),qty=form.querySelector('#st-qty'),label=form.querySelector('[data-size-label]');
  const steps=form.querySelectorAll('[data-step]');
  const setQty=v=>{const n=Math.min(10,Math.max(1,Math.round(Number(v))||1));qty.value=n;steps[0].disabled=n<=1;steps[1].disabled=n>=10;};
  steps.forEach(b=>b.addEventListener('click',()=>setQty(Number(qty.value)+Number(b.dataset.step))));
  qty.addEventListener('change',()=>setQty(qty.value));setQty(1);
  const sizeSet=form.querySelector('.st-fieldset'),status=form.querySelector('#st-buy-status');
  form.addEventListener('change',e=>{if(e.target.name==='size'){label.textContent=`Selected: ${e.target.value}`;sizeSet.classList.remove('is-invalid');sizeSet.removeAttribute('aria-describedby');}});
  form.addEventListener('submit',e=>{
    e.preventDefault();
    const size=form.querySelector('input[name="size"]:checked');
    if(!size){
      sizeSet.classList.add('is-invalid');sizeSet.setAttribute('aria-describedby','st-buy-status');label.textContent='Select a size';
      status.textContent='Select a size to add this to your cart.';form.querySelector('input[name="size"]:not(:disabled)')?.focus();return;
    }
    setQty(qty.value);
    const r=cart.add(p,size.value,Number(qty.value));
    if(!r.ok){status.textContent='Your cart could not be saved in this browser.';return;}
    status.innerHTML=`${r.capped?`Your cart now has the maximum of ${MAX_QTY} in size ${esc(size.value)}.`:`Added to cart: size ${esc(size.value)}, quantity ${r.merged?`now ${r.qty}`:r.qty}.`} <a href="${url.cart}">View cart</a>`;
  });
  main.querySelectorAll('[data-image]').forEach(b=>b.addEventListener('click',()=>{
    const m=imgs[Number(b.dataset.image)],el=main.querySelector('#st-main-img');
    Object.assign(el,{src:m.src,alt:m.alt,width:m.width,height:m.height});el.style.setProperty('--w',m.width+'px');
    main.querySelectorAll('[data-image]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
  }));
}

/* Shared bits for the cart, wishlist, search and checkout pages */
const money=n=>esc(C.money.format(n));
function pageHead(label,title,aside=''){
  return `${crumbs([{label:'Store',href:url.home},{label}])}<header class="st-plp-head"><h1 id="st-page-title" tabindex="-1">${esc(title)}</h1>${aside?`<div class="st-plp-aside">${aside}</div>`:''}</header>`;
}
function emptyState(title,text,cta=`<a class="button" href="${url.shop()}">Shop all products</a>`){
  return `<section class="st-empty st-empty-inline"><p class="eyebrow"><span></span>NOTHING HERE YET</p><h2>${esc(title)}</h2><p>${esc(text)}</p>${cta}</section>`;
}
const lineKey=l=>`${l.id}|${l.size}`;
const lineImage=l=>{const p=C.byId.get(l.id),img=imageOf(p);return img.held?`<img src="${esc(img.src)}" alt="" width="600" height="800">`:`<img src="${esc(img.src)}" alt="" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`;};

/* Cart page */
function renderCart(focus){
  document.title='Cart | KITSYUU Store';
  const lines=cart.lines(),count=lines.reduce((n,l)=>n+l.qty,0);
  main.innerHTML=`<div class="st-wrap">${pageHead('Cart','Cart',`<p class="st-result-count">${plural(count,'item')}</p>`)}
${lines.length?`<div class="st-cart">
<ul class="st-lines" aria-label="Items in your cart">${lines.map(l=>{const p=C.byId.get(l.id),href=url.product(p),k=esc(lineKey(l));return `<li class="st-line" data-line="${k}">
<a class="st-line-media" href="${href}" tabindex="-1" aria-hidden="true">${lineImage(l)}</a>
<div class="st-line-info"><h2 class="st-line-name"><a href="${href}">${esc(l.name)}</a></h2><p class="st-line-meta">SKU ${esc(l.sku)}<br>Size <b>${esc(l.size)}</b></p><p class="st-line-unit">${money(l.price)} <small>each</small></p></div>
<div class="st-line-controls"><div class="st-qty" role="group" aria-label="Quantity for ${esc(l.name)}, size ${esc(l.size)}"><button type="button" data-line-step="-1" aria-label="Decrease quantity"${l.qty<=1?' disabled':''}>−</button><input type="number" inputmode="numeric" min="1" max="${MAX_QTY}" value="${l.qty}" data-line-qty aria-label="Quantity"><button type="button" data-line-step="1" aria-label="Increase quantity"${l.qty>=MAX_QTY?' disabled':''}>+</button></div>
<button class="st-line-remove" type="button" data-line-remove>Remove<span class="sr-only"> ${esc(l.name)}, size ${esc(l.size)}</span></button></div>
<p class="st-line-total"><span class="sr-only">Line total </span>${money(l.price*l.qty)}</p>
</li>`;}).join('')}</ul>
<aside class="st-summary" aria-labelledby="st-summary-title"><h2 id="st-summary-title">Summary</h2>
<dl><dt>Subtotal <small>(${plural(count,'item')})</small></dt><dd>${money(cart.subtotal(lines))}</dd><dt>Shipping</dt><dd>Not calculated</dd></dl>
<a class="button st-checkout" href="${url.checkout}">Checkout (prototype)</a>
<p class="st-note">Prototype checkout. No payment is taken and no order is placed. Prices are estimates in INR; tax inclusion is unconfirmed.</p>
<a class="text-link" href="${url.shop()}">Continue shopping <span aria-hidden="true">↗</span></a></aside>
</div>`:emptyState('Your cart is empty.','Choose a product and a size to add it here.')}</div>`;
  if(focus)(main.querySelector(focus)||main.querySelector('#st-page-title')).focus();
}
function setupCartPage(){
  const act=(el,fn)=>{const li=el.closest('[data-line]');if(!li)return;const [id,size]=li.dataset.line.split('|');fn(id,size,li);};
  main.addEventListener('click',e=>{
    const step=e.target.closest('[data-line-step]'),rm=e.target.closest('[data-line-remove]');
    if(step)act(step,(id,size,li)=>{const l=cart.setQty(id,size,Number(li.querySelector('[data-line-qty]').value)+Number(step.dataset.lineStep));
      renderCart(`[data-line="${CSS.escape(`${id}|${size}`)}"] [data-line-step="${step.dataset.lineStep}"]:not(:disabled)`);if(l)toast(`${l.name}, size ${size}: quantity ${l.qty}.`);});
    if(rm)act(rm,(id,size,li)=>{
      const next=li.nextElementSibling||li.previousElementSibling,name=C.byId.get(id).name;cart.remove(id,size);
      renderCart(next?`[data-line="${CSS.escape(next.dataset.line)}"] [data-line-remove]`:null);toast(`Removed ${name}, size ${size}, from your cart.`);
    });
  });
  main.addEventListener('change',e=>{if(e.target.matches('[data-line-qty]'))act(e.target,(id,size)=>{cart.setQty(id,size,e.target.value);renderCart(`[data-line="${CSS.escape(`${id}|${size}`)}"] [data-line-qty]`);});});
}

/* Wishlist page */
function renderWishlist(){
  document.title='Wishlist | KITSYUU Store';
  const list=wish.ids().map(id=>C.byId.get(id));
  const hadFocus=main.contains(document.activeElement);
  main.innerHTML=`<div class="st-wrap">${pageHead('Wishlist','Wishlist',`<p class="st-result-count">${plural(list.length,'product')}</p><p>Saved in this browser. Choose a size on the product page to add a piece to your cart.</p>`)}
${list.length?grid(list,{level:2}):emptyState('Your wishlist is empty.','Tap the heart on any product to save it here.')}</div>`;
  if(hadFocus)main.querySelector('#st-page-title').focus();
}

/* Search: every term must match the start of a word in the name, SKU, category or subcategory. */
const norm=s=>String(s??'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
function searchProducts(q){
  const terms=norm(q).split(' ').filter(Boolean);if(!terms.length)return[];
  return C.d.products.filter(p=>{
    const hay=' '+norm([p.name,p.sku,p.sku.replace(/-/g,''),catLabel(p.category),catLabel(p.subcategory)].join(' '))+' ';
    return terms.every(t=>hay.includes(' '+t));
  });
}
function renderSearch(){
  document.title='Search | KITSYUU Store';
  const browse=`<ul class="st-search-browse">${[...C.top,...C.d.categories.filter(c=>c.parent)].map(c=>`<li><a href="${url.shop({category:c.id})}">${esc(c.parent?`${catLabel(c.parent)} / ${c.label}`:c.label)}</a></li>`).join('')}</ul>`;
  main.innerHTML=`<div class="st-wrap">${pageHead('Search','Search')}
<form class="st-search" role="search" action="${url.search()}"><label for="st-q">Search by product name, SKU or category</label>
<div class="st-search-row"><input id="st-q" name="q" type="search" value="${esc(params.get('q')||'')}" autocomplete="off" spellcheck="false" placeholder="Hoodie, KTS-BTM-004, jeans…"><button class="button" type="submit">Search</button></div></form>
<p class="st-result-count st-search-count" id="st-search-count" role="status" aria-live="polite"></p>
<div id="st-results"></div></div>`;
  const input=main.querySelector('#st-q'),out=main.querySelector('#st-results'),count=main.querySelector('#st-search-count');
  const run=()=>{
    const q=input.value.trim(),hits=searchProducts(q);
    history.replaceState(null,'',url.search(q));
    if(!q){count.textContent='';out.innerHTML=`<section class="st-search-empty"><h2>Browse categories</h2>${browse}</section>`;return;}
    count.textContent=`${plural(hits.length,'result')} for “${q}”`;
    out.innerHTML=hits.length?grid(hits,{level:2}):`<section class="st-search-empty"><h2>No products match “${esc(q)}”.</h2><p>Check the spelling, try a shorter word, or search by SKU (for example KTS-TOP-004). You can also browse a category:</p>${browse}<button class="st-clear" type="button" data-clear-search>Clear search</button></section>`;
  };
  let t=0;input.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(run,160);});
  main.querySelector('form').addEventListener('submit',e=>{e.preventDefault();clearTimeout(t);run();});
  out.addEventListener('click',e=>{if(e.target.closest('[data-clear-search]')){input.value='';run();input.focus();}});
  run();if(!input.value)input.focus();
}

/* Checkout prototype: no payment fields, nothing is sent. The order summary is kept in sessionStorage only so the
   confirmation page can show it; the cart is cleared only after that save succeeds. */
const FIELDS=[
  {id:'name',label:'Full name',group:'contact',auto:'name',msg:'Enter your full name.'},
  {id:'email',label:'Email',group:'contact',type:'email',auto:'email',msg:'Enter a valid email address.'},
  {id:'phone',label:'Mobile number',group:'contact',type:'tel',auto:'tel',pattern:'[+0-9 ]{10,15}',mode:'tel',msg:'Enter a 10-digit mobile number.'},
  {id:'address1',label:'Address',group:'ship',auto:'address-line1',msg:'Enter your street address.'},
  {id:'address2',label:'Apartment, landmark (optional)',group:'ship',auto:'address-line2',optional:true},
  {id:'city',label:'City',group:'ship',auto:'address-level2',msg:'Enter your city.'},
  {id:'state',label:'State',group:'ship',auto:'address-level1',msg:'Enter your state.'},
  {id:'pin',label:'PIN code',group:'ship',auto:'postal-code',pattern:'[1-9][0-9]{5}',mode:'numeric',msg:'Enter a 6-digit PIN code.'}
];
function field(f){
  return `<div class="st-field${f.id==='address1'||f.id==='address2'?' st-field-wide':''}"><label for="st-f-${f.id}">${esc(f.label)}</label><input id="st-f-${f.id}" name="${f.id}" type="${f.type||'text'}" autocomplete="${f.auto}"${f.optional?'':' required'}${f.pattern?` pattern="${f.pattern}"`:''}${f.mode?` inputmode="${f.mode}"`:''}><p class="st-field-error" id="st-e-${f.id}" hidden></p></div>`;
}
function summaryHTML(lines,title='Order summary'){
  return `<aside class="st-summary" aria-labelledby="st-summary-title"><h2 id="st-summary-title">${esc(title)}</h2>
<ul class="st-mini">${lines.map(l=>`<li><span class="st-mini-media">${lineImage(l)}</span><span class="st-mini-info"><b>${esc(l.name)}</b><small>SKU ${esc(l.sku)}</small><small>Size ${esc(l.size)} · Qty ${l.qty}</small></span><span class="st-mini-total">${money(l.price*l.qty)}</span></li>`).join('')}</ul>
<dl><dt>Subtotal</dt><dd>${money(lines.reduce((s,l)=>s+l.price*l.qty,0))}</dd><dt>Shipping</dt><dd>Not calculated</dd></dl></aside>`;
}
function renderCheckout(){
  document.title='Checkout (prototype) | KITSYUU Store';
  const lines=cart.lines();
  if(!lines.length){main.innerHTML=`<div class="st-wrap">${pageHead('Checkout','Checkout')}${emptyState('Your cart is empty.','Add a product to your cart before checking out.')}</div>`;return;}
  main.innerHTML=`<div class="st-wrap">${crumbs([{label:'Store',href:url.home},{label:'Cart',href:url.cart},{label:'Checkout'}])}
<header class="st-plp-head"><h1 id="st-page-title" tabindex="-1">Checkout</h1><div class="st-plp-aside"><p class="st-result-count">Prototype</p><p>This is a demonstration checkout, not a real purchase. Nothing is charged and nothing is sent to KITSYUU.</p></div></header>
<div class="st-cart st-checkout-layout">
<form class="st-checkout-form" novalidate>
<div class="st-form-alert" id="st-form-alert" role="alert" hidden></div>
<fieldset class="st-form-group"><legend>01 / Contact</legend><div class="st-fields">${FIELDS.filter(f=>f.group==='contact').map(field).join('')}</div></fieldset>
<fieldset class="st-form-group"><legend>02 / Shipping address</legend><div class="st-fields">${FIELDS.filter(f=>f.group==='ship').map(field).join('')}<div class="st-field"><span class="st-field-label">Country</span><p class="st-field-static">India</p></div></div></fieldset>
<fieldset class="st-form-group st-pay"><legend>03 / Payment <span class="st-proto-tag">Prototype</span></legend><p>No payment is taken in this prototype. Card, UPI and bank details are not requested, and no payment provider is connected.</p></fieldset>
<button class="button st-place" type="submit">Place prototype order</button>
<p class="st-note">Your details stay in this browser tab to show the confirmation. They are not sent or stored anywhere else.</p>
</form>
${summaryHTML(lines)}
</div></div>`;
  const form=main.querySelector('form'),alertBox=main.querySelector('#st-form-alert');
  const check=(f,show)=>{
    const input=form.elements[f.id],err=main.querySelector(`#st-e-${f.id}`);
    if(f.id==='phone')input.value=input.value.replace(/[^+0-9 ]/g,'');
    input.value=input.value.replace(/^\s+|\s+$/g,'');
    const bad=!f.optional&&!input.checkValidity();
    if(show||!bad){
      if(bad){input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',err.id);}else{input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}
      err.hidden=!bad;err.textContent=bad?f.msg:'';
    }
    return !bad;
  };
  form.addEventListener('change',e=>{const f=FIELDS.find(f=>f.id===e.target.name);if(f&&e.target.hasAttribute('aria-invalid'))check(f,true);});
  form.addEventListener('submit',e=>{
    e.preventDefault();
    const bad=FIELDS.filter(f=>!check(f,true));
    if(bad.length){alertBox.hidden=false;alertBox.textContent=`Please check ${bad.length===1?'1 field':`${bad.length} fields`}: ${bad.map(f=>f.label.replace(' (optional)','')).join(', ')}.`;form.elements[bad[0].id].focus();return;}
    alertBox.hidden=true;
    const current=cart.lines();if(!current.length){renderCheckout();return;}
    const v=Object.fromEntries(FIELDS.map(f=>[f.id,form.elements[f.id].value]));
    const d=new Date(),rand=[...crypto.getRandomValues(new Uint8Array(4))].map(b=>'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b%31]).join('');
    const order={ref:`KTS-PROTO-${String(d.getFullYear()).slice(2)}${pad(d.getMonth()+1)}${pad(d.getDate())}-${rand}`,createdAt:d.toISOString(),
      lines:current,subtotal:cart.subtotal(current),customer:{name:v.name,email:v.email,phone:v.phone},shipping:{address1:v.address1,address2:v.address2,city:v.city,state:v.state,pin:v.pin,country:'India'}};
    try{sessionStorage.setItem(KEYS.order,JSON.stringify(order));}
    catch{alertBox.hidden=false;alertBox.textContent='This browser blocked saving the prototype order, so your cart was kept. Please try again.';return;}
    cart.clear();location.assign(url.confirmation);
  });
}
function renderConfirmation(){
  document.title='Prototype order | KITSYUU Store';
  let o=null;try{o=JSON.parse(sessionStorage.getItem(KEYS.order)||'null');}catch{}
  if(!o?.ref||!Array.isArray(o.lines)){main.innerHTML=`<div class="st-wrap">${pageHead('Prototype order','Prototype order')}${emptyState('No prototype order to show.','A confirmation appears here after you complete the prototype checkout in this tab.')}</div>`;return;}
  const s=o.shipping||{},c=o.customer||{};
  main.innerHTML=`<div class="st-wrap">${crumbs([{label:'Store',href:url.home},{label:'Prototype order'}])}
<section class="st-confirm" aria-labelledby="st-page-title"><p class="eyebrow"><span></span>PROTOTYPE / NOT A REAL PURCHASE</p>
<h1 id="st-page-title" tabindex="-1">Prototype order<br><em>complete.</em></h1>
<p class="st-confirm-lead">This was a demonstration checkout. No order was placed with KITSYUU, nothing was charged, and no details were sent.</p>
<dl class="st-confirm-ref"><dt>Prototype reference</dt><dd>${esc(o.ref)}</dd></dl></section>
<div class="st-cart st-checkout-layout">
<div class="st-confirm-details"><section class="st-form-group"><h2>Contact</h2><p>${esc(c.name)}<br>${esc(c.email)}<br>${esc(c.phone)}</p></section>
<section class="st-form-group"><h2>Ship to</h2><p>${[s.address1,s.address2,[s.city,s.state].filter(Boolean).join(', '),s.pin,s.country].filter(Boolean).map(esc).join('<br>')}</p></section>
<a class="button" href="${url.shop()}">Continue shopping</a></div>
${summaryHTML(o.lines.filter(l=>C.byId.has(l.id)),'Items')}
</div></div>`;
  main.querySelector('#st-page-title').focus();
}

/* Store hero turntable: the integration point for a future real 360° sequence of KTS-OUT-001 (Hook Closure Cropped Jacket).
   Dormant until the hero's data-turntable names a manifest (path relative to the site root). While it is empty, nothing is
   requested and hero.webp shows as before.
   Manifest: the same shape as assets/sequence.json (count, width, height, padding, pattern, poster, fps), plus
     loop: true         play continuously (false stops on the last frame)
     stillFrame: n      the approved frame shown for reduced motion, and first while the loop loads
   Frames must be a real turntable capture: FRONT → FRONT 3/4 → SIDE → BACK → SIDE → FRONT 3/4 → FRONT, with the last frame
   leading back into the first. Like the landing page's FramePlayer, compressed frames are fetched once, only a small window
   of decoded frames is kept, the canvas is capped at 2× density, and playback pauses when hidden or off-screen.
   Any failure keeps hero.webp. */
class TurntablePlayer{
  constructor(hero,m){
    this.hero=hero;this.m=m;this.poster=hero.querySelector('.st-hero-img');this.canvas=hero.querySelector('.st-hero-sequence');
    this.ctx=this.canvas.getContext('2d',{alpha:false});if(!this.ctx)throw Error('Canvas unavailable');
    this.blobs=new Array(m.count);this.cache=new Map();this.ahead=12;this.shown=-1;this.raf=0;this.run=0;this.ready=false;this.visible=true;this.dead=false;
    this.still=Math.min(m.count-1,Math.max(0,m.stillFrame|0));
    this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotion=()=>this.mode();this.motion.addEventListener('change',this.onMotion);
    this.onVisibility=()=>this.play();document.addEventListener('visibilitychange',this.onVisibility);
    this.io=new IntersectionObserver(([e])=>{this.visible=e.isIntersecting;this.play();});this.io.observe(hero);
    this.ro=new ResizeObserver(()=>this.resize());this.ro.observe(this.poster);
    if(m.poster)this.poster.src=asset(m.poster);
    this.canvas.hidden=false;this.resize();this.mode();
  }
  get reduced(){return this.motion.matches||document.documentElement.classList.contains('st-reduce');}
  url(i){return asset(this.m.pattern.replace('{index}',String(i).padStart(this.m.padding||4,'0')));}
  blob(i){return this.blobs[i]??=fetch(this.url(i)).then(r=>{if(!r.ok)throw Error(`Frame ${i}: HTTP ${r.status}`);return r.blob();});}
  bitmap(i){
    let job=this.cache.get(i);
    if(!job){job=this.blob(i).then(b=>createImageBitmap(b)).then(bm=>job.bm=bm);job.catch(()=>this.cache.delete(i));this.cache.set(i,job);}
    return job;
  }
  evict(at){
    for(const [i,job] of this.cache){const d=(i-at+this.m.count)%this.m.count;if(d>=this.ahead&&i!==this.still&&i!==this.shown){this.cache.delete(i);job.then(bm=>bm.close(),()=>{});}}
  }
  async mode(){
    const run=++this.run;cancelAnimationFrame(this.raf);this.raf=0;this.ready=false;
    try{
      this.draw(await this.bitmap(this.still),this.still);this.hero.classList.add('is-turntable');
      if(this.reduced)return;
      let next=0;const worker=async()=>{while(next<this.m.count&&run===this.run)await this.blob(next++);};
      await Promise.all(Array.from({length:4},worker));
      if(run!==this.run||this.reduced)return;
      this.ready=true;this.start=performance.now()-this.still/this.m.fps*1000;this.play();
    }catch(e){if(run===this.run){console.warn('Turntable unavailable; keeping the hero image.',e);this.destroy();}}
  }
  play(){
    if(this.dead||!this.ready||this.reduced||this.raf||document.hidden||!this.visible)return;
    const step=now=>{
      this.raf=0;if(this.dead||!this.ready||this.reduced||document.hidden||!this.visible)return;
      const n=Math.floor((now-this.start)/1000*this.m.fps),i=this.m.loop===false?Math.min(n,this.m.count-1):n%this.m.count;
      for(let d=0;d<this.ahead;d++)this.bitmap((i+d)%this.m.count);
      const job=this.cache.get(i);if(job?.bm&&i!==this.shown)this.draw(job.bm,i);
      this.evict(i);this.raf=requestAnimationFrame(step);
    };
    this.raf=requestAnimationFrame(step);
  }
  resize(){
    const p=this.poster,c=this.canvas;
    Object.assign(c.style,{left:p.offsetLeft+'px',top:p.offsetTop+'px',width:p.offsetWidth+'px',height:p.offsetHeight+'px'});
    const scale=Math.min(devicePixelRatio||1,2,3840/Math.max(p.offsetWidth,p.offsetHeight,1));
    c.width=Math.max(1,Math.round(p.offsetWidth*scale));c.height=Math.max(1,Math.round(p.offsetHeight*scale));
    const job=this.cache.get(this.shown);if(job?.bm)this.draw(job.bm,this.shown);
  }
  /* Same framing as the poster: object-fit cover at the poster's object-position. */
  draw(bm,i){
    const c=this.canvas,[px,py]=getComputedStyle(this.poster).objectPosition.split(' ').map(v=>parseFloat(v)/100);
    const k=Math.max(c.width/bm.width,c.height/bm.height),w=bm.width*k,h=bm.height*k;
    this.ctx.imageSmoothingQuality='high';this.ctx.drawImage(bm,(c.width-w)*(px||.5),(c.height-h)*(py||.5),w,h);this.shown=i;
  }
  destroy(){
    this.dead=true;this.run++;cancelAnimationFrame(this.raf);this.io.disconnect();this.ro.disconnect();
    this.motion.removeEventListener('change',this.onMotion);document.removeEventListener('visibilitychange',this.onVisibility);
    this.hero.classList.remove('is-turntable');this.canvas.hidden=true;
    for(const job of this.cache.values())job.then(bm=>bm.close(),()=>{});this.cache.clear();
  }
}
function initTurntable(){
  const hero=document.querySelector('.st-hero[data-turntable]'),src=hero?.dataset.turntable.trim();
  if(!src||!window.createImageBitmap)return;
  fetch(asset(src)).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}).then(m=>{
    if(!(m.count>0&&m.pattern&&m.fps>0))throw Error('Invalid turntable manifest');
    new TurntablePlayer(hero,m);
  }).catch(e=>console.warn('Turntable unavailable; keeping the hero image.',e));
}

renderHeader();
initTurntable();
fetch(DATA_URL).then(r=>{if(!r.ok)throw Error(r.status);return r.json();}).then(d=>{
  C=catalogue(d);
  ({home:renderHome,shop:renderShop,product:renderProduct,
    cart:()=>{renderHeader({tool:'cart'});renderCart();setupCartPage();},
    wishlist:()=>{renderHeader({tool:'wishlist'});renderWishlist();},
    search:()=>{renderHeader({tool:'search'});renderSearch();},
    checkout:()=>{renderHeader({});renderCheckout();},
    confirmation:()=>{renderHeader({});renderConfirmation();}})[page]?.();
  updateCounts();
  renderFooter();
}).catch(err=>{
  console.error(err);
  main.innerHTML=`<div class="st-wrap"><section class="st-empty"><p class="eyebrow"><span></span>CATALOGUE UNAVAILABLE</p><h1>Products could not load.</h1><p>Open the store through the local server (run node server.cjs, then visit http://127.0.0.1:3000/store/).</p></section></div>`;
});
})();
