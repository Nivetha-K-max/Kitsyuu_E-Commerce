'use client';
/* Keyboard shortcuts shared by the sidebar hints, the command palette and the global key handler.
   "G then <key>" jumps to a page (only pages the person can open are in the sidebar, so only those work). */
import { useEffect, useState } from 'react';

export const GO_KEYS: Record<string, string> = {
  '/dashboard': 'D', '/reports': 'R', '/products': 'P', '/inventory': 'I', '/orders': 'O', '/customers': 'C', '/payments': 'Y',
  '/staff': 'T', '/settings': 'S', '/audit': 'A',
};

export const SIDEBAR_KEY = 'kitsyuu-admin-sidebar';

/** Whether the desktop sidebar is collapsed to its icon rail (stored per browser; applied before first paint). */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const read = () => setCollapsed(document.documentElement.dataset.sidebar === 'collapsed');
    read();
    window.addEventListener('kitsyuu-sidebar', read);
    return () => window.removeEventListener('kitsyuu-sidebar', read);
  }, []);
  const toggle = () => {
    const next = document.documentElement.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed';
    document.documentElement.dataset.sidebar = next;
    try { localStorage.setItem(SIDEBAR_KEY, next); } catch { /* storage blocked: applies to this page only */ }
    window.dispatchEvent(new Event('kitsyuu-sidebar'));
  };
  return [collapsed, toggle];
}

/** True when a key press is meant for a text field, so single-key shortcuts must not fire. */
export function typingInField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
