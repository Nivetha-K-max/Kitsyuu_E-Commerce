import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getBulkEditDraft } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { applyBulkDraftAction, cancelBulkDraftAction } from '../actions';

export const metadata: Metadata = { title: 'Bulk edit' };
type Params = Promise<{ id: string }>;

/* 2026-10-01: one bulk edit draft change set. Review shows old → new for every product (as when the draft was saved);
   applying runs each product through the normal one-by-one services, so the same checks and audit apply. A price that was
   changed since the draft was saved is refused for that product (reported), never overwritten. */
export default async function BulkDraftPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/products', label: 'Products' }, { href: '/products/bulk', label: 'Bulk edit' }];
  if (!can(actor, 'products.read')) return <><PageHead title="Bulk edit" crumbs={crumbs} /><Forbidden permission="products.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getBulkEditDraft(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const x = d.draft, names = new Map(d.preview.map(r => [r.productId, r.name]));
  const failed = new Map((d.result?.failed ?? []).map(f => [f.productId, f.reason]));
  const outcome = (pid: string) => !d.result ? null : failed.has(pid) ? 'Not changed' : d.result.applied.includes(pid) ? 'Changed' : 'Already so';
  return (
    <>
      <PageHead title={x.number} crumbs={crumbs} eyebrow={`${d.labels.join(', ')} · ${x.product_ids.length} product${x.product_ids.length === 1 ? '' : 's'}`}>
        <StatusBadge status={x.status} />
      </PageHead>
      <dl className="facts" data-bulk-draft-meta>
        <dt>Created</dt><dd>{formatDateTime(x.created_at as Date)}{x.created_by_email ? ` · ${x.created_by_email}` : ''}</dd>
        {x.applied_at && <><dt>Applied</dt><dd>{formatDateTime(x.applied_at as Date)}{x.applied_by_email ? ` · ${x.applied_by_email}` : ''}</dd></>}
        {x.cancelled_at && <><dt>Cancelled</dt><dd>{formatDateTime(x.cancelled_at as Date)}</dd></>}
        {x.note && <><dt>Note</dt><dd>{x.note}</dd></>}
        {d.result && <><dt>Result</dt><dd data-bulk-result>{d.result.applied.length} changed · {d.result.unchanged.length} already so · {d.result.failed.length} not changed</dd></>}
      </dl>
      {x.status === 'draft' && (
        <div className="actions" data-bulk-draft-actions>
          <ActionForm action={applyBulkDraftAction} submitLabel="Apply these changes" id="bulk-apply-form" label="Apply the bulk edit"
            confirmText="Apply every change below? Products that cannot take a change are skipped and listed.">
            <Hidden name="draftId" value={x.id} />
          </ActionForm>
          {can(actor, 'products.write') && <ActionForm action={cancelBulkDraftAction} submitLabel="Cancel" variant="ghost" id="bulk-cancel-form" label="Cancel the bulk edit">
            <Hidden name="draftId" value={x.id} />
          </ActionForm>}
        </div>
      )}
      {d.result && d.result.failed.length > 0 && (
        <section className="card" data-bulk-failed><h2>Not changed</h2>
          <ul className="plain">{d.result.failed.map(f => <li key={f.productId}><b>{names.get(f.productId) ?? f.productId}</b>: {f.reason}</li>)}</ul>
        </section>
      )}
      <div className="table-wrap"><table data-bulk-preview>
        <thead><tr><th>Product</th><th>Field</th><th>Before</th><th>After</th>{d.result && <th>Outcome</th>}</tr></thead>
        <tbody>{d.preview.flatMap(r => r.changes.map((c, i) => (
          <tr key={`${r.productId}-${i}`} data-bulk-preview-row={r.sku}>
            {i === 0 && <td rowSpan={r.changes.length}><b>{r.name}</b><div className="note mono">{r.sku}</div></td>}
            <td>{c.field}</td><td>{c.before}</td><td><b>{c.after}</b></td>
            {d.result && i === 0 && <td rowSpan={r.changes.length}>{outcome(r.productId)}</td>}
          </tr>
        )))}</tbody>
      </table></div>
      <p className="note">Before / after are as they were when this bulk edit was saved.</p>
    </>
  );
}
