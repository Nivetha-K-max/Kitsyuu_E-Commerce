'use client';
/* The top of the homepage: the KITSYUU brand film under the one store header. The section is taller than the screen and
   its stage stays pinned while it scrolls past: scrolling down plays the film forward (the sphere unravels into the
   collection), scrolling up plays it backward. The frames are drawn on a canvas and loaded coarse-to-fine, so the film is
   usable after a few frames and sharpens as the rest arrive. Without JavaScript, with reduced motion, or before the first
   frame is ready, the poster frame is shown instead. The full story film lives on /our-story.

   Performance (2026-10-01), same film and behaviour:
   - web-sized frames (assets/film-v1, scripts/encode-film.mjs): 1600×900 on desktop; on a portrait phone the centre crop
     the phone shows anyway (720×960). About a tenth of the original bytes.
   - the poster (the first screen's largest picture) is a responsive AVIF / WebP: a portrait crop on phones.
   - nothing is downloaded until the first screen has rendered; the coarse frames (every 16th, then 8th) come next; the
     fine frames only once the visitor starts scrolling the film. Downloads pause while the tab is hidden.
   - frames are kept compressed; only the frames around the current position are decoded (off the main thread) and kept
     as bitmaps, so memory stays small however long the visit.
   - the canvas is drawn only while the hero is on screen (no work while reading further down the page). */
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { url } from '@/lib/catalogue-utils';
import { reducedMotion } from '@/lib/motion';

type FrameSet = { width: number; height: number; pattern: string; maxAspect?: number };
interface Film { count: number; padding: number; desktop: FrameSet; portrait: FrameSet }

/** Load order levels: every 16th frame, then 8th, 4th, 2nd and finally every frame. */
function level(count: number, steps: number[], seen: Set<number>): number[] {
  const order: number[] = [];
  for (const step of steps) for (let i = 0; i < count; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
  return order;
}

/** Brand wording (client change request): editable under Store content; the defaults are the original text. */
export type HeroCopy = { heroTop: string; heroEyebrow: string; heroLead: string };
const arrow = (t: string) => t.split('→').map((part, i) => <span key={i}>{i > 0 && <b aria-hidden="true">→</b>}{part}</span>);

const P = '/assets/film-v1/';
const KEEP = 18;                       // decoded frames kept around the current one

export default function BrandHero({ copy = { heroTop: '', heroEyebrow: '', heroLead: 'Japanese streetwear. Unconventional shapes. Made personal.' } }: { copy?: HeroCopy }) {
  const section = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), word = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const root = section.current!, cv = canvas.current!, ctx = cv.getContext('2d');
    if (!ctx || reducedMotion() || !('createImageBitmap' in window)) return;
    let stopped = false, raf = 0, set: FrameSet | null = null, count = 0, drawn = -1, onScreen = true, scrolled = false;
    const blobs: (Blob | undefined)[] = [];                       // compressed frames (small)
    const bitmaps = new Map<number, ImageBitmap>();               // decoded frames near the current position
    const decoding = new Set<number>();
    const waiters = new Set<() => void>();                         // loaders waiting (tab hidden, or fine frames not yet wanted)
    const wake = () => { const w = [...waiters]; waiters.clear(); w.forEach(f => f()); };
    root.classList.add('is-scrub');

    const progress = () => {
      const r = root.getBoundingClientRect(), stage = root.firstElementChild!.getBoundingClientRect().height;
      return Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - stage)));
    };
    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5), w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); drawn = -1; }
    };
    const nearest = (target: number, has: (i: number) => boolean) => {
      for (let d = 0; d < count; d++) { if (has(target - d)) return target - d; if (has(target + d)) return target + d; }
      return -1;
    };
    const decode = (i: number) => {
      const b = blobs[i];
      if (!b || bitmaps.has(i) || decoding.has(i)) return;
      decoding.add(i);
      createImageBitmap(b).then(bmp => {
        decoding.delete(i);
        if (stopped) { bmp.close(); return; }
        bitmaps.set(i, bmp);
        // Keep only the frames nearest to the one on screen.
        if (bitmaps.size > KEEP) {
          const far = [...bitmaps.keys()].sort((a, c) => Math.abs(c - target) - Math.abs(a - target)).slice(0, bitmaps.size - KEEP);
          for (const k of far) { if (k === drawn) continue; bitmaps.get(k)!.close(); bitmaps.delete(k); }
        }
        request();
      }, () => decoding.delete(i));
    };
    let target = 0;
    const draw = () => {
      raf = 0;
      const p = progress();
      if (p > 0 && !scrolled) { scrolled = true; wake(); }   // the visitor is scrubbing: fetch the fine frames too
      if (word.current) {
        const fade = Math.min(1, p / 0.3);
        word.current.style.opacity = String(1 - fade);
        word.current.style.transform = `translate(-50%, calc(-50% - ${fade * 60}px)) scale(${1 - fade * 0.08})`;
      }
      root.style.setProperty('--st-film', p.toFixed(3));
      if (!set || !count) return;
      // A short hold on the sphere at the start and on the collection at the end.
      const t = Math.min(1, Math.max(0, (p - 0.06) / 0.84));
      target = Math.round(t * (count - 1));
      const want = nearest(target, i => !!blobs[i]);          // the nearest frame that has arrived
      if (want < 0) return;
      // Decode it and its neighbours (both directions) in the background.
      for (let d = 0; d <= 3; d++) { decode(nearest(want + d, i => !!blobs[i])); decode(nearest(want - d, i => !!blobs[i])); }
      const i = bitmaps.has(want) ? want : nearest(want, k => bitmaps.has(k));
      if (i < 0 || i === drawn) return;
      size();
      const bmp = bitmaps.get(i)!, cw = cv.width, ch = cv.height, s = Math.max(cw / set.width, ch / set.height);
      const dw = set.width * s, dh = set.height * s;
      ctx.drawImage(bmp, (cw - dw) * 0.5, (ch - dh) * 0.45, dw, dh);
      drawn = i;
      root.classList.add('has-film');
    };
    const request = () => { if (!raf && onScreen) raf = requestAnimationFrame(draw); };
    const resize = () => { drawn = -1; request(); };
    const seen = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; request(); });
    seen.observe(root);

    const allowed = (fine: boolean) => !document.hidden && (!fine || scrolled);
    const waitUntil = async (ok: () => boolean) => { while (!ok() && !stopped) await new Promise<void>(r => waiters.add(r)); };
    const onVisibility = () => { if (!document.hidden) wake(); };
    document.addEventListener('visibilitychange', onVisibility);

    const start = async () => {
      try {
        const res = await fetch(P + 'film.json');
        if (!res.ok || stopped) return;
        const film = await res.json() as Film;
        const portrait = innerWidth / innerHeight < (film.portrait.maxAspect ?? 0.75);
        const light = matchMedia('(max-width: 700px)').matches || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
        set = portrait ? film.portrait : film.desktop; count = film.count;
        const src = (i: number) => '/' + set!.pattern.replace('{index}', String(i).padStart(film.padding, '0'));
        const done = new Set<number>();
        const coarse = level(count, [16, 8], done);
        if (!done.has(count - 1)) { done.add(count - 1); coarse.push(count - 1); }
        const fine = level(count, light ? [4, 2] : [4, 2, 1], done);
        const run = async (queue: number[], isFine: boolean, workers: number) => {
          await Promise.all(Array.from({ length: workers }, async () => {
            while (queue.length && !stopped) {
              await waitUntil(() => allowed(isFine));
              if (stopped) return;
              const i = queue.shift()!;
              try { const r = await fetch(src(i)); if (r.ok) blobs[i] = await r.blob(); } catch { continue; }
              if (stopped) return;
              request();
            }
          }));
        };
        await run(coarse, false, 3);
        await run(fine, true, light ? 3 : 4);
      } catch { /* the poster stays */ }
    };
    // Only after the first screen (poster, text) has rendered and the page has loaded.
    let idle = 0;
    const later = () => { idle = window.setTimeout(() => { if (!stopped) void start(); }, 250); };
    if (document.readyState === 'complete') later(); else addEventListener('load', later, { once: true });

    addEventListener('scroll', request, { passive: true });
    addEventListener('resize', resize, { passive: true });
    request();
    return () => {
      stopped = true; wake();
      clearTimeout(idle);
      removeEventListener('load', later);
      if (raf) cancelAnimationFrame(raf);
      seen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('scroll', request);
      removeEventListener('resize', resize);
      bitmaps.forEach(b => b.close()); bitmaps.clear();
      root.classList.remove('is-scrub', 'has-film');
    };
  }, []);

  return (
    <section className="st-brand-hero" ref={section} aria-labelledby="st-brand-title">
      {/* The first screen's largest picture: preloaded at high priority, the right file for the screen (React places
          these links in <head>). AVIF where supported (all current browsers), WebP otherwise. */}
      <link rel="preload" as="image" type="image/avif" fetchPriority="high" media="(max-aspect-ratio: 3/4)"
        imageSrcSet={`${P}poster-m-720.avif 720w, ${P}poster-m-1080.avif 1080w`} imageSizes="75vh" />
      <link rel="preload" as="image" type="image/avif" fetchPriority="high" media="(min-aspect-ratio: 3/4)"
        imageSrcSet={`${P}poster-1280.avif 1280w, ${P}poster-1920.avif 1920w, ${P}poster-2560.avif 2560w`} imageSizes="100vw" />
      <div className="st-brand-stage">
        <picture>
          <source media="(max-aspect-ratio: 3/4)" type="image/avif" srcSet={`${P}poster-m-720.avif 720w, ${P}poster-m-1080.avif 1080w`} sizes="75vh" />
          <source media="(max-aspect-ratio: 3/4)" type="image/webp" srcSet={`${P}poster-m-720.webp 720w, ${P}poster-m-1080.webp 1080w`} sizes="75vh" />
          <source type="image/avif" srcSet={`${P}poster-1280.avif 1280w, ${P}poster-1920.avif 1920w, ${P}poster-2560.avif 2560w`} sizes="100vw" />
          <img className="st-brand-hero-img" src={`${P}poster-1920.webp`} srcSet={`${P}poster-1280.webp 1280w, ${P}poster-1920.webp 1920w, ${P}poster-2560.webp 2560w`}
            sizes="100vw" alt="" width={2560} height={1440} fetchPriority="high" decoding="async" />
        </picture>
        <canvas className="st-brand-film" ref={canvas} aria-hidden="true" />
        <div className="st-brand-hero-shade" />
        <p className="st-brand-hero-top eyebrow"><span>KITSYUU / FORM STUDY 001</span>{copy.heroTop && <span data-brand-top>{arrow(copy.heroTop)}</span>}</p>
        <h1 id="st-brand-title" className="st-brand-hero-word" ref={word}>KITSYUU</h1>
        <div className="st-brand-hero-copy st-wrap">
          <div>
            {copy.heroEyebrow && <p className="eyebrow" data-brand-eyebrow><span></span>{copy.heroEyebrow}</p>}
            <p className="st-brand-hero-lead" data-brand-lead>{copy.heroLead}</p>
          </div>
          <div className="st-brand-hero-actions">
            <Link className="button" href={url.shop()}>Shop now</Link>
            <Link className="text-link" href={url.collection('new-arrivals')}>New arrivals <span aria-hidden="true">↗</span></Link>
            {/* The story page runs the landing's own script, so it is a full page load (not a client-side <Link>). */}
            <a className="text-link" href="/our-story">Our story <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="st-brand-progress" aria-hidden="true"><span /></div>
      </div>
    </section>
  );
}
