'use client';
/* The top of the homepage: the KITSYUU brand film under the one store header. The section is taller than the screen and
   its stage stays pinned while it scrolls past: scrolling down plays the film forward (the sphere unravels into the
   collection), scrolling up plays it backward. The frames are the landing film's (assets/sequence.json); they are drawn
   on a canvas and loaded coarse-to-fine, so the film is usable after a few frames and sharpens as the rest arrive.
   Without JavaScript, with reduced motion, or before the first frame is ready, the poster frame is shown instead.
   The full story film lives on /our-story. */
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { url } from '@/lib/catalogue-utils';

interface Sequence { count: number; width: number; height: number; padding: number; pattern: string }

/** Load order: every 16th frame first, then 8th, 4th, 2nd and finally every frame (phones and Save-Data stop at 2nd). */
function loadOrder(count: number, finest: number): number[] {
  const seen = new Set<number>(), order: number[] = [];
  for (const step of [16, 8, 4, 2, 1].filter(s => s >= finest))
    for (let i = 0; i < count; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
  if (!seen.has(count - 1)) order.push(count - 1);
  return order;
}

/** Brand wording (client change request): editable under Store content; the defaults are the original text. */
export type HeroCopy = { heroTop: string; heroEyebrow: string; heroLead: string };
const arrow = (t: string) => t.split('→').map((part, i) => <span key={i}>{i > 0 && <b aria-hidden="true">→</b>}{part}</span>);

export default function BrandHero({ copy = { heroTop: 'JAPAN → INDIA', heroEyebrow: 'KITSYUU — FROM JAPAN TO INDIA', heroLead: 'Japanese streetwear. Unconventional shapes. Made personal.' } }: { copy?: HeroCopy }) {
  const section = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), word = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const root = section.current!, cv = canvas.current!, ctx = cv.getContext('2d');
    if (!ctx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let stopped = false, raf = 0, seq: Sequence | null = null, drawn = -1;
    const frames: (HTMLImageElement | undefined)[] = [];
    root.classList.add('is-scrub');

    const progress = () => {
      const r = root.getBoundingClientRect(), stage = root.firstElementChild!.getBoundingClientRect().height;
      return Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - stage)));
    };
    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5), w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); drawn = -1; }
    };
    const draw = () => {
      raf = 0;
      if (!seq) return;
      const p = progress();
      // A short hold on the sphere at the start and on the collection at the end.
      const t = Math.min(1, Math.max(0, (p - 0.06) / 0.84));
      const target = Math.round(t * (seq.count - 1));
      let i = target;
      for (let d = 0; d < seq.count; d++) {                       // nearest frame that has arrived
        if (frames[target - d]) { i = target - d; break; }
        if (frames[target + d]) { i = target + d; break; }
      }
      if (word.current) {
        const fade = Math.min(1, p / 0.3);
        word.current.style.opacity = String(1 - fade);
        word.current.style.transform = `translate(-50%, calc(-50% - ${fade * 60}px)) scale(${1 - fade * 0.08})`;
      }
      root.style.setProperty('--st-film', p.toFixed(3));
      const img = frames[i];
      if (!img || i === drawn) return;
      size();
      const cw = cv.width, ch = cv.height, s = Math.max(cw / seq.width, ch / seq.height);
      const dw = seq.width * s, dh = seq.height * s;
      ctx.drawImage(img, (cw - dw) * 0.5, (ch - dh) * 0.45, dw, dh);
      drawn = i;
      root.classList.add('has-film');
    };
    const request = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const resize = () => { drawn = -1; request(); };

    (async () => {
      try {
        const res = await fetch('/assets/sequence.json');
        if (!res.ok || stopped) return;
        seq = await res.json() as Sequence;
        const s = seq;
        const light = matchMedia('(max-width: 700px)').matches || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
        const queue = loadOrder(s.count, light ? 2 : 1);
        const src = (i: number) => '/' + s.pattern.replace('{index}', String(i).padStart(s.padding, '0'));
        const worker = async () => {
          while (queue.length && !stopped) {
            const i = queue.shift()!, img = new Image();
            img.src = src(i);
            try { await img.decode(); } catch { continue; }
            if (stopped) return;
            frames[i] = img;
            request();
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
      } catch { /* the poster stays */ }
    })();

    addEventListener('scroll', request, { passive: true });
    addEventListener('resize', resize);
    request();
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      removeEventListener('scroll', request);
      removeEventListener('resize', resize);
      root.classList.remove('is-scrub', 'has-film');
    };
  }, []);

  return (
    <section className="st-brand-hero" ref={section} aria-labelledby="st-brand-title">
      <div className="st-brand-stage">
        <img className="st-brand-hero-img" src="/assets/upscaled-poster.webp" alt="" width={2560} height={1440} fetchPriority="high" />
        <canvas className="st-brand-film" ref={canvas} aria-hidden="true" />
        <div className="st-brand-hero-shade" />
        <p className="st-brand-hero-top eyebrow"><span>KITSYUU / FORM STUDY 001</span><span data-brand-top>{arrow(copy.heroTop)}</span></p>
        <h1 id="st-brand-title" className="st-brand-hero-word" ref={word}>KITSYUU</h1>
        <div className="st-brand-hero-copy st-wrap">
          <div>
            <p className="eyebrow" data-brand-eyebrow><span></span>{copy.heroEyebrow}</p>
            <p className="st-brand-hero-lead" data-brand-lead>{copy.heroLead}</p>
          </div>
          <div className="st-brand-hero-actions">
            <Link className="button" href={url.shop()}>Shop now</Link>
            <Link className="text-link" href={url.shop({ collection: 'new-arrivals' })}>New arrivals <span aria-hidden="true">↗</span></Link>
            {/* The story page runs the landing's own script, so it is a full page load (not a client-side <Link>). */}
            <a className="text-link" href="/our-story">Our story <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="st-brand-progress" aria-hidden="true"><span /></div>
      </div>
    </section>
  );
}
