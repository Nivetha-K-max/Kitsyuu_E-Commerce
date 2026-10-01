import { approvedReviews } from '@kitsyuu/core';
import { db } from '@/lib/server';

const stars = (n: number) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
const date = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/* M12: approved customer reviews on the product page (server-rendered). Only approved reviews and their photos are ever
   read here. If the review database is not reachable (for example, not configured), the section is simply left out. */
export default async function ProductReviews({ productId }: { productId: string }) {
  let reviews: Awaited<ReturnType<typeof approvedReviews>>;
  try { reviews = await approvedReviews(db(), productId); } catch { return null; }
  if (!reviews.length) return (
    <section className="st-section st-reviews" aria-labelledby="st-reviews-h" data-reviews="0">
      <div className="st-section-head"><h2 id="st-reviews-h">Customer<br /><em>reviews.</em></h2></div>
      <p className="st-note">No reviews yet. Customers who bought this piece can review it from their account.</p>
    </section>
  );
  const avg = reviews.reduce((n, r) => n + r.rating, 0) / reviews.length;
  return (
    <section className="st-section st-reviews" aria-labelledby="st-reviews-h" data-reviews={reviews.length}>
      <div className="st-section-head">
        <h2 id="st-reviews-h">Customer<br /><em>reviews.</em></h2>
        <p className="st-reviews-summary" aria-label={`Rated ${avg.toFixed(1)} out of 5 from ${reviews.length} reviews`}>
          <span className="st-stars" aria-hidden="true">{stars(avg)}</span> {avg.toFixed(1)} · {reviews.length} review{reviews.length === 1 ? '' : 's'}</p>
      </div>
      <ul className="st-review-list">{reviews.map(r => (
        <li key={r.id} className="st-review" data-review={r.id}>
          <p className="st-stars" aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</p>
          {r.title && <h3>{r.title}</h3>}
          <p className="st-review-body">{r.body}</p>
          {r.photos.length > 0 && <div className="st-review-photos">{r.photos.map(ph => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={ph.id} src={`/api/reviews/photo/${ph.id}`} alt={`Photo from ${r.displayName}`} width={ph.width} height={ph.height} loading="lazy" />
          ))}</div>}
          <p className="st-review-meta">{r.displayName} · Verified purchase{r.variant ? ` (${r.variant})` : ''} · {date.format(r.createdAt)}</p>
        </li>
      ))}</ul>
    </section>
  );
}
