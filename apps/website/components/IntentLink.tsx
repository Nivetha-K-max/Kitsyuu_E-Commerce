'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps } from 'react';

/* Performance (2026-10-14): a link to a page rendered for each request (/shop, a category, a collection, cart, search,
   log in / account). A plain Link prefetches such a page as soon as it scrolls into view, which is a full render on the
   server for every visitor of the homepage (the 2026-10-02 load test: five per homepage view). This one prefetches when
   the visitor shows intent instead: pointer over it, keyboard focus, or a finger touching it (before the tap ends). The
   link, its look and where it goes are unchanged. (Was the header's MenuLink, 2026-10-01.) */
export default function IntentLink({ href, onMouseEnter, onFocus, onTouchStart, ...rest }: Omit<ComponentProps<typeof Link>, 'prefetch' | 'href'> & { href: string }) {
  const router = useRouter();
  const warm = () => router.prefetch(href);
  return <Link {...rest} href={href} prefetch={false}
    onMouseEnter={e => { warm(); onMouseEnter?.(e); }} onFocus={e => { warm(); onFocus?.(e); }} onTouchStart={e => { warm(); onTouchStart?.(e); }} />;
}
