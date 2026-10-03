/* The homepage brand film plays through (client change request, 2026-10-03): a fast scroll cannot skip it, the page does
   not move past the pinned hero before the film's playhead reaches that end, it reverses on the way up, and nobody is held
   for longer than the film takes. Desktop (wheel, large deltas, keyboard), phone (touch fling) and reduced motion.
   Against the Next.js app (npm run start:website → :3001, or WEB_URL). */
import {launch} from './cdp.mjs';
const B = process.env.WEB_URL || 'http://127.0.0.1:3001';
const b = await launch(9447);
const out = []; const ok = (name, pass, extra = '') => { const l = `${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`; out.push(l); console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = e => b.eval(e);
const until = async (x, ms = 10000) => { for (let t = 0; t < ms; t += 50) { if (await ev(x).catch(() => false)) return true; await sleep(50); } return false; };
/** Scroll position, the pinned range [a, b] and the playhead (0 → 1) the hero reports. */
const STATE = `(()=>{const r=document.querySelector('.st-brand-hero'),s=r.querySelector('.st-brand-stage'),top=Math.max(0,r.getBoundingClientRect().top+scrollY-(parseFloat(getComputedStyle(s).top)||0));
  return {y:Math.round(scrollY),a:Math.round(top),b:Math.round(top+r.offsetHeight-s.offsetHeight),film:r.dataset.film===undefined?null:Number(r.dataset.film),scrub:r.classList.contains('is-scrub'),
    hasFilm:r.classList.contains('has-film'),lock:document.documentElement.style.overflow,max:document.documentElement.scrollHeight-innerHeight}})()`;
const state = () => ev(STATE);
const wheel = (deltaY, x = 400, y = 400) => b.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x, y, deltaX: 0, deltaY});
const top = async () => { await ev('scrollTo({top:0,behavior:"instant"})'); await until(`(${STATE}).film === 0`, 5000); };
/** Samples the page every 60 ms while `during` runs, until the playhead reaches `end` (or 6 s). */
const watch = async (end, during = async () => {}) => {
  const samples = []; const t0 = Date.now();
  while (Date.now() - t0 < 6000) { const s = await state(); samples.push({...s, t: Date.now() - t0}); if (Math.abs(s.film - end) <= 0.002) break; await during(s); await sleep(60); }
  return samples;
};
const distinct = samples => new Set(samples.map(s => s.film)).size;
const monotonic = (samples, dir) => samples.every((s, i) => i === 0 || (s.film - samples[i - 1].film) * dir >= -0.0001);

try {
  // ------------------------------------------------------------ desktop: wheel and trackpad
  await b.viewport(1366, 768);
  await b.goto(B + '/', '!!document.querySelector(".st-brand-hero.is-scrub")');
  const s0 = await state();
  ok('[desktop] the hero is pinned for a scroll range and the playhead starts at the first frame', s0.scrub && s0.a === 0 && s0.b > 1000 && s0.film === 0 && s0.max > s0.b + 500, JSON.stringify(s0));
  ok('[desktop] the film frames arrive (coarse first; the poster shows until then)', await until(`(${STATE}).hasFilm`, 20000));

  // Slow scroll: small steps, the playhead follows the scroll position.
  for (let i = 0; i < 6; i++) { await wheel(100); await sleep(120); }
  await sleep(700);
  const slow = await state();
  ok('[desktop] slow scroll: the page scrolls inside the hero and the film follows it', slow.y === 600 && Math.abs(slow.film - 600 / slow.b) < 0.01, JSON.stringify(slow));

  // One very large delta (fast wheel / trackpad flick): stops at the end of the pinned range; the film plays through.
  await top();
  await wheel(20000);
  const big = await state();
  ok('[desktop] one huge wheel delta stops at the end of the hero instead of jumping past it', big.y === big.b && big.film < 0.5, JSON.stringify(big));
  let leaked = 0;
  const fwd = await watch(1, async s => { await wheel(600); const n = await state(); if (n.film < 0.998 && n.y > n.b + 1) leaked = n.y; });
  const took = fwd.at(-1).t;
  ok('[desktop] more fast wheeling at the end is absorbed until the last frame: the next section never comes in early', leaked === 0 && fwd.every(s => s.y <= s.b + 1 || s.film >= 0.998), `leaked=${leaked}`);
  ok('[desktop] the film plays through to its last frame (many steps in between, always forward), within a few seconds',
    fwd.at(-1).film >= 0.998 && distinct(fwd) >= 5 && monotonic(fwd, 1) && took > 800 && took < 6000, `${distinct(fwd)} steps in ${took} ms`);
  await sleep(150);
  await wheel(300); await sleep(500);
  const after = await state();
  ok('[desktop] after the last frame the page scrolls on normally', after.y > after.b + 100, JSON.stringify(after));

  // Reverse: a huge upward delta from below stops at the hero's end, the next one runs the film backward to the first frame.
  await ev(`scrollTo({top:${after.b + 900},behavior:'instant'})`); await sleep(400);
  await wheel(-20000); await sleep(150);
  const enter = await state();
  ok('[desktop] scrolling up fast from below stops where the hero begins (its last frame)', enter.y === enter.b, JSON.stringify(enter));
  await sleep(400);
  await wheel(-20000);
  const back = await watch(0, async () => { await wheel(-600); });
  ok('[desktop] reverse: the film runs backward through its frames to the first one', back.at(-1).film <= 0.002 && back.at(-1).y === 0 && distinct(back) >= 5 && monotonic(back, -1) && back.at(-1).t > 800,
    `${distinct(back)} steps in ${back.at(-1).t} ms`);
  await wheel(100); await sleep(400);
  ok('[desktop] and then scrolls forward again from the start', (await state()).y === 100);

  // Trackpad: a burst of small deltas (a long flick) cannot run past the end either.
  await top();
  let over = 0;
  for (let i = 0; i < 60; i++) { await wheel(90); const n = await state(); if (n.film < 0.998 && n.y > n.b + 1) over = n.y; }
  ok('[desktop] a long trackpad flick (many small deltas) does not pass the end before the last frame', over === 0, `over=${over}`);
  await until(`(${STATE}).film >= 0.998`, 6000);

  // Keyboard: Page Down cannot run past the hero before the film has played; End / Home are deliberate jumps and are left alone.
  await top();
  await ev('document.body.focus()');
  let keyLeak = 0;
  for (let i = 0; i < 8; i++) { await b.key('PageDown', 'PageDown', 34); await sleep(110); const n = await state(); if (n.film < 0.998 && n.y > n.b + 1) keyLeak = n.y - n.b; }
  const key1 = await state();
  ok('[desktop] keyboard Page Down, pressed fast, is held at the end of the hero while the film plays', keyLeak === 0 && key1.y <= key1.b + 1, `leak ${keyLeak} ${JSON.stringify(key1)}`);
  ok('[desktop] … and the film then reaches its last frame', await until(`(${STATE}).film >= 0.998`, 6000));
  await top();
  await b.key('End', 'End', 35);
  ok('[desktop] End goes to the bottom of the page (a deliberate jump is not held)', await until(`(${STATE}).y >= (${STATE}).max - 2`, 5000), JSON.stringify(await state()));

  // A page opened (or restored) below the hero is left alone; in-page jumps are not pulled back.
  await ev(`scrollTo({top:${key1.b + 1500},behavior:'instant'})`); await sleep(500);
  ok('[desktop] a programmatic jump below the hero (anchor, restored position) is not pulled back', (await state()).y === key1.b + 1500);

  // ------------------------------------------------------------ desktop: the pinned reels (new arrivals, categories) play through too
  for (const sel of ['.ch-na-reel', '.ch-cat-reel', '.ch-ow-reel']) {
    const R = `(()=>{const r=document.querySelector('${sel}');if(!r)return null;const s=r.firstElementChild,cs=getComputedStyle(s),top=Math.max(0,r.getBoundingClientRect().top+scrollY-(parseFloat(cs.top)||0));
      return {y:Math.round(scrollY),a:Math.round(top),b:Math.round(top+r.offsetHeight-s.offsetHeight),n:Number(r.dataset.steps),t:Number(r.style.getPropertyValue('--t')||0),step:Number(r.dataset.step||0),sticky:cs.position==='sticky',
        stageTop:Math.round(s.getBoundingClientRect().top),head:parseFloat(cs.top)||0}})()`;
    const r0 = await ev(R);
    if (!r0 || !(r0.n > 1)) { ok(`[desktop] ${sel}: present with more than one picture`, false, JSON.stringify(r0)); continue; }
    await ev(`scrollTo({top:${r0.a - 300},behavior:'instant'})`); await sleep(900);
    await wheel(30000);
    const hit = await ev(R);
    ok(`[desktop] ${sel}: one huge wheel delta stops at the end of the reel, still pinned, on an early picture`, hit.sticky && hit.y === hit.b && hit.stageTop === hit.head && hit.t < Math.min(1.5, hit.n - 1.4), JSON.stringify(hit));
    const seenSteps = new Set(); let leak = 0; const t0 = Date.now(); let cur = hit;
    while (Date.now() - t0 < 12000) {
      cur = await ev(R); seenSteps.add(cur.step);
      if (cur.t < cur.n - 1 - 0.01 && cur.y > cur.b + 1) leak = cur.y - cur.b;
      if (cur.t >= cur.n - 1 - 0.01) break;
      await wheel(500); await sleep(50);
    }
    const dur = Date.now() - t0;
    ok(`[desktop] ${sel}: every picture is shown in turn before the page moves on (${r0.n} pictures)`, leak === 0 && cur.t >= cur.n - 1 - 0.01 && seenSteps.size === r0.n && dur > (r0.n - 1) * 400,
      `steps seen ${[...seenSteps].join()}, ${dur} ms, leak ${leak}`);
    await sleep(200); await wheel(400); await sleep(500);
    ok(`[desktop] ${sel}: then the page scrolls on`, (await ev(R)).y > hit.b + 100);
    await wheel(-30000); await sleep(150);
    const up1 = await ev(R);
    await sleep(300); await wheel(-30000);
    const back = new Set(); const t1 = Date.now(); let leakUp = 0;
    while (Date.now() - t1 < 12000) { cur = await ev(R); back.add(cur.step); if (cur.t > 0.01 && cur.y < cur.a - 1) leakUp = cur.a - cur.y; if (cur.t <= 0.01) break; await wheel(-500); await sleep(50); }
    ok(`[desktop] ${sel}: scrolling up stops at the reel's end, then runs the pictures back to the first before leaving`, up1.y === up1.b && leakUp === 0 && cur.t <= 0.01 && cur.y <= cur.a && back.has(0) && back.size >= r0.n - 1, `steps seen ${[...back].join()}, leak ${leakUp}`);
  }
  ok('[desktop] no browser errors', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));

  // ------------------------------------------------------------ phone: touch
  await b.viewport(390, 844, true);
  await b.goto(B + '/', '!!document.querySelector(".st-brand-hero.is-scrub")');
  const m0 = await state();
  ok('[mobile] the hero is pinned on a phone too', m0.scrub && m0.b > 800 && m0.film === 0, JSON.stringify(m0));
  await until(`(${STATE}).hasFilm`, 20000);
  // Real touch events (finger down, moves, up): the browser turns them into scrolling, as on a phone.
  const swipe = async (from, to, steps = 10, gap = 16) => {
    await b.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 195, y: from}]});
    for (let i = 1; i <= steps; i++) { await b.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 195, y: from + (to - from) * i / steps}]}); await sleep(gap); }
    await b.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  };
  // A slow drag inside the hero scrolls normally.
  await swipe(700, 400, 20, 30);
  await sleep(900);
  const drag = await state();
  ok('[mobile] a slow drag scrolls inside the hero and the film follows', drag.y > 200 && drag.y < drag.b && Math.abs(drag.film - drag.y / drag.b) < 0.02, JSON.stringify(drag));
  // Fast swipes, one after another, far past the hero: brought back to its end, held there until the last frame, then released.
  await ev('scrollTo({top:0,behavior:"instant"})'); await until(`(${STATE}).film === 0`, 5000);
  let worst = 0, sawLock = false;
  const mf = [];
  for (let n = 0; n < 6; n++) {
    await swipe(800, 60, 4, 8);
    const s1 = await state(); mf.push(s1);
    if (s1.lock === 'hidden') sawLock = true;
    if (s1.film < 0.998 && s1.y > s1.b + 1) worst = Math.max(worst, s1.y - s1.b);
    if (s1.film >= 0.998) break;
    await sleep(120);
  }
  const held = await state();
  mf.push(...await watch(1, async s1 => { if (s1.lock === 'hidden') sawLock = true; if (s1.film < 0.998 && s1.y > s1.b + 1) worst = Math.max(worst, s1.y - s1.b); }));
  ok('[mobile] fast swipes past the hero are held at its end until the film has played', mf.at(-1).film >= 0.998 && mf.at(-1).y <= mf.at(-1).b + 1 && worst === 0 && distinct(mf) >= 5 && monotonic(mf, 1),
    `${distinct(mf)} steps, overshoot seen ${worst}px, held=${sawLock}, at ${JSON.stringify(held)}`);
  await sleep(400);
  ok('[mobile] the page is released afterwards (nothing left locked)', (await state()).lock === '');
  await swipe(700, 200, 10, 20);
  await sleep(700);
  const mAfter = await state();
  ok('[mobile] the next swipe scrolls on to the following section', mAfter.y > mAfter.b + 200, JSON.stringify(mAfter));
  // Back up: swipes downward (scrolling up) from below go back through the hero, and the film runs backward.
  const mb = [];
  for (let n = 0; n < 8; n++) { await swipe(100, 820, 4, 8); await sleep(150); mb.push(await state()); if (mb.at(-1).y === 0) break; }
  mb.push(...await watch(0));
  ok('[mobile] swiping back up runs the film backward to the first frame at the top of the page', mb.at(-1).film <= 0.002 && mb.at(-1).y === 0 && monotonic(mb, -1) && (await state()).lock === '', JSON.stringify(mb.at(-1)));
  const reelPinned = await ev(`[...document.querySelectorAll('.ch-na-reel, .ch-cat-reel')].map(r => getComputedStyle(r.firstElementChild).position).join()`);
  await ev('scrollTo({top:0,behavior:"instant"})'); await sleep(2600);
  await ev(`scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})`); await sleep(2800);
  for (let i = 0; i < 12; i++) { await swipe(100, 820, 4, 8); await sleep(120); }
  const mUp = await state();
  ok('[mobile] below the hero the page scrolls freely on a phone (reels: ' + reelPinned + ')', mUp.y < mUp.max - 3000 && mUp.lock === '', JSON.stringify(mUp));
  ok('[mobile] no browser errors', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));

  // ------------------------------------------------------------ reduced motion: no pinned film, nothing intercepted
  await b.viewport(1366, 768);
  await b.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await b.goto(B + '/', '!!document.querySelector(".st-brand-hero")');
  const r0 = await state();
  await wheel(3000); await sleep(600);
  const r1 = await state();
  ok('[reduced motion] the poster is shown, the hero is not pinned and a wheel scrolls straight past it', !r0.scrub && r0.film === null && r1.y >= 2900 && !!(await ev(`document.querySelector('.st-brand-hero-img').naturalWidth > 0`)), JSON.stringify({r0, r1}));
  await b.send('Emulation.setEmulatedMedia', {features: []});
} catch (e) {
  ok('hero tests ran to the end', false, e.message);
} finally {
  b.close();
  const failed = out.filter(l => l.startsWith('FAIL')).length;
  console.log(`\n${out.length - failed}/${out.length} passed`);
  process.exit(failed ? 1 : 0);
}
