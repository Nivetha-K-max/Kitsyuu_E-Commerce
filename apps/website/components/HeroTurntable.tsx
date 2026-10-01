'use client';
import { useEffect } from 'react';

/* Renders nothing. Starts the dormant turntable player; with data-turntable="" it makes no requests.
   Performance (2026-10-01): the player's code is loaded only when a turntable is actually configured on the page, so it
   is not part of the homepage bundle while it is dormant. */
export default function HeroTurntable() {
  useEffect(() => {
    if (!document.querySelector('[data-turntable]:not([data-turntable=""])')) return;
    let stop: (() => void) | void, gone = false;
    import('@/lib/turntable').then(m => { if (!gone) stop = m.initTurntable(); });
    return () => { gone = true; stop?.(); };
  }, []);
  return null;
}
