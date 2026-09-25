/* Kietsu: semantic content stays independent of the bounded canvas frame cache. */
'use strict';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
function filterStudies(value){
  let count=0;
  document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===value)));
  document.querySelectorAll('[data-category]').forEach(c=>{c.hidden=value!=='all'&&c.dataset.category!==value;if(!c.hidden)count++;});
  document.querySelector('#filter-status').textContent=`Showing ${count} ${value==='all'?'':value+' '}style ${count===1?'study':'studies'}.`;
}
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>filterStudies(b.dataset.filter)));
document.querySelectorAll('[data-select-filter]').forEach(a=>a.addEventListener('click',()=>filterStudies(a.dataset.selectFilter)));
document.querySelectorAll('a[href="#edit"]:not([data-select-filter])').forEach(a=>a.addEventListener('click',()=>filterStudies('all')));
document.querySelectorAll('.skip,.skip-motion').forEach(a=>a.addEventListener('click',()=>{document.querySelector('#edit').focus({preventScroll:true});}));
const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
const constrained=()=>innerHeight<650||navigator.connection?.saveData||['slow-2g','2g'].includes(navigator.connection?.effectiveType)||(navigator.deviceMemory&&navigator.deviceMemory<=2);
let player=null;
let userReduced=false,sequenceUrl='assets/sequence.json';
try{userReduced=localStorage.getItem('kietsu-reduce-motion')==='true';}catch{}
const motionButton=document.querySelector('.motion-toggle');
motionButton.addEventListener('click',()=>{
  userReduced=!userReduced;
  try{localStorage.setItem('kietsu-reduce-motion',String(userReduced));}catch{}
  player?.destroy();player=null;
  if(userReduced)useStill();else initMotion(sequenceUrl);
});

class FramePlayer {
  constructor(manifest){
    this.m=manifest;this.canvas=document.querySelector('#sequence');this.ctx=this.canvas.getContext('2d',{alpha:false});
    if(!this.ctx)throw Error('Canvas unavailable');
    this.cache=new Map();this.inflight=new Map();this.failures=new Map();this.target=0;this.last=-1;this.direction=1;this.raf=0;this.dead=false;this.active=true;
    this.limit=innerWidth<700?14:20;this.story=document.querySelector('.story');this.stage=document.querySelector('.stage');this.media=document.querySelector('.stage-media');
    this.opening=document.querySelector('[data-chapter="opening"]');this.street=document.querySelector('[data-chapter="street"]');this.label=document.querySelector('#chapter-label');this.bar=document.querySelector('.story-progress>span');
    this.onScroll=()=>{if(!this.raf)this.raf=requestAnimationFrame(()=>{this.raf=0;this.update();});};
    this.onVisibility=()=>{this.active=!document.hidden;if(this.active)this.onScroll();else this.abortAll();};
    this.observer=new ResizeObserver(()=>{this.resize();this.onScroll();});this.observer.observe(this.media);
    document.documentElement.classList.add('motion-ready');this.story.style.setProperty('--travel',`${manifest.travelVH}svh`);
    addEventListener('scroll',this.onScroll,{passive:true});document.addEventListener('visibilitychange',this.onVisibility);
    this.resize();this.update();
  }
  frameAt(p){
    const travel=p*this.m.travelVH;
    const beat=this.m.beats.find(b=>travel<=b.endVH)||this.m.beats.at(-1);
    const local=clamp((travel-beat.startVH)/(beat.endVH-beat.startVH));
    return Math.round(beat.startFrame+(beat.endFrame-beat.startFrame)*local);
  }
  update(){
    if(this.dead)return;
    const bounds=this.story.getBoundingClientRect(),distance=this.story.offsetHeight-this.stage.offsetHeight;
    const stickyTop=parseFloat(getComputedStyle(this.stage).top)||0;
    const p=clamp((stickyTop-bounds.top)/Math.max(1,distance));
    this.active=!document.hidden&&bounds.bottom>0&&bounds.top<innerHeight;
    const next=clamp(this.frameAt(p),0,this.m.count-1);this.direction=next>=this.target?1:-1;this.target=next;
    const openingOpacity=1-clamp((p-.20)/.10),streetOpacity=clamp((p-.84)/.06);
    this.setCopy(this.opening,openingOpacity);
    const word=document.querySelector('.hero-wordmark'),exit=clamp(p/.27);
    word.style.transform=`translate(-50%, calc(-50% - ${exit*32}vh)) scale(${1+exit*.65}) rotate(${-exit*7}deg)`;
    word.style.opacity=String(1-clamp((exit-.15)/.85));this.setCopy(this.street,streetOpacity);
    this.label.textContent=p<.3?'01 / THE FORM':p<.79?'02 / UNRAVEL':'03 / THE REVEAL';this.bar.style.transform=`scaleX(${p})`;
    this.canvas.dataset.targetFrame=String(next);this.canvas.dataset.progress=p.toFixed(3);
    if(!this.active){this.abortAll();return;}
    for(const [i,job] of this.inflight)if(Math.abs(i-next)>28)job.abort();
    this.drawNearest();this.pump();
  }
  setCopy(el,opacity){el.hidden=opacity<=0;el.inert=opacity<.15;el.style.opacity=opacity;el.setAttribute('aria-hidden',String(opacity<.15));}
  resize(){
    this.limit=innerWidth<700?14:20;this.evict();
    const rect=this.media.getBoundingClientRect();const scale=Math.min(devicePixelRatio||1,2,3840/Math.max(rect.width,rect.height));
    this.canvas.width=Math.max(1,Math.round(rect.width*scale));this.canvas.height=Math.max(1,Math.round(rect.height*scale));this.last=-1;this.drawNearest();
  }
  priorities(){const list=[this.target];for(let d=1;d<=7;d++){list.push(this.target+d*this.direction);if(d<=4)list.push(this.target-d*this.direction);}return list.filter(i=>i>=0&&i<this.m.count);}
  pump(){
    if(this.dead||!this.active)return;
    for(const i of this.priorities()){
      if(this.inflight.size>=3)break;
      if(this.cache.has(i)||this.inflight.has(i)||(this.failures.get(i)||0)>=2)continue;
      this.load(i);
    }
  }
  async load(i){
    const controller=new AbortController();this.inflight.set(i,controller);let bitmap;
    try{
      const url=this.m.pattern.replace('{index}',String(i).padStart(this.m.padding, '0'));
      const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw Error('Frame unavailable');
      const blob=await response.blob();
      if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(blob);
      else{bitmap=new Image();const u=URL.createObjectURL(blob);try{bitmap.src=u;await bitmap.decode();}finally{URL.revokeObjectURL(u);}}
      if(this.dead||controller.signal.aborted){bitmap.close?.();return;}
      this.cache.set(i,bitmap);this.evict();this.drawNearest();
    }catch(e){if(e.name!=='AbortError')this.failures.set(i,(this.failures.get(i)||0)+1);}
    finally{
      this.inflight.delete(i);
      if(!this.dead&&this.cache.size===0&&(this.failures.get(this.target)||0)>=2){this.destroy();useStill();return;}
      this.pump();
    }
  }
  evict(){
    const ordered=[...this.cache.keys()].sort((a,b)=>Math.abs(b-this.target)-Math.abs(a-this.target));
    while(this.cache.size>this.limit){const i=ordered.shift();this.cache.get(i)?.close?.();this.cache.delete(i);}
    this.canvas.dataset.cachedFrames=String(this.cache.size);
  }
  drawNearest(){
    if(!this.cache?.size||this.dead)return;
    const i=this.cache.has(this.target)?this.target:[...this.cache.keys()].reduce((a,b)=>Math.abs(a-this.target)<=Math.abs(b-this.target)?a:b);
    if(i===this.last)return;
    const bitmap=this.cache.get(i),w=this.canvas.width,h=this.canvas.height;
    const portrait=matchMedia('(max-width:700px),(max-aspect-ratio:10/11)').matches;
    const scale=portrait?Math.min(w/bitmap.width,h/bitmap.height):Math.max(w/bitmap.width,h/bitmap.height);const dw=bitmap.width*scale,dh=bitmap.height*scale;
    const x=(w-dw)*.5,y=(h-dh)*.5;
    this.ctx.imageSmoothingEnabled=true;this.ctx.imageSmoothingQuality='high';this.ctx.fillStyle='#171719';this.ctx.fillRect(0,0,w,h);this.ctx.drawImage(bitmap,x,y,dw,dh);
    this.canvas.style.opacity='1';this.canvas.dataset.renderedFrame=String(i);this.last=i;
  }
  abortAll(){for(const c of this.inflight.values())c.abort();}
  destroy(){
    this.dead=true;this.abortAll();cancelAnimationFrame(this.raf);this.observer.disconnect();removeEventListener('scroll',this.onScroll);document.removeEventListener('visibilitychange',this.onVisibility);for(const b of this.cache.values())b.close?.();this.cache.clear();this.canvas.style.opacity='0';document.documentElement.classList.remove('motion-ready');
  }
}
function useStill(){
  motionButton.setAttribute('aria-pressed','true');motionButton.textContent='Reduced motion';motionButton.disabled=!!(motionQuery.matches||constrained());
  document.documentElement.classList.add('static-mode');document.documentElement.classList.remove('motion-ready');
  const word=document.querySelector('.hero-wordmark');if(word){word.style.removeProperty('transform');word.style.removeProperty('opacity');}
  const opening=document.querySelector('[data-chapter="opening"]');opening.hidden=false;opening.inert=false;opening.style.opacity='1';opening.removeAttribute('aria-hidden');
  document.querySelector('[data-chapter="street"]').hidden=true;document.querySelector('#chapter-label').textContent='01 / THE ATELIER';document.querySelector('.skip-motion').textContent='Explore the edit ↗';
}
async function initMotion(url){
  sequenceUrl=url;
  if(motionQuery.matches||constrained()||userReduced){useStill();return;}
  try{const r=await fetch(url);if(!r.ok)throw Error('Sequence unavailable');const m=await r.json();
    if(!Number.isInteger(m.count)||m.count<2||!m.beats?.length||!m.pattern||!m.travelVH)throw Error('Invalid sequence');
    if(motionQuery.matches||constrained()||userReduced){useStill();return;}
    document.documentElement.classList.remove('static-mode');document.querySelector('.stage-poster').src=m.poster;
    motionButton.setAttribute('aria-pressed','false');motionButton.textContent='Reduce motion';motionButton.disabled=false;
    document.querySelector('.skip-motion').textContent='Skip film ↗';
    player=new FramePlayer(m);
  }catch{useStill();}
}
async function init(){
  let media={sequence:'assets/sequence.json'};
  try{const response=await fetch('content.json');if(response.ok){const c=await response.json();media=c.media||media;
    document.querySelectorAll('[data-copy]').forEach(el=>{const value=el.dataset.copy.split('.').reduce((o,k)=>o?.[k],c);if(typeof value==='string')el.textContent=value;});
    document.querySelectorAll('[data-media]').forEach(el=>{const src=media[el.dataset.media];if(src)el.src=src;});
    document.querySelectorAll('.logo-crop img').forEach(el=>{if(media.logo)el.src=media.logo;});
    for(const key of ['volume','layers'])if(media[key])document.querySelector('.'+key+'-photo').style.backgroundImage=`url("${encodeURI(media[key]).replace(/"/g,'%22')}")`;
    if(c.primaryAction?.href&&(/^(#|https?:\/\/)/.test(c.primaryAction.href))){const a=document.querySelector('.hero-copy .button');a.href=c.primaryAction.href;a.textContent=c.primaryAction.label||c.hero.cta;}
  }}catch{/* Authored HTML remains usable if editable content cannot load. */}
  initMotion(media.sequence||'assets/sequence.json');
}
motionQuery.addEventListener('change',()=>{player?.destroy();player=null;if(motionQuery.matches||userReduced||constrained())useStill();else initMotion(sequenceUrl);});
addEventListener('pagehide',()=>player?.destroy());
addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
init();
