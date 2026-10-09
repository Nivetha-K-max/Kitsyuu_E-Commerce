import type { Metadata } from 'next';
import Link from 'next/link';
import { customerReviewState } from '@kitsyuu/core';
import { Card } from '@/components/account-ui';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Reviews' };
const STATUS: Record<string, string> = { pending: 'Waiting for approval', approved: 'Published', rejected: 'Not published' };

/* M12: the customer's reviews and the purchases they can still review. */
export default async function AccountReviews() {
  const me = await requireCustomer('/account/reviews');
  const { eligibility, reviews, reviewable } = await customerReviewState(db(), me);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Reviews</h1>
        <div className="st-plp-aside"><p className="st-result-count">{reviews.length} written</p>
          <p>Reviews are checked by our team before they appear in the store.</p></div>
      </header>
      <Card id="rv-todo" title="Write a review">
        {!eligibility ? <p className="st-acc-quiet" data-reviews-closed>Reviews are not open yet.</p>
          : reviewable.length ? <ul className="st-review-todo" data-reviewable>{reviewable.map(i => (
            <li key={i.id}><span><b>{i.name}</b>{i.size ? ` · Size ${i.size}` : ''} <small>Order {i.order_number}</small></span>
              <Link className="button button-outline" href={`/account/reviews/new?item=${i.id}`}>Write a review</Link></li>
          ))}</ul>
          : <p className="st-acc-quiet">{eligibility === 'delivered' ? 'You can review items once they have been delivered.' : 'You can review items you have bought.'} Nothing is waiting for a review.</p>}
      </Card>
      <Card id="rv-done" title="Your reviews">
        {reviews.length ? <ul className="st-review-mine" data-my-reviews>{reviews.map(r => (
          <li key={r.id} data-status={r.status}>
            <span><b>{r.product_name}</b>{r.variant_label ? ` (${r.variant_label})` : ''}
              <span className="st-stars" role="img" aria-label={`${r.rating} out of 5`}>{'★'.repeat(r.rating)}<i>{'★'.repeat(5 - r.rating)}</i></span>
              {r.title && <span className="st-review-title">{r.title}</span>}</span>
            <small>{STATUS[r.status] ?? r.status}{r.moderation_note ? ` · ${r.moderation_note}` : ''}</small></li>
        ))}</ul> : <p className="st-acc-quiet">You have not written any reviews yet.</p>}
      </Card>
    </>
  );
}
