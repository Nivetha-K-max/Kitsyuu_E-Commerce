/* Storefront performance measurement (local only; no writes to any live system).
   Cold page loads (browser cache off) in headless Chrome over CDP, two profiles:
     desktop  1440×900, no throttling
     mobile   390×844 touch, Slow 4G (150 ms RTT, 1.6 Mbps down / 750 kbps up) and a 4× slower CPU
   Per page: FCP, LCP, CLS, TBT (long-task time over 50 ms after FCP), long tasks, an interaction's latency (Event Timing,
   the INP building block), requests and transferred bytes by type, fonts, script / layout / style time, and scroll
   smoothness (frames and dropped frames while scrolling). A long-session check scrolls the homepage for a while and
   compares the JS heap (after GC) and the number of live timers / observers before and after.
   Headless Chrome renders without a GPU, so frame rates are lower than on a phone; compare runs with each other, not with
   real-device numbers. Usage: BASE=http://localhost:3021 node apps/website/tests/perf.mjs [label]  → tests/.output/perf-<label>.json */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:3001';
const LABEL = process.argv[2] || 'run';
const RUNS = Number(process.env.RUNS || 2);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.output');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Evaluates in the page, giving up after a while (a page that never settles must not stall the whole run). */
const ev = (b, expr, ms = 30000) => { let t; return Promise.race([b.eval(expr), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('evaluation timed out')), ms); })]).finally(() => clearTimeout(t)); };

const PROFILES = {
  desktop: {width: 1440, height: 900, mobile: false, cpu: 1, net: null},
  mobile: {width: 390, height: 844, mobile: true, cpu: 4, net: {offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8}},
};

// Installed before any page script runs: collects paint / layout-shift / long-task / event-timing entries and counts the
// timers, animation frames and observers the page creates (to spot loops that never stop).
const OBSERVE = `(() => {
  const P = window.__perf = {lcp: 0, cls: 0, longTasks: [], events: [], fcp: 0};
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.lcp = e.renderTime || e.loadTime || e.startTime; }).observe({type: 'largest-contentful-paint', buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) P.cls += e.value; }).observe({type: 'layout-shift', buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.longTasks.push([e.startTime, e.duration]); }).observe({type: 'longtask', buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = e.startTime; }).observe({type: 'paint', buffered: true}); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) P.events.push([e.name, e.duration]); }).observe({type: 'event', durationThreshold: 16, buffered: true}); } catch {}
  const live = P.live = {intervals: 0, timeouts: 0, raf: 0, io: 0, ro: 0, mo: 0};
  const si = setInterval, ci = clearInterval, ids = new Set();
  window.setInterval = function (...a) { const id = si.apply(this, a); ids.add(id); live.intervals = ids.size; return id; };
  window.clearInterval = function (id) { ids.delete(id); live.intervals = ids.size; return ci.call(this, id); };
  const raf = requestAnimationFrame; let rafN = 0;
  window.requestAnimationFrame = function (cb) { rafN++; return raf.call(this, t => { live.raf = rafN; cb(t); }); };
  P.rafCalls = () => rafN;
  for (const [k, C] of [['io', 'IntersectionObserver'], ['ro', 'ResizeObserver'], ['mo', 'MutationObserver']]) {
    const Orig = window[C]; if (!Orig) continue;
    window[C] = class extends Orig { constructor(...a) { super(...a); live[k]++; } disconnect() { live[k]--; return super.disconnect(); } };
  }
})();`;

// One network listener for the whole run (cdp.mjs listeners cannot be removed); measure() starts each page from empty.
// Bytes are counted as they arrive (dataReceived), so a download still running when the page is measured counts what it
// has transferred so far; a finished one counts its total.
const net = {reqs: new Map(), loaded: false};
function listenNetwork(b) {
  b.on(m => {
    if (m.method === 'Network.responseReceived') { const r = net.reqs.get(m.params.requestId) ?? {bytes: 0}; net.reqs.set(m.params.requestId, {...r, type: m.params.type, url: m.params.response.url}); }
    if (m.method === 'Network.dataReceived') { const r = net.reqs.get(m.params.requestId); if (r) r.bytes += m.params.encodedDataLength; }
    if (m.method === 'Network.loadingFinished') { const r = net.reqs.get(m.params.requestId); if (r) r.bytes = Math.max(r.bytes, m.params.encodedDataLength); }
    if (m.method === 'Page.loadEventFired') net.loaded = true;
  });
}
/** Navigates without forcing lazy images to load (unlike cdp.mjs goto); waits for the load event up to a cap. */
async function navigate(b, url, capMs) {
  net.reqs.clear(); net.loaded = false;
  const t0 = Date.now();
  await b.send('Page.navigate', {url});
  while (!net.loaded && Date.now() - t0 < capMs) await sleep(50);
  return net.loaded ? Date.now() - t0 : null;
}
async function measure(b, url, profile, interact) {
  const cap = profile.cpu > 1 ? 45000 : 20000;
  const loadMs = await navigate(b, url, cap);   // null: no load event within the cap
  await sleep(profile.cpu > 1 ? 4000 : 2000);   // let late work (hydration, effects, lazy chunks) finish
  const reqList = [...net.reqs.values()].filter(r => r.type);   // what the page transferred before any scrolling
  const vitals = await ev(b, `(() => { const P = window.__perf, nav = performance.getEntriesByType('navigation')[0];
    const tbt = P.longTasks.filter(([s]) => s >= P.fcp).reduce((n, [, d]) => n + Math.max(0, d - 50), 0);
    return {fcp: Math.round(P.fcp), lcp: Math.round(P.lcp), cls: +P.cls.toFixed(4), tbt: Math.round(tbt), longTasks: P.longTasks.length,
      longest: Math.round(Math.max(0, ...P.longTasks.map(([, d]) => d))), ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd), domNodes: document.getElementsByTagName('*').length, images: document.images.length,
      fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight + ' ' + f.style)}; })()`);
  const {metrics} = await b.send('Performance.getMetrics');
  const M = Object.fromEntries(metrics.map(m => [m.name, m.value]));
  // Interaction latency (Event Timing): a click / tap on something on the page that does not leave it.
  let interaction = null;
  if (interact) {
    const box = await ev(b, `(() => { const el = document.querySelector(${JSON.stringify(interact)}); if (!el) return null; el.scrollIntoView({block: 'center'});
      const r = el.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`).catch(() => null);
    if (box) {
      await sleep(300);
      for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', {type, x: box.x, y: box.y, button: 'left', clickCount: 1});
      await sleep(1200);
      interaction = await ev(b, `Math.round(Math.max(0, ...window.__perf.events.map(e => e[1])))`);
    }
  }
  // Scroll smoothness: scroll the page for ~3 s with requestAnimationFrame; count frames and frames over 50 ms.
  const scroll = await ev(b, `new Promise(res => { window.scrollTo(0, 0); const start = performance.now(), frames = []; let last = start;
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const step = t => { frames.push(t - last); last = t; const p = (t - start) / 3000; window.scrollTo(0, Math.min(1, p) * max);
      if (p < 1) requestAnimationFrame(step); else res({fps: Math.round(frames.length / ((t - start) / 1000)), slowFrames: frames.filter(f => f > 50).length, frames: frames.length}); };
    requestAnimationFrame(step); })`);
  const live = await ev(b, 'window.__perf.live');
  const by = t => reqList.filter(r => t(r));
  const sum = list => list.reduce((n, r) => n + r.bytes, 0);
  const kb = n => Math.round(n / 102.4) / 10;
  return {
    url: url.replace(BASE, ''), loadMs, ...vitals, interaction, scroll, live,
    scriptMs: Math.round(M.ScriptDuration * 1000), layoutMs: Math.round(M.LayoutDuration * 1000), styleMs: Math.round(M.RecalcStyleDuration * 1000),
    heapMB: +(M.JSHeapUsedSize / 1048576).toFixed(1),
    requests: reqList.length, totalKB: kb(sum(reqList)),
    jsKB: kb(sum(by(r => r.type === 'Script'))), jsFiles: by(r => r.type === 'Script').length,
    cssKB: kb(sum(by(r => r.type === 'Stylesheet'))), imgKB: kb(sum(by(r => r.type === 'Image'))), imgFiles: by(r => r.type === 'Image').length,
    fontKB: kb(sum(by(r => r.type === 'Font'))), fontFiles: by(r => r.type === 'Font').length,
    otherKB: kb(sum(by(r => !['Script', 'Stylesheet', 'Image', 'Font'].includes(r.type)))),
    biggest: reqList.sort((a, b) => b.bytes - a.bytes).slice(0, 6).map(r => `${kb(r.bytes)}KB ${r.type} ${r.url.replace(BASE, '').slice(0, 90)}`),
  };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const b = await launch(9410);
const results = {base: BASE, label: LABEL, when: new Date().toISOString(), runs: RUNS, pages: {}, longSession: null};
try {
  await b.send('Performance.enable');
  listenNetwork(b);
  await b.send('Page.addScriptToEvaluateOnNewDocument', {source: OBSERVE});
  // Find real targets from the homepage: a product page and a collection / category page.
  await b.viewport(1440, 900);
  await navigate(b, BASE + '/', 20000);
  const targets = await ev(b, `(() => { const hrefs = [...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href'));
    return {product: hrefs.find(h => /^\\/products?\\/[^/?#]+$/.test(h)) || null, collection: hrefs.find(h => /^\\/(collections?|category|categories|shop)(\\/|$|\\?)/.test(h)) || null}; })()`);
  const pages = [
    // Interactions that stay on the page (no navigation): a wishlist heart (this browser only), a size, the sort, the
    // search box, a cart button, a form field.
    ['home', '/', 'main .st-wish'],
    ['product', targets.product, 'main .st-sizes button, main [data-size], main .st-wish-btn'],
    ['collection', targets.collection, 'main #st-sort, main .st-wish'],
    ['search', '/search?q=shirt', 'main input[name=q]'],
    ['cart', '/cart', 'main button'],
    ['checkout', '/checkout', 'main input'],
  ].filter(p => p[1]);
  for (const [pname, prof] of Object.entries(PROFILES)) {
    await b.viewport(prof.width, prof.height, prof.mobile);
    await b.send('Emulation.setCPUThrottlingRate', {rate: prof.cpu});
    await b.send('Network.emulateNetworkConditions', prof.net ?? {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    for (const [name, url, interact] of pages) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) { try { runs.push(await measure(b, BASE + url, prof, interact)); } catch (e) { console.log(`${pname} ${name}: run failed (${e.message})`); } }
      if (!runs.length) continue;
      const pick = k => median(runs.map(r => r[k] ?? 0));
      const r = {...runs[0], loadMs: runs.some(x => x.loadMs === null) ? null : median(runs.map(x => x.loadMs)), ...Object.fromEntries(['fcp', 'lcp', 'cls', 'tbt', 'longTasks', 'longest', 'interaction', 'scriptMs', 'layoutMs', 'styleMs', 'totalKB', 'jsKB', 'imgKB', 'requests'].map(k => [k, pick(k)])),
        scroll: {fps: median(runs.map(x => x.scroll.fps)), slowFrames: median(runs.map(x => x.scroll.slowFrames))}};
      (results.pages[name] ??= {})[pname] = r;
      console.log(`${pname.padEnd(7)} ${name.padEnd(10)} load ${r.loadMs ?? '>' + (prof.cpu > 1 ? 45 : 20) + 's'} FCP ${r.fcp}ms LCP ${r.lcp}ms CLS ${r.cls} TBT ${r.tbt}ms INP~${r.interaction ?? '-'}ms | ${r.requests} req ${r.totalKB}KB (JS ${r.jsKB}KB/${r.jsFiles} CSS ${r.cssKB}KB img ${r.imgKB}KB/${r.imgFiles} font ${r.fontKB}KB/${r.fontFiles}) | script ${r.scriptMs}ms | scroll ${r.scroll.fps}fps slow ${r.scroll.slowFrames} | live ${JSON.stringify(r.live)}`);
    }
  }
  // Long session (mobile CPU): homepage for ~60 s of scrolling up and down; heap after GC and live loops before / after.
  await b.viewport(390, 844, true);
  await b.send('Emulation.setCPUThrottlingRate', {rate: 4});
  await b.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
  await navigate(b, BASE + '/', 45000);
  await sleep(3000);
  const snap = async () => { await b.send('HeapProfiler.collectGarbage'); const {metrics} = await b.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
    return {heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, live: await ev(b, 'window.__perf.live'), raf: await ev(b, 'window.__perf.rafCalls()')}; };
  await b.send('HeapProfiler.enable');
  const before = await snap(); const t = Date.now();
  while (Date.now() - t < 60000) await ev(b, `new Promise(r => { const max = document.documentElement.scrollHeight - innerHeight; let y = 0, d = 1;
    const s = () => { y += d * 60; if (y >= max) d = -1; window.scrollTo(0, y); if (y > 0) requestAnimationFrame(s); else r(); }; requestAnimationFrame(s); })`);
  const afterScroll = await snap();
  await sleep(10000);   // idle: how many animation frames does an idle page still request?
  const idle = await snap();
  results.longSession = {before, afterScroll, idle, idleRafPerSec: Math.round((idle.raf - afterScroll.raf) / 10)};
  console.log('long session', JSON.stringify(results.longSession));
  console.log('page errors:', b.errors.filter(e => !/favicon/.test(e)).slice(0, 5).join(' | ') || 'none');
} finally {
  b.close();
  fs.writeFileSync(path.join(OUT, `perf-${LABEL}.json`), JSON.stringify(results, null, 2));
}
