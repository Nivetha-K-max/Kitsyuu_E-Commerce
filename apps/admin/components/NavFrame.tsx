'use client';
/* Immediate feedback for navigation inside the Orders and Payments screens (2026-10-06).
   The pages stay server-rendered and the URLs are unchanged. What changes is what the person sees between the click and
   the server's answer: the clicked filter is shown as selected (or the clicked row as opening) at once, the page stays in
   place instead of being swapped for the loading placeholder, and the new content replaces the old in one step.
   These are plain links (they still open in a new tab, copy, and work without scripts). A list row's page is prepared
   in the background while the row is on screen, as before; filters and secondary links (same screen, or a second link
   to the same page) are not, because preparing them brought nothing and doubled the background requests. */
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type AnchorHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';

type Target = { href: string; group?: string; resets?: string[]; off?: boolean };
const Ctx = createContext<{ go: ((t: Target, scroll?: boolean) => void) | null; pending: Target | null }>({ go: null, pending: null });
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Wraps a screen. `data-pending` is set while a navigation started inside it is on its way (see admin.css: the list
    only dims if the answer takes long, so a fast answer shows no intermediate state at all). */
export function NavFrame({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [target, setTarget] = useState<Target | null>(null);
  const go = useCallback((t: Target, scroll = false) => { setTarget(t); start(() => router.push(t.href, { scroll })); }, [router]);
  // A click anywhere on a list row opens the row's main link (as on every admin list), through the same path.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !plainClick(e)) return;
    const t = e.target as HTMLElement;
    if (t.closest('a,button,input,label,select,textarea,summary,details,form,[role=menuitem],[data-no-row-click]')) return;
    const row = t.closest('tbody tr');
    const link = row?.querySelector<HTMLAnchorElement>('a.row-link');
    if (!row || !link || window.getSelection()?.toString()) return;
    e.preventDefault();
    go({ href: link.getAttribute('href')!, group: 'open' }, true);
  };
  /* Opening another page (an order, a payment) costs the server two answers unless the route is known beforehand. It is
     asked for when the pointer rests on the row or link, or the link takes focus, or a finger goes down on it: one small
     request for the row someone is about to open, instead of one per link on the screen. */
  const asked = useRef(new Set<string>());
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intent = (e: SyntheticEvent<HTMLDivElement>, wait: number) => {
    const t = e.target as HTMLElement;
    const link = t.closest<HTMLAnchorElement>('a[data-nav]') ?? t.closest('tbody tr')?.querySelector<HTMLAnchorElement>('a.row-link[data-nav]');
    const href = link?.getAttribute('href');
    if (dwell.current) clearTimeout(dwell.current);
    if (!href || asked.current.has(href)) return;
    dwell.current = setTimeout(() => { asked.current.add(href); router.prefetch(href); }, wait);
  };
  const pending = isPending ? target : null;
  return (
    <Ctx.Provider value={{ go, pending }}>
      <div {...rest} data-pending={isPending || undefined} data-opening={pending?.group === 'open' ? pending.href : undefined} onClick={onClick}
        onPointerOver={e => intent(e, 70)} onPointerDown={e => intent(e, 0)} onFocusCapture={e => intent(e, 0)}>{children}</div>
    </Ctx.Provider>
  );
}

/** A filter: view tab, stage chip, status chip, pager link. It shows as selected the moment it is clicked.
    `group` names the set it belongs to (one selected at a time); `resets` lists other sets that go back to their
    `fallback` member when this one is clicked (a view tab resets the stage chips). */
export function FilterLink({ href, group, current, currentValue = 'true', resets, fallback, offHref, children, ...rest }: {
  href: string; group: string; current: boolean; currentValue?: 'true' | 'page'; resets?: string[]; fallback?: boolean;
  /** A chip that is switched off by clicking it again: where that goes (the set's `fallback` member is then selected). */
  offHref?: string; children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'aria-current' | 'onClick'>) {
  const { go, pending } = useContext(Ctx);
  const on = pending?.group === group ? (pending.off ? !!fallback : pending.href === href) : pending?.resets?.includes(group) ? !!fallback : current;
  const to = current && offHref ? offHref : href;
  return (
    <a {...rest} href={to} aria-current={on ? currentValue : undefined}
      onClick={e => { if (!go || !plainClick(e)) return; e.preventDefault(); if (to !== href) go({ href: to, group, resets, off: true }); else if (!(current && !pending)) go({ href, group, resets }); }}>{children}</a>
  );
}

/** A link to another page of these screens (an order, a payment, the next step). The page stays until the new one is
    ready; the link itself (and its row) shows that it was clicked. */
export function NavLink({ href, prefetch, children, ...rest }: {
  href: string; children: ReactNode;
  /** Prepare the page as soon as the link is on screen (as the admin's list links always did), so it opens at once. */
  prefetch?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const { go, pending } = useContext(Ctx);
  const router = useRouter();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!prefetch || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => { if (entries.some(x => x.isIntersecting)) { io.disconnect(); router.prefetch(href); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [prefetch, href, router]);
  return (
    <a {...rest} ref={ref} href={href} data-nav="" data-busy={pending?.href === href || undefined}
      onClick={e => { if (!go || !plainClick(e)) return; e.preventDefault(); go({ href, group: 'open' }, true); }}>{children}</a>
  );
}
