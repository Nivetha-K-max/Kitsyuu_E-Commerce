import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listReviews } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { moderateReviewAction } from './actions';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Reviews' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const TABS = [{ key: 'pending', label: 'Waiting' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }] as const;

/* M12: every customer review waits here until staff approve it; nothing (text or photos) is public before that.
   An approved review can be taken down again by rejecting it. */
export default async function ReviewsPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'reviews.read')) return <><PageHead section="Commerce" title="Reviews" /><Forbidden permission="reviews.read" /></>;
  const sp = await searchParams;
  const status = (TABS.find(t => t.key === one(sp.status))?.key ?? 'pending') as 'pending' | 'approved' | 'rejected';
  const page = Math.min(10_000, Math.max(1, parseInt(one(sp.page), 10) || 1));
  const { rows, hasNext, counts } = await listReviews(db(), actor, { status, page });
  const moderate = can(actor, 'reviews.moderate');
  const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
  return (
    <Workspace name="reviews" title="Reviews" summary={`${counts.pending} waiting for approval · ${counts.approved} in the store`}>
      <nav className="tabs actions" aria-label="Review status" data-review-tabs>
        {TABS.map(t => <Link key={t.key} className={`btn ${t.key === status ? '' : 'ghost'} sm`} href={`/reviews?status=${t.key}`} aria-current={t.key === status ? 'page' : undefined}>
          {t.label} ({counts[t.key]})</Link>)}
      </nav>
      {rows.length === 0 ? <Empty title={status === 'pending' ? 'Nothing waiting' : 'No reviews here'} kind="reviews">
        {status === 'pending' ? 'New reviews from customers appear here for approval.' : ''}</Empty> : (
        <div className="review-list" data-reviews>
          {rows.map(r => (
            <article key={r.id} className="card review-card" data-review={r.id} data-status={r.status}>
              <header className="review-head">
                <div>
                  <div className="review-stars" aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</div>
                  {r.title && <h2 className="review-title">{r.title}</h2>}
                  <div className="note"><Link href={`/products/${r.product_id}?tab=reviews`}>{r.product_name}</Link> · <span className="mono">{r.sku}</span></div>
                </div>
                <StatusBadge status={r.status} />
              </header>
              <p className="review-body">{r.body}</p>
              {r.photos.length > 0 && <div className="review-photos">{r.photos.map(ph => (
                // eslint-disable-next-line @next/next/no-img-element
                <a key={ph.id} href={`/api/review-photos/${ph.id}`} target="_blank" rel="noopener"><img src={`/api/review-photos/${ph.id}`} alt="Customer photo" width={ph.width} height={ph.height} loading="lazy" /></a>
              ))}</div>}
              <p className="note">Shown as “{r.display_name}” · {r.customer_email} · {formatDateTime(r.created_at as Date)}
                {r.moderated_at && <> · {r.status} by {r.moderator_email ?? 'staff'} {formatDateTime(r.moderated_at as Date)}{r.moderation_note ? ` — ${r.moderation_note}` : ''}</>}</p>
              {moderate && (
                <div className="actions row-actions">
                  {r.status !== 'approved' && (
                    <ActionForm action={moderateReviewAction} submitLabel="Approve" className="inline-form" id={`rv-ok-${r.id}`} label="Approve review">
                      <Hidden name="reviewId" value={r.id} /><Hidden name="decision" value="approved" /><Hidden name="expectedStatus" value={r.status} />
                    </ActionForm>
                  )}
                  {r.status !== 'rejected' && (
                    <details className="row-edit">
                      <summary className="btn ghost sm">{r.status === 'approved' ? 'Take down' : 'Reject'}</summary>
                      <ActionForm action={moderateReviewAction} submitLabel="Reject" variant="danger" className="form compact row-edit-form" id={`rv-no-${r.id}`} label="Reject review">
                        <Hidden name="reviewId" value={r.id} /><Hidden name="decision" value="rejected" /><Hidden name="expectedStatus" value={r.status} />
                        <Field name="note" label="Reason (staff only)" required />
                      </ActionForm>
                    </details>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={`/reviews?status=${status}&page=${page - 1}`}>Previous</Link>}
        {hasNext && <Link className="btn ghost sm" href={`/reviews?status=${status}&page=${page + 1}`}>Next</Link>}
      </nav>
    </Workspace>
  );
}
