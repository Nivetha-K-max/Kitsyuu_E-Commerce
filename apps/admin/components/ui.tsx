/* Small server-rendered building blocks. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { STATUS_LABEL } from '@/lib/format';

export function PageHead({ title, eyebrow, crumbs, children }: { title: string; eyebrow?: string; crumbs?: { href: string; label: string }[]; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {crumbs && <div className="crumbs">{crumbs.map((c, i) => <span key={c.href}>{i > 0 && ' / '}<Link href={c.href}>{c.label}</Link></span>)}</div>}
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
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

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</span>;
}
