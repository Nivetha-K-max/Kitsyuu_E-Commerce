'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Receives only the items the server already filtered by permission. */
export default function NavLinks({ items }: { items: { href: string; label: string; group: string }[] }) {
  const path = usePathname();
  let group = '';
  return (
    <nav className="nav" aria-label="Admin">
      {items.map(item => {
        const heading = item.group !== group ? (group = item.group) : null;
        const current = path === item.href || path.startsWith(item.href + '/');
        return (
          <div key={item.href}>
            {heading && <div className="nav-group">{heading}</div>}
            <Link href={item.href} aria-current={current ? 'page' : undefined}>{item.label}</Link>
          </div>
        );
      })}
    </nav>
  );
}
