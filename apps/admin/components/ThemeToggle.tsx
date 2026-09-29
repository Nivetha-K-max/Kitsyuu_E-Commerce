'use client';
/* Light / dark / system theme. The choice is stored in this browser only (localStorage) and applied by setting
   data-theme on <html>; the inline script in app/layout.tsx applies it before the first paint. Default: light.
   One small dropdown (sun / moon icon) replaces the old three-button switch; the user menu and the command palette
   use the same helpers. */
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useEffect, useState } from 'react';
import { Icon } from './icons';

export const THEME_KEY = 'kitsyuu-admin-theme';
export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePref = pref;
}

export function setTheme(pref: ThemePref) {
  apply(pref);
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* storage blocked: the theme still applies for this page */ }
  window.dispatchEvent(new CustomEvent('kitsyuu-theme', { detail: pref }));
}

/** The current preference, kept in sync across every component that shows it. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>('light');
  useEffect(() => {
    const read = () => {
      const stored = document.documentElement.dataset.themePref;
      setPref(stored === 'dark' || stored === 'system' ? stored : 'light');
    };
    read();
    window.addEventListener('kitsyuu-theme', read);
    return () => window.removeEventListener('kitsyuu-theme', read);
  }, []);
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return [pref, setTheme];
}

/** Menu items for a theme choice, for use inside any Radix dropdown. */
export function ThemeItems({ pref, onPick }: { pref: ThemePref; onPick: (p: ThemePref) => void }) {
  return (
    <Dropdown.RadioGroup value={pref} onValueChange={v => onPick(v as ThemePref)}>
      {THEME_OPTIONS.map(o => (
        <Dropdown.RadioItem key={o.value} value={o.value} className="menu-item" data-theme-option={o.value}>
          <Icon name={o.icon} />{o.label}
          <Dropdown.ItemIndicator className="menu-check"><Icon name="check" size={14} /></Dropdown.ItemIndicator>
        </Dropdown.RadioItem>
      ))}
    </Dropdown.RadioGroup>
  );
}

export default function ThemeToggle() {
  const [pref, choose] = useThemePref();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="icon-btn" aria-label="Colour theme" title="Colour theme" data-theme-toggle>
        <Icon name={pref === 'dark' ? 'moon' : pref === 'system' ? 'monitor' : 'sun'} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 160 }}>
          <Dropdown.Label className="menu-label">Theme</Dropdown.Label>
          <ThemeItems pref={pref} onPick={choose} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
