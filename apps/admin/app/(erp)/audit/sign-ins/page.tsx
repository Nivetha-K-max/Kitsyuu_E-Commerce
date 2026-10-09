import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listSignIns } from '@kitsyuu/core';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import FilterForm from '@/components/FilterForm';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Sign-in history' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/* M9: every sign-in attempt (staff and customers) next to the audit log. Emails and IPs are personal data: audit.read. */
export default async function SignInsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'audit.read')) return <><PageHead section="System" title="Sign-in history" /><Forbidden permission="audit.read" /></>;
  const sp = await searchParams;
  const realm = one(sp.realm) === 'staff' || one(sp.realm) === 'customer' ? one(sp.realm) as 'staff' | 'customer' : undefined;
  const failedOnly = one(sp.failed) === '1';
  const email = one(sp.email).slice(0, 254) || undefined;
  const page = Math.min(10_000, Math.max(1, parseInt(one(sp.page), 10) || 1));
  const { rows, hasNext } = await listSignIns(db(), actor, { page, realm, failedOnly, email });
  const link = (p: number) => `/audit/sign-ins?${new URLSearchParams({ ...(realm && { realm }), ...(failedOnly && { failed: '1' }), ...(email && { email }), page: String(p) })}`;
  return (
    <Workspace name="audit-sign-ins" title="Sign-in history" summary="Staff and customer sign-in attempts, newest first. Times are IST." crumbs={[{ href: '/audit', label: 'Audit log' }]}>
      <FilterForm className="actions" data-signin-filters>
        <label className="sr-only" htmlFor="f-realm">Who</label>
        <select id="f-realm" name="realm" className="input" defaultValue={realm ?? ''}>
          <option value="">Staff and customers</option><option value="staff">Staff</option><option value="customer">Customers</option>
        </select>
        <label className="sr-only" htmlFor="f-email">Email</label>
        <input id="f-email" name="email" className="input" type="email" placeholder="Email" defaultValue={email ?? ''} />
        <label className="check"><input type="checkbox" name="failed" value="1" defaultChecked={failedOnly} /> Failed only</label>
        <button className="btn ghost" type="submit">Filter</button>
      </FilterForm>
      {rows.length ? (
        <div className="table-wrap"><table data-signins-table>
          <thead><tr><th>Time</th><th>Who</th><th>Email</th><th>Result</th><th>IP</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id} data-succeeded={r.succeeded ? 'yes' : 'no'}>
              <td className="nowrap">{formatDateTime(r.at)}</td>
              <td>{r.realm === 'staff' ? 'Staff' : 'Customer'}</td>
              <td className="mono">{r.email}</td>
              <td><span className={`badge ${r.succeeded ? 'active' : 'disabled'}`}>{r.succeeded ? 'Signed in' : `Failed${r.reason ? ` · ${r.reason}` : ''}`}</span></td>
              <td className="mono">{r.ip ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No sign-in attempts match" kind="signins" />}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={link(page - 1)}>Newer</Link>}
        {hasNext && <Link className="btn ghost sm" href={link(page + 1)}>Older</Link>}
      </nav>
    </Workspace>
  );
}
