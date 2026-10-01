'use client';
/* The dark / light theme switch in the header tools (see lib/theme.ts). */
import { useEffect, useState } from 'react';
import { THEME_COLOUR, THEME_KEY, type Theme } from '@/lib/theme';

const sun = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>;
const moon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>;

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => { setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'); }, []);
  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOUR[next]);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: the choice lasts for this page only */ }
    setTheme(next);
  };
  // Before hydration the current theme is unknown here, so the button names no direction yet.
  const label = theme === null ? 'Switch theme' : theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  return (
    <button className="st-tool st-theme-toggle" type="button" onClick={toggle} aria-label={label} title={label} data-theme-toggle={theme ?? ''}>
      {theme === 'light' ? moon : sun}
    </button>
  );
}
