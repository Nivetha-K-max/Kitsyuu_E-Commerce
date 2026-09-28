import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { getSystemStatus, listNotificationLog } from '@kitsyuu/core';
import { Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import pkg from '../../../package.json';

export const metadata: Metadata = { title: 'System' };
export const dynamic = 'force-dynamic';

/* M9: system health for staff with system.read. Configuration is shown as modes only ("set" / "not set"), never values. */
export default async function SystemPage() {
  const actor = await requireActor();
  if (!can(actor, 'system.read')) return <><PageHead section="System" title="System" /><Forbidden permission="system.read" /></>;
  const set = (name: string) => (process.env[name] ? 'set' : 'not set');
  const s = await getSystemStatus(db(), actor, {
    app: 'admin', version: pkg.version, node: process.version, environment: process.env.NODE_ENV ?? 'unknown',
    config: {
      'Email (MAILER)': process.env.MAILER || 'console', 'Image storage (STORAGE_DRIVER)': process.env.STORAGE_DRIVER || 'local',
      'Admin URL (ADMIN_APP_URL)': set('ADMIN_APP_URL'), 'Database connection': set('ADMIN_DATABASE_URL'),
    },
  });
  const emails = await listNotificationLog(db(), actor, 20);
  const row = (k: string, v: React.ReactNode, state?: 'ok' | 'bad') => (
    <div key={k}><dt>{k}</dt><dd data-state={state}>{v}</dd></div>
  );
  return (
    <>
      <PageHead section="System" title="System" eyebrow="Health of the admin app and its database. Nothing here shows secrets." />
      <div className="grid-2">
        <section className="card" aria-labelledby="sys-db" data-section="database">
          <SectionTitle id="sys-db">Database</SectionTitle>
          <dl className="kv" data-system-db>
            {row('Status', s.database.ok ? 'Up' : 'Down', s.database.ok ? 'ok' : 'bad')}
            {row('Round trip', s.database.latencyMs !== null ? `${s.database.latencyMs} ms` : '—')}
            {row('Clock difference', s.clockSkewMs !== null ? `${Math.round(s.clockSkewMs / 1000)} s` : '—', s.clockSkewMs !== null && s.clockSkewMs > 120_000 ? 'bad' : undefined)}
            {row('Last unpaid-order expiry', s.lastOrderExpiry ? formatDateTime(s.lastOrderExpiry) : 'none recorded yet')}
            {row('Last system event', s.lastSystemEvent ? `${s.lastSystemEvent.action} · ${formatDateTime(s.lastSystemEvent.at)}` : 'none recorded yet')}
          </dl>
        </section>
        <section className="card" aria-labelledby="sys-app" data-section="runtime">
          <SectionTitle id="sys-app">Admin app</SectionTitle>
          <dl className="kv" data-system-runtime>
            {row('Version', s.runtime.version)}
            {row('Environment', s.runtime.environment)}
            {row('Node.js', s.runtime.node)}
            {Object.entries(s.runtime.config).map(([k, v]) => row(k, v))}
          </dl>
        </section>
        <section className="card" aria-labelledby="sys-signin" data-section="signins">
          <SectionTitle id="sys-signin">Sign-ins, last 24 hours</SectionTitle>
          <dl className="kv" data-system-signins>
            {(['staff', 'customer'] as const).map(r => row(r === 'staff' ? 'Staff' : 'Customers',
              `${s.signins24h[r]?.ok ?? 0} successful · ${s.signins24h[r]?.failed ?? 0} failed`, (s.signins24h[r]?.failed ?? 0) > 20 ? 'bad' : undefined))}
          </dl>
          {can(actor, 'audit.read') && <p className="note"><Link href="/audit/sign-ins">See every sign-in attempt</Link></p>}
        </section>
        <section className="card" aria-labelledby="sys-mail" data-section="emails">
          <SectionTitle id="sys-mail">Customer emails</SectionTitle>
          {emails.length ? <ul className="plain" data-email-log>{emails.map(e => (
            <li key={e.id} data-status={e.status}><b>{e.status === 'sent' ? 'Sent' : 'Failed'}</b> · {e.event}{e.order_number ? ` · ${e.order_number}` : ''} · {formatDateTime(e.created_at as Date)}
              {e.error && <div className="note">{e.error}</div>}</li>
          ))}</ul> : <p className="note">No customer emails sent yet. Order emails are switched on under Settings → Customer emails.</p>}
        </section>
        <section className="card" aria-labelledby="sys-mon" data-section="monitoring">
          <SectionTitle id="sys-mon">Monitoring</SectionTitle>
          <p className="note">Uptime monitors can call <code>/api/health</code> on the admin and on the store. It answers 200 when the database is
            reachable and 503 when it is not, and shows nothing else.</p>
        </section>
      </div>
    </>
  );
}
