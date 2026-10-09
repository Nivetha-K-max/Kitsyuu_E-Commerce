/* Small presentational pieces shared by the account pages. No 'use client': they render on the server. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { statusTone } from '@/lib/account-format';

/** A status badge. The label is the customer wording; the tone only picks its colour. */
export function StatusPill({ status, label }: { status: string; label: string }) {
  return <span className="st-pill" data-tone={statusTone(status)}>{label}</span>;
}

/** A titled card, optionally with one action link in its head. */
export function Card({ id, title, action, children, className = '' }: { id: string; title: string; action?: { href: string; label: string }; children: ReactNode; className?: string }) {
  return (
    <section className={`st-acc-card ${className}`.trim()} aria-labelledby={id}>
      <div className="st-acc-card-head">
        <h2 id={id}>{title}</h2>
        {action && <Link className="st-acc-action" href={action.href}>{action.label}<span aria-hidden="true"> →</span></Link>}
      </div>
      {children}
    </section>
  );
}

/** Empty state inside a section: what is missing and, when there is one, the next step. */
export function EmptyNote({ children, action, ...rest }: { children: ReactNode; action?: { href: string; label: string } } & Record<`data-${string}`, string | boolean>) {
  return (
    <div className="st-acc-empty" {...rest}>
      <p>{children}</p>
      {action && <Link className="button button-outline" href={action.href}>{action.label}</Link>}
    </div>
  );
}
