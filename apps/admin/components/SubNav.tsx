/* The view row of a module: one row of buttons between the pages of that module (Pricing: Product prices · Discounts ·
   Scheduled · History). Plain links, so every view stays a normal server-rendered URL; the current one is marked for
   assistive technology. It looks the same in every module (the workspace view row of the shared frame). */
import Link from 'next/link';

export default function SubNav({ items, current, label, module: mod }: { items: { href: string; label: string; show?: boolean }[]; current: string; label: string; module?: string }) {
  return (
    <nav className="tabs ord-views subnav" aria-label={label} data-subnav data-views data-module-views={mod}>
      {items.filter(i => i.show !== false).map(i => (
        <Link key={i.href} href={i.href} className="btn ghost sm" aria-current={i.href === current ? 'page' : undefined} data-view={i.href}>{i.label}</Link>
      ))}
    </nav>
  );
}
