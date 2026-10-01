'use client';
/* Runs the landing page's original script (public/app.js, copied from dist/) against the landing markup.
   app.js is a classic script: it initialises itself as soon as it runs, declares global names, watches scrolling and
   element sizes, and cleans up only on the browser's `pagehide`. So on the homepage it is treated like a separate page:
   - it runs once per page load; showing the homepage again after in-app navigation reloads the page once;
   - links from the homepage to other pages are ordinary page loads (as on the original static site), so the landing is
     unloaded by the browser and app.js cleans up through its own `pagehide` handler;
   - any other in-app exit (e.g. the Back button) sends that `pagehide` signal before the landing markup is removed. */
import { useEffect, useLayoutEffect } from 'react';

declare global { interface Window { __kitsyuuLanding?: Element; __kitsyuuLandingStopped?: boolean } }

/* Tells app.js the landing is gone, through its own `pagehide` handler (stops the frame player, its scroll and resize
   watchers). app.js creates its player only after loading content.json and sequence.json, so a player could appear just
   after the landing was left; the signal is therefore also sent on later scrolls, before the player's own listener. */
function stopLanding(root: Element) {
  const stop = () => window.dispatchEvent(new PageTransitionEvent('pagehide'));
  stop();
  setTimeout(() => {                                    // only once the landing has really left the page
    if (document.contains(root) || window.__kitsyuuLandingStopped) return;
    window.__kitsyuuLandingStopped = true;
    window.addEventListener('scroll', stop, { capture: true, passive: true });
    // Performance (2026-10-01): a late player appears within moments of leaving (once its JSON files arrive), so the
    // safety net is removed after 15 s instead of dispatching `pagehide` on every scroll for the rest of the visit.
    setTimeout(() => window.removeEventListener('scroll', stop, { capture: true }), 15000);
  }, 0);
}

/* Same-site link clicks that leave the homepage: stop them before the app's client router sees them (capture phase on
   the document runs before React's listeners), so the browser performs its normal full page navigation. */
function fullPageExit(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;   // other sites, same-page anchors
  e.stopPropagation();
}

/* Scrolling on /our-story: page navigation is instant (store.css: `html:has(.kitsyuu-landing) { scroll-behavior: auto }`),
   so Back/Forward and opening /our-story#edit are handled natively by the browser. Only the landing's
   own in-page links keep their smooth story scroll, animated here explicitly. Like a native anchor they add a history
   entry and move the focus starting point to the section; with reduced motion they are instant (as in styles.css). */
function smoothLandingLink(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as Element | null)?.closest?.('a[href^="#"]');
  const hash = link?.getAttribute('href') ?? '';
  if (hash.length < 2) return;
  const target = document.getElementById(decodeURIComponent(hash.slice(1)));
  if (!target) return;
  e.preventDefault();
  if (location.hash !== hash) history.pushState(history.state, '', hash);
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  // Focus starting point, as a native anchor sets it (no visible ring: see store.css [data-anchor-focus]).
  const addedTabindex = !target.hasAttribute('tabindex');
  if (addedTabindex) target.setAttribute('tabindex', '-1');
  target.setAttribute('data-anchor-focus', '');
  target.addEventListener('blur', () => { if (addedTabindex) target.removeAttribute('tabindex'); target.removeAttribute('data-anchor-focus'); }, { once: true });
  target.focus({ preventScroll: true });
}

export default function LandingScript() {
  useEffect(() => {
    const root = document.querySelector('[data-landing]');
    root?.addEventListener('click', smoothLandingLink as EventListener);
    return () => root?.removeEventListener('click', smoothLandingLink as EventListener);
  }, []);
  useEffect(() => {
    const root = document.querySelector('[data-landing]');
    if (!root) return;
    if (window.__kitsyuuLanding && window.__kitsyuuLanding !== root) { location.reload(); return; }
    if (window.__kitsyuuLanding !== root) {                        // not yet started for this markup
      window.__kitsyuuLanding = root;
      const script = document.createElement('script');
      script.src = '/app.js';
      script.async = false;
      document.body.appendChild(script);
    }
  }, []);
  useLayoutEffect(() => {
    document.addEventListener('click', fullPageExit, true);
    return () => {
      document.removeEventListener('click', fullPageExit, true);
      // Runs during React's commit, before the landing markup leaves the document. React's development-only double
      // effects also pass here right after mounting, before app.js has started, when the signal has nothing to stop.
      if (window.__kitsyuuLanding) stopLanding(window.__kitsyuuLanding);
    };
  }, []);
  return null;
}
