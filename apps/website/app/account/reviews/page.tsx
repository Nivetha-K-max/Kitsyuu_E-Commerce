import type { Metadata } from 'next';
import Link from 'next/link';
import { customerReviewState } from '@kitsyuu/core';
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
      <section className="st-account-section" aria-labelledby="rv-todo">
        <h2 id="rv-todo">Write a review</h2>
        {!eligibility ? <p className="st-note" data-reviews-closed>Reviews are not open yet.</p>
          : reviewable.length ? <ul className="st-review-todo" data-reviewable>{reviewable.map(i => (
            <li key={i.id}><span><b>{i.name}</b>{i.size ? ` · Size ${i.size}` : ''} <small>Order {i.order_number}</small></span>
              <Link className="text-link" href={`/account/reviews/new?item=${i.id}`}>Write a review <span aria-hidden="true">↗</span></Link></li>
          ))}</ul>
          : <p className="st-note">{eligibility === 'delivered' ? 'You can review items once they have been delivered.' : 'You can review items you have bought.'} Nothing is waiting for a review.</p>}
      </section>
      <section className="st-account-section" aria-labelledby="rv-done">
        <h2 id="rv-done">Your reviews</h2>
        {reviews.length ? <ul className="st-review-mine" data-my-reviews>{reviews.map(r => (
          <li key={r.id} data-status={r.status}><span><b>{r.product_name}</b>{r.variant_label ? ` (${r.variant_label})` : ''} · {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}{r.title ? ` · ${r.title}` : ''}</span>
            <small>{STATUS[r.status] ?? r.status}{r.moderation_note ? ` · ${r.moderation_note}` : ''}</small></li>
        ))}</ul> : <p className="st-note">You have not written any reviews yet.</p>}
      </section>
    </>
  );
}
