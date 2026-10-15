'use client';
/* Grouped topic navigation for a module with many internal views (Configuration has 19). Wide screens: a list beside
   the content, under short group headings, every topic visible at once. Narrower screens: ONE row that scrolls
   sideways (no wrapping), with the current topic scrolled into view. Each topic is a FilterLink, so it is marked at
   once when clicked, like every other view row, and its address is the same as before. */
import { useEffect, useRef } from 'react';
import { FilterLink } from './NavFrame';
import type { ViewItem } from './frame';

export interface TopicGroup { label?: string; items: ViewItem[] }

export default function TopicNav({ label, groups, current }: { label: string; groups: TopicGroup[]; current: string }) {
  const nav = useRef<HTMLElement>(null);
  // Only the row form scrolls; moving its own scroll position never scrolls the page.
  useEffect(() => {
    const el = nav.current, on = el?.querySelector<HTMLElement>('[aria-current]');
    if (!el || !on || el.scrollWidth <= el.clientWidth + 1) return;
    el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
  }, [current]);
  return (
    <nav className="topic-nav" aria-label={label} data-views ref={nav}>
      {groups.map((g, i) => (
        <div className="topic-group" key={g.label ?? i}>
          {g.label && <p className="topic-label" aria-hidden="true">{g.label}</p>}
          {g.items.map(v => (
            <FilterLink key={v.id} className="topic-link" group="view" current={v.id === current} currentValue="page" href={v.href} data-view={v.id}>{v.label}</FilterLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
