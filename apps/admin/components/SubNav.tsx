/* Tabs between the pages of one module (e.g. Pricing: Products · Discounts · Scheduled · History). Plain links, so every
   page stays a normal server-rendered URL; the current one is marked for assistive technology. */
import Link from 'next/link';

export default function SubNav({ items, current, label }: { items: { href: string; label: string; show?: boolean }[]; current: string; label: string }) {
  return (
    <nav className="subnav" aria-label={label} data-subnav>
      {items.filter(i => i.show !== false).map(i => (
        <Link key={i.href} href={i.href} className={`btn sm ${i.href === current ? '' : 'ghost'}`} aria-current={i.href === current ? 'page' : undefined}>{i.label}</Link>
      ))}
    </nav>
  );
}
