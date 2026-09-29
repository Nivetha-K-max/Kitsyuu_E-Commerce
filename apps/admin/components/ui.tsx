/* Small server-rendered building blocks. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { StatusPill } from './StatusPill';

/** Page header: parent pages (detail pages only; the section is already in the top bar), title, a one-line
    description, and the page's main actions on the right. Sticky under the top bar while scrolling. */
export function PageHead({ title, eyebrow, crumbs, children }: {
  title: string; eyebrow?: string; crumbs?: { href: string; label: string }[]; section?: string; children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        {crumbs && crumbs.length > 0 && (
          <p className="crumbs">
            {crumbs.map((c, i) => <span key={c.href}>{i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}<Link href={c.href}>{c.label}</Link></span>)}
          </p>
        )}
        <h1>{title}</h1>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

/** Section heading inside a panel. */
export function SectionTitle({ id, index, children }: { id?: string; index?: string; children: ReactNode }) {
  return <h2 id={id} className="section-title">{index && <span className="idx" aria-hidden="true">{index}</span>}{children}</h2>;
}

/** Empty state: what is missing, why, and (optionally) what to do next. */
export function Empty({ title, children, action, kind, compact }: { title: string; children?: ReactNode; action?: ReactNode; kind?: string; compact?: boolean }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`} data-empty={kind}>
      <span className="empty-icon" aria-hidden="true"><Icon name="inbox" size={20} /></span>
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Shown when the signed-in staff member lacks the permission for a page. The server did not load the page's data. */
export function Forbidden({ permission }: { permission: string }) {
  return (
    <section className="gate" data-gate="forbidden">
      <p className="eyebrow">Not permitted</p>
      <h2>You do not have access to this page.</h2>
      <p className="note">It needs the <span className="mono">{permission}</span> permission. Ask a staff member who manages roles if you need it.</p>
    </section>
  );
}

export const StatusBadge = StatusPill;
