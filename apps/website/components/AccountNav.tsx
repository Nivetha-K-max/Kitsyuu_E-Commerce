'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { LogoutButton } from './AuthForms';
import { AccountIcons } from './icons';

const ITEMS: { href: string; label: string; icon: keyof typeof AccountIcons }[] = [
  { href: '/account', label: 'Overview', icon: 'overview' },
  { href: '/account/profile', label: 'Personal information', icon: 'profile' },
  { href: '/account/addresses', label: 'Addresses', icon: 'addresses' },
  { href: '/account/orders', label: 'Orders', icon: 'orders' },
  { href: '/account/wishlist', label: 'Wishlist', icon: 'wishlist' },
  { href: '/account/reviews', label: 'Reviews', icon: 'reviews' },
  { href: '/account/returns', label: 'Returns', icon: 'returns' },
  { href: '/account/points', label: 'Points', icon: 'points' },
  { href: '/account/support', label: 'Help & support', icon: 'support' },
  { href: '/account/security', label: 'Security', icon: 'security' },
];

/** Account section navigation. Access is decided on the server; this only shows where you are.
    A sidebar on wide screens; on small screens one row that scrolls sideways, with the current section kept in view. */
export default function AccountNav() {
  const path = usePathname();
  const nav = useRef<HTMLElement>(null);
  const current = (href: string) => (href === '/account' ? path === href : path === href || path.startsWith(href + '/'));
  useEffect(() => {
    const el = nav.current, here = el?.querySelector<HTMLElement>('[aria-current=page]');
    if (el && here && el.scrollWidth > el.clientWidth) el.scrollLeft = here.offsetLeft - (el.clientWidth - here.offsetWidth) / 2;
  }, [path]);
  return (
    <nav className="st-account-nav" aria-label="Account" ref={nav}>
      <ul>
        {ITEMS.map(i => (
          <li key={i.href}><Link href={i.href} aria-current={current(i.href) ? 'page' : undefined}>
            <span className="st-acc-ico">{AccountIcons[i.icon]}</span><span>{i.label}</span>
          </Link></li>
        ))}
      </ul>
      <LogoutButton className="st-account-logout" />
    </nav>
  );
}
