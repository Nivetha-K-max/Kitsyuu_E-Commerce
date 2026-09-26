import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { auditQuery, type AuditQuery } from '@kitsyuu/contracts';
import { listAudit } from '@kitsyuu/core';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Audit log' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'audit.read')) return <><PageHead section="System" title="Audit log" /><Forbidden permission="audit.read" /></>;
  const sp = await searchParams;
  const parsed = auditQuery.safeParse({ page: one(sp.page), action: one(sp.action), entityType: one(sp.entityType), staffId: one(sp.staffId) });
  const query: AuditQuery = parsed.success ? parsed.data : { page: 1, action: undefined, entityType: undefined, staffId: undefined };
  const { rows, hasNext, actions, entityTypes } = await listAudit(db(), actor, query);
  const link = (page: number) => `/audit?${new URLSearchParams({ ...(query.action && { action: query.action }), ...(query.entityType && { entityType: query.entityType }), ...(query.staffId && { staffId: query.staffId }), page: String(page) })}`;
  const show = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 1));
  return (
    <>
      <PageHead section="System" title="Audit log" eyebrow="Append-only · every important admin action" />
      <form className="actions filters" method="get" data-audit-filters>
        <label className="sr-only" htmlFor="f-action">Action</label>
        <select id="f-action" name="action" className="input" defaultValue={query.action ?? ''} style={{ width: 'auto' }}>
          <option value="">All actions</option>{actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-entity">Entity</label>
        <select id="f-entity" name="entityType" className="input" defaultValue={query.entityType ?? ''} style={{ width: 'auto' }}>
          <option value="">All entities</option>{entityTypes.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {query.staffId && <input type="hidden" name="staffId" value={query.staffId} />}
        <button className="btn ghost" type="submit">Filter</button>
        {(query.action || query.entityType || query.staffId) && <Link className="btn link" href="/audit">Clear</Link>}
      </form>
      {rows.length === 0 ? <p className="empty" data-empty="audit">No matching audit records.</p> : (
        <div className="table-wrap"><table data-audit-table>
          <thead><tr><th>When (IST)</th><th>Who</th><th>Action</th><th>Entity</th><th>Change</th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id} data-audit-action={r.action}>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.occurredAt)}</td>
              <td>{r.staffEmail ?? <span className="badge">{r.actorType}</span>}{r.ip && <div className="note mono">{r.ip}</div>}</td>
              <td className="mono">{r.action}</td>
              <td><span className="mono">{r.entityType}</span>{r.entityId && <div className="note mono">{r.entityId}</div>}</td>
              <td>{(r.before != null || r.after != null || (r.metadata && Object.keys(r.metadata as object).length > 0)) ? (
                <details><summary>Details</summary>
                  {r.before != null && <pre className="diff">before: {show(r.before)}</pre>}
                  {r.after != null && <pre className="diff">after: {show(r.after)}</pre>}
                  {r.metadata != null && Object.keys(r.metadata as object).length > 0 && <pre className="diff">meta: {show(r.metadata)}</pre>}
                </details>) : <span className="note">—</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      <div className="actions" style={{ marginTop: 14 }}>
        {query.page > 1 && <Link className="btn ghost" href={link(query.page - 1)}>Newer</Link>}
        {hasNext && <Link className="btn ghost" href={link(query.page + 1)}>Older</Link>}
        <span className="note">Page {query.page}</span>
      </div>
    </>
  );
}
