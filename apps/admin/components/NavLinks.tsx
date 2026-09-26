'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Receives only the items the server already filtered by permission. */
export default function NavLinks({ items }: { items: { href: string; label: string; group: string }[] }) {
  const path = usePathname();
  const groups = items.reduce<{ name: string; items: typeof items }[]>((acc, item) => {
    const last = acc[acc.length - 1];
    if (last?.name === item.group) last.items.push(item); else acc.push({ name: item.group, items: [item] });
    return acc;
  }, []);
  return (
    <nav className="nav" aria-label="Admin">
      {groups.map(g => (
        <div className="nav-section" key={g.name}>
          <div className="nav-group" aria-hidden="true">{g.name}</div>
          {g.items.map(item => {
            const current = path === item.href || path.startsWith(item.href + '/');
            return <Link key={item.href} href={item.href} aria-current={current ? 'page' : undefined}>{item.label}</Link>;
          })}
        </div>
      ))}
    </nav>
  );
}
