'use client';
/* M12: the review form (stars, optional title, text, the name to show, up to N photos). Everything is validated again
   on the server; photos are re-encoded there (metadata such as location removed). */
import { submitReviewAction } from '@/app/account/review-actions';
import { ActionForm, Field, Hidden, RadioGroup } from './forms';

const STARS = [5, 4, 3, 2, 1].map(n => ({ value: String(n), label: <span aria-label={`${n} out of 5`}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span> }));

export function ReviewForm({ orderItemId, defaultName, maxPhotos }: { orderItemId: string; defaultName: string; maxPhotos: number }) {
  return (
    <ActionForm action={submitReviewAction} submitLabel="Send review" pendingLabel="Sending…" label="Write a review" className="st-auth-form st-review-form" id="review-form">
      <Hidden name="orderItemId" value={orderItemId} />
      <RadioGroup name="rating" legend="Your rating" options={STARS} />
      <Field name="title" label="Title (optional)" maxLength={80} />
      <div className="st-field st-field-wide">
        <label htmlFor="rv-body">Your review</label>
        <textarea id="rv-body" name="body" rows={6} maxLength={2000} required className="st-textarea" />
      </div>
      <Field name="displayName" label="Name shown with your review" defaultValue={defaultName} maxLength={40} required hint="For example your first name." />
      <div className="st-field st-field-wide">
        <label htmlFor="rv-photos">Photos (optional, up to {maxPhotos})</label>
        <input id="rv-photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple className="st-file" />
        <p className="st-field-hint">JPEG, PNG or WebP, up to 5 MB each. Location details are removed from photos.</p>
      </div>
    </ActionForm>
  );
}
