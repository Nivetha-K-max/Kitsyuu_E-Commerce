/* Store hero turntable: the integration point for a future real 360° sequence of KTS-OUT-001 (Hook Closure Cropped Jacket).
   Ported unchanged from dist/store/store.js. Dormant until the hero's data-turntable names a manifest (path relative to
   the site root). While it is empty, nothing is requested and hero.webp shows as before.
   Manifest: the same shape as assets/sequence.json (count, width, height, padding, pattern, poster, fps), plus
     loop: true         play continuously (false stops on the last frame)
     stillFrame: n      the approved frame shown for reduced motion, and first while the loop loads
   Frames must be a real turntable capture: FRONT → FRONT 3/4 → SIDE → BACK → SIDE → FRONT 3/4 → FRONT.
   Any failure keeps hero.webp. */
type Manifest = { count: number; pattern: string; fps: number; padding?: number; poster?: string; loop?: boolean; stillFrame?: number };
type Job = Promise<ImageBitmap> & { bm?: ImageBitmap };
const asset = (p: string) => new URL(p, location.origin + '/').href;

class TurntablePlayer {
  hero: HTMLElement; m: Manifest; poster: HTMLImageElement; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  blobs: (Promise<Blob> | undefined)[]; cache = new Map<number, Job>(); ahead = 12; shown = -1; raf = 0; run = 0;
  ready = false; visible = true; dead = false; still: number; start = 0;
  motion = matchMedia('(prefers-reduced-motion: reduce)');
  io: IntersectionObserver; ro: ResizeObserver;
  onMotion = () => { void this.mode(); };
  onVisibility = () => this.play();

  constructor(hero: HTMLElement, m: Manifest) {
    this.hero = hero; this.m = m;
    this.poster = hero.querySelector('.st-hero-img')!; this.canvas = hero.querySelector('.st-hero-sequence')!;
    const ctx = this.canvas.getContext('2d', { alpha: false }); if (!ctx) throw Error('Canvas unavailable'); this.ctx = ctx;
    this.blobs = new Array(m.count);
    this.still = Math.min(m.count - 1, Math.max(0, m.stillFrame! | 0));
    this.motion.addEventListener('change', this.onMotion);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.play(); }); this.io.observe(hero);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.poster);
    if (m.poster) this.poster.src = asset(m.poster);
    this.canvas.hidden = false; this.resize(); void this.mode();
  }
  get reduced() { return this.motion.matches || document.documentElement.classList.contains('st-reduce'); }
  url(i: number) { return asset(this.m.pattern.replace('{index}', String(i).padStart(this.m.padding || 4, '0'))); }
  blob(i: number) { return this.blobs[i] ??= fetch(this.url(i)).then(r => { if (!r.ok) throw Error(`Frame ${i}: HTTP ${r.status}`); return r.blob(); }); }
  bitmap(i: number): Job {
    let job = this.cache.get(i);
    if (!job) { const j = this.blob(i).then(b => createImageBitmap(b)).then(bm => (j.bm = bm)) as Job; job = j; j.catch(() => this.cache.delete(i)); this.cache.set(i, j); }
    return job;
  }
  evict(at: number) {
    for (const [i, job] of this.cache) { const d = (i - at + this.m.count) % this.m.count; if (d >= this.ahead && i !== this.still && i !== this.shown) { this.cache.delete(i); job.then(bm => bm.close(), () => {}); } }
  }
  async mode() {
    const run = ++this.run; cancelAnimationFrame(this.raf); this.raf = 0; this.ready = false;
    try {
      this.draw(await this.bitmap(this.still), this.still); this.hero.classList.add('is-turntable');
      if (this.reduced) return;
      let next = 0; const worker = async () => { while (next < this.m.count && run === this.run) await this.blob(next++); };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (run !== this.run || this.reduced) return;
      this.ready = true; this.start = performance.now() - this.still / this.m.fps * 1000; this.play();
    } catch (e) { if (run === this.run) { console.warn('Turntable unavailable; keeping the hero image.', e); this.destroy(); } }
  }
  play() {
    if (this.dead || !this.ready || this.reduced || this.raf || document.hidden || !this.visible) return;
    const step = (now: number) => {
      this.raf = 0; if (this.dead || !this.ready || this.reduced || document.hidden || !this.visible) return;
      const n = Math.floor((now - this.start) / 1000 * this.m.fps), i = this.m.loop === false ? Math.min(n, this.m.count - 1) : n % this.m.count;
      for (let d = 0; d < this.ahead; d++) void this.bitmap((i + d) % this.m.count);
      const job = this.cache.get(i); if (job?.bm && i !== this.shown) this.draw(job.bm, i);
      this.evict(i); this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  resize() {
    const p = this.poster, c = this.canvas;
    Object.assign(c.style, { left: p.offsetLeft + 'px', top: p.offsetTop + 'px', width: p.offsetWidth + 'px', height: p.offsetHeight + 'px' });
    const scale = Math.min(devicePixelRatio || 1, 2, 3840 / Math.max(p.offsetWidth, p.offsetHeight, 1));
    c.width = Math.max(1, Math.round(p.offsetWidth * scale)); c.height = Math.max(1, Math.round(p.offsetHeight * scale));
    const job = this.cache.get(this.shown); if (job?.bm) this.draw(job.bm, this.shown);
  }
  /* Same framing as the poster: object-fit cover at the poster's object-position. */
  draw(bm: ImageBitmap, i: number) {
    const c = this.canvas, [px, py] = getComputedStyle(this.poster).objectPosition.split(' ').map(v => parseFloat(v) / 100);
    const k = Math.max(c.width / bm.width, c.height / bm.height), w = bm.width * k, h = bm.height * k;
    this.ctx.imageSmoothingQuality = 'high'; this.ctx.drawImage(bm, (c.width - w) * (px || .5), (c.height - h) * (py || .5), w, h); this.shown = i;
  }
  destroy() {
    this.dead = true; this.run++; cancelAnimationFrame(this.raf); this.io.disconnect(); this.ro.disconnect();
    this.motion.removeEventListener('change', this.onMotion); document.removeEventListener('visibilitychange', this.onVisibility);
    this.hero.classList.remove('is-turntable'); this.canvas.hidden = true;
    for (const job of this.cache.values()) job.then(bm => bm.close(), () => {}); this.cache.clear();
  }
}

export function initTurntable(): (() => void) | undefined {
  const hero = document.querySelector<HTMLElement>('.st-hero[data-turntable]'), src = hero?.dataset.turntable?.trim();
  if (!hero || !src || !('createImageBitmap' in window)) return;
  let player: TurntablePlayer | undefined, cancelled = false;
  fetch(asset(src)).then(r => { if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); }).then((m: Manifest) => {
    if (!(m.count > 0 && m.pattern && m.fps > 0)) throw Error('Invalid turntable manifest');
    if (!cancelled) player = new TurntablePlayer(hero, m);
  }).catch(e => console.warn('Turntable unavailable; keeping the hero image.', e));
  return () => { cancelled = true; player?.destroy(); };
}
