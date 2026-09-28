import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { customerReviewState, getCustomerProfile, REVIEW_MAX_PHOTOS } from '@kitsyuu/core';
import { ReviewForm } from '@/components/ReviewForm';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Write a review' };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function NewReview({ searchParams }: { searchParams: SP }) {
  const item = String((await searchParams).item ?? '');
  const me = await requireCustomer(`/account/reviews/new?item=${encodeURIComponent(item)}`);
  const [{ eligibility, reviewable }, profile] = await Promise.all([customerReviewState(db(), me), getCustomerProfile(db(), me)]);
  const line = reviewable.find(i => i.id === item);
  if (!eligibility || !line) notFound();
  const firstName = (profile.fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Write a review</h1>
        <div className="st-plp-aside"><p className="st-result-count">{line.name}{line.size ? ` · Size ${line.size}` : ''}</p>
          <p>Order {line.order_number}. Your review appears in the store after our team has checked it.</p></div>
      </header>
      <ReviewForm orderItemId={line.id} defaultName={firstName} maxPhotos={REVIEW_MAX_PHOTOS} />
      <p className="st-footnote"><Link href="/account/reviews">Back to your reviews</Link></p>
    </>
  );
}
