'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoutButton } from './AuthForms';

const ITEMS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/profile', label: 'Personal information' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/wishlist', label: 'Wishlist' },
  { href: '/account/reviews', label: 'Reviews' },
  { href: '/account/returns', label: 'Returns' },
  { href: '/account/points', label: 'Points' },
  { href: '/account/support', label: 'Help & support' },
  { href: '/account/security', label: 'Security' },
];

/** Account section navigation. Access is decided on the server; this only shows where you are. */
export default function AccountNav({ greeting }: { greeting: string }) {
  const path = usePathname();
  const current = (href: string) => (href === '/account' ? path === href : path === href || path.startsWith(href + '/'));
  return (
    <nav className="st-account-nav" aria-label="Account">
      <p className="st-account-greeting">{greeting}</p>
      <ul>
        {ITEMS.map(i => <li key={i.href}><Link href={i.href} aria-current={current(i.href) ? 'page' : undefined}>{i.label}</Link></li>)}
      </ul>
      <LogoutButton className="st-account-logout" />
    </nav>
  );
}
