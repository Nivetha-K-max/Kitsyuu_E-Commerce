'use client';
/* Light / dark / system theme switch. The choice is stored in this browser only (localStorage) and applied by setting
   data-theme on <html>; the inline script in app/layout.tsx applies it before the first paint. Default: light. */
import { useEffect, useState } from 'react';
import { Icon } from './icons';

export const THEME_KEY = 'kitsyuu-admin-theme';
type Pref = 'light' | 'dark' | 'system';
const OPTIONS: { value: Pref; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

function apply(pref: Pref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePref = pref;
}

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [pref, setPref] = useState<Pref>('light');
  useEffect(() => {
    const stored = document.documentElement.dataset.themePref;
    if (stored === 'dark' || stored === 'system' || stored === 'light') setPref(stored);
  }, []);
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  const choose = (next: Pref) => {
    setPref(next);
    apply(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked: the theme still applies for this page */ }
  };
  return (
    <div className={`theme-toggle${compact ? ' compact' : ''}`} role="group" aria-label="Colour theme" data-theme-toggle>
      {OPTIONS.map(o => (
        <button key={o.value} type="button" aria-pressed={pref === o.value} onClick={() => choose(o.value)} title={`${o.label} theme`} data-theme-option={o.value}>
          <Icon name={o.icon} size={15} /><span className={compact ? 'sr-only' : 'theme-label'}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
