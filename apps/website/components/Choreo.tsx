'use client';
/* KITSYUU v2 image choreography for the store homepage. No animation library: one IntersectionObserver for reveals and
   one requestAnimationFrame pass (only while a scroll section is on screen) that writes CSS variables. All movement is
   transform / opacity / clip-path in store.css, so the browser composites it without layout work.
   Markup hooks:
     [data-reveal]            gets .is-in once it enters the viewport
     [data-reveal-children]   each child gets data-reveal (with a small stagger, --d)
     [data-scroll=pin]        --p = progress while its sticky stage is pinned (0 → 1)
     [data-scroll=pass]       --p = progress while the element crosses the viewport (0 → 1)
     [data-steps=N]           with data-scroll: data-step = current step; children [data-step-item=i] get
                              .is-current / .is-past
   With reduced motion (system setting or the store's own switch) nothing moves: <html> gets .ch-static and the
   sections show their still layout. Before this runs (no JavaScript) the still layout is shown too. */
import { useEffect } from 'react';

export default function Choreo() {
  useEffect(() => {
    const html = document.documentElement;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || html.classList.contains('st-reduce')) {
      html.classList.add('ch-static');
      return;
    }
    html.classList.add('ch-on');

    // A framed photograph starts clipped to nothing, and an element clipped to nothing never counts as visible, so
    // frames are watched through their parent (the frame is revealed when its parent comes into view).
    const targets = new Map<Element, Element[]>();
    const reveal = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      (targets.get(e.target) ?? []).forEach(t => t.classList.add('is-in'));
      reveal.unobserve(e.target);
    }), { rootMargin: '0px 0px -10% 0px', threshold: 0.06 });
    document.querySelectorAll<HTMLElement>('[data-reveal-children]').forEach(list => [...list.children].forEach((c, i) => {
      (c as HTMLElement).style.setProperty('--d', `${(i % 4) * 90}ms`);
      c.setAttribute('data-reveal', '');
    }));
    document.querySelectorAll('[data-reveal]').forEach(el => {
      const watch = el.classList.contains('ch-frame') && el.parentElement ? el.parentElement : el;
      targets.set(watch, [...(targets.get(watch) ?? []), el]);
      reveal.observe(watch);
    });

    const active = new Set<HTMLElement>();
    // Pinned reels: the pictures are a direct function of scroll position (no timed transitions), so a fast scroll can
    // never leave a half-played animation behind. --t runs 0 → n-1 across the reel's travel, after a short hold on the
    // first picture and before a hold on the last, so the final state is reached and seen before the section releases.
    // The shown value eases toward the scroll position (it never runs ahead of it), which smooths wheel and trackpad steps.
    const HOLD_START = 0.07, HOLD_END = 0.12, EASE = 0.22;
    const shown = new Map<HTMLElement, number>();
    let raf = 0;
    const update = () => {
      raf = 0;
      const vh = innerHeight;
      let again = false;
      active.forEach(el => {
        const r = el.getBoundingClientRect();
        const pin = el.dataset.scroll === 'pin';
        const raw = pin ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (vh + r.height);
        const p = Math.min(1, Math.max(0, raw));
        el.style.setProperty('--p', p.toFixed(4));
        const n = Number(el.dataset.steps);
        if (pin && n > 0) {
          const target = Math.min(1, Math.max(0, (p - HOLD_START) / (1 - HOLD_START - HOLD_END))) * (n - 1);
          const prev = shown.get(el) ?? target;
          const t = Math.abs(target - prev) < 0.002 ? target : prev + (target - prev) * EASE;
          if (t !== target) again = true;
          shown.set(el, t);
          el.style.setProperty('--t', t.toFixed(4));
          const step = String(Math.round(t));
          if (el.dataset.step !== step) {
            el.dataset.step = step;
            el.querySelectorAll<HTMLElement>('[data-step-item]').forEach(c => {
              const i = Number(c.dataset.stepItem), s = Number(step);
              c.classList.toggle('is-current', i === s);
              c.classList.toggle('is-past', i < s);
            });
          }
          return;
        }
        if (n > 0) {
          const step = String(Math.min(n - 1, Math.floor(p * n)));
          if (el.dataset.step !== step) {
            el.dataset.step = step;
            el.querySelectorAll<HTMLElement>('[data-step-item]').forEach(c => {
              const i = Number(c.dataset.stepItem), s = Number(step);
              c.classList.toggle('is-current', i === s);
              c.classList.toggle('is-past', i < s);
            });
          }
        }
      });
      if (again) tick();
    };
    const tick = () => { if (!raf) raf = requestAnimationFrame(update); };
    const seen = new IntersectionObserver(entries => {
      entries.forEach(e => (e.isIntersecting ? active.add(e.target as HTMLElement) : active.delete(e.target as HTMLElement)));
      tick();
    });
    document.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => seen.observe(el));
    addEventListener('scroll', tick, { passive: true });
    addEventListener('resize', tick);
    return () => {
      reveal.disconnect(); seen.disconnect();
      removeEventListener('scroll', tick); removeEventListener('resize', tick);
      if (raf) cancelAnimationFrame(raf);
      html.classList.remove('ch-on');
    };
  }, []);
  return null;
}
