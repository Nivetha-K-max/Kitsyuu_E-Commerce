/* A pinned scroll animation plays through before the page moves on (client change request, 2026-10-03). Used by the
   homepage film (components/BrandHero.tsx) and the pinned reels (components/Choreo.tsx).

   The owner keeps a playhead that follows the scroll position at a limited speed, and tells this gate whether the playhead
   has reached the end / the start. The gate then keeps the page inside the pinned range until it has:
   - a wheel or trackpad gesture that would carry the page past the range stops at its edge, and further wheeling there is
     absorbed until the playhead arrives;
   - other scrolling (touch, keyboard, the scrollbar) cannot be stopped in advance, so a scroll that leaves the range early
     is brought back to the edge. On touch the page is also held still (which ends the fling).
   Nothing is held for longer than `seconds`: the owner calls release() when the playhead arrives, and a timer does it
   anyway. Jumps that are not scrolling through the range are left alone: a restored position after loading or
   Back / Forward, a link to another part of the page, and any jump of more than a screen and a half (End / Home, a click
   far along the scrollbar).
   Several gates can be on one page (the film, then the reels): one wheel listener asks them all and takes the nearest
   stop, so a gesture never skips a pinned section that lies between. */
export interface ScrollGate {
  /** The scroll positions between which the stage is pinned, or null while it is not pinned (e.g. a phone layout). */
  range: () => [number, number] | null;
  atEnd: () => boolean;
  atStart: () => boolean;
  /** Called on every scroll, and after the gate moved the page: the owner redraws / advances its playhead. */
  wake: () => void;
  /** The longest the owner's playhead takes across the whole range. */
  seconds: number;
}

/** What one gate wants done with a wheel step: nothing (null), swallow it ('wait'), or stop the page at a position. */
type WheelAnswer = null | 'wait' | number;
const wheelers = new Set<(y: number, dy: number) => WheelAnswer>();
let locks = 0;   // gates currently holding the page still on touch
/** Something else is being scrolled (a menu, a drawer, a dialog that locked the page): leave it alone. */
function elsewhere(t: EventTarget | null) {
  const html = document.documentElement;
  if (getComputedStyle(document.body).overflowY === 'hidden' || (!locks && getComputedStyle(html).overflowY === 'hidden')) return true;
  for (let el = t instanceof Element ? t : null; el && el !== document.body && el !== html; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1) return true;
  }
  return false;
}
function onWheel(e: WheelEvent) {
  if (e.ctrlKey || e.defaultPrevented || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY || elsewhere(e.target)) return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1), y = scrollY;
  let to: number | null = null, wait = false;
  wheelers.forEach(w => {
    const a = w(y, dy);
    if (a === 'wait') wait = true;
    else if (a !== null && (to === null || Math.abs(a - y) < Math.abs(to - y))) to = a;
  });
  if (!wait && to === null) return;
  e.preventDefault();
  if (!wait && to !== null) scrollTo({ top: to, behavior: 'instant' });
}

export function gateScroll(g: ScrollGate): { release: () => void; stop: () => void } {
  const html = document.documentElement;
  let touchLock = false, lockTimer = 0;
  const release = () => { if (!touchLock) return; touchLock = false; locks--; clearTimeout(lockTimer); html.style.overflow = ''; };
  const jump = (y: number) => scrollTo({ top: y, behavior: 'instant' });
  const wheel = (y: number, dy: number): WheelAnswer => {
    const r = g.range();
    if (!r) return null;
    const [a, b] = r;
    if (dy > 0) {
      if (y >= b - 1) return y <= b + 1 && !g.atEnd() ? 'wait' : null;             // at the end: wait for the playhead
      return y + dy <= a ? null : Math.min(y + dy, b);
    }
    if (y <= a + 1) return y >= a - 1 && a > 0 && !g.atStart() ? 'wait' : null;    // at the start: wait for the playhead
    return y + dy >= b ? null : Math.max(y + dy, y > b + 1 ? b : a);
  };
  let touching = false, touchUntil = 0, freeUntil = performance.now() + 1200, lastY = scrollY;
  const free = () => { freeUntil = performance.now() + 1200; };
  const hold = (y: number, touch: boolean) => {
    jump(y); lastY = y;
    if (touch && !touchLock && !html.style.overflow) {
      touchLock = true; locks++; html.style.overflow = 'hidden';
      lockTimer = window.setTimeout(release, g.seconds * 1000 + 400);
    }
    g.wake();
  };
  const onScroll = () => {
    const y = scrollY, now = performance.now(), touch = touching || now < touchUntil, r = now > freeUntil ? g.range() : null;
    if (r && Math.abs(y - lastY) <= innerHeight * 1.5) {
      const [a, b] = r;
      if (lastY <= b + 1 && y > b + 1 && !g.atEnd()) return hold(b, touch);
      if (lastY >= a - 1 && y < a - 1 && !g.atStart()) return hold(a, touch);
    }
    lastY = y; g.wake();
  };
  const onTouchStart = () => { touching = true; lastY = scrollY; };
  const onTouchEnd = (e: TouchEvent) => { if (e.touches.length) return; touching = false; touchUntil = performance.now() + 1500; };
  if (!wheelers.size) addEventListener('wheel', onWheel, { passive: false });
  wheelers.add(wheel);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('touchstart', onTouchStart, { passive: true });
  addEventListener('touchend', onTouchEnd, { passive: true });
  addEventListener('touchcancel', onTouchEnd, { passive: true });
  addEventListener('popstate', free);
  addEventListener('hashchange', free);
  addEventListener('pageshow', free);
  return {
    release,
    stop() {
      wheelers.delete(wheel);
      if (!wheelers.size) removeEventListener('wheel', onWheel);
      removeEventListener('scroll', onScroll);
      removeEventListener('touchstart', onTouchStart);
      removeEventListener('touchend', onTouchEnd);
      removeEventListener('touchcancel', onTouchEnd);
      removeEventListener('popstate', free);
      removeEventListener('hashchange', free);
      removeEventListener('pageshow', free);
      release();
    },
  };
}

/** The scroll range in which `stage` (position: sticky inside `root`) is pinned; null while it is not sticky. */
export function pinnedRange(root: HTMLElement, stage: HTMLElement): [number, number] | null {
  const cs = getComputedStyle(stage);
  if (cs.position !== 'sticky') return null;
  const top = Math.max(0, root.getBoundingClientRect().top + scrollY - (parseFloat(cs.top) || 0));
  return [top, top + Math.max(1, root.offsetHeight - stage.offsetHeight)];
}
