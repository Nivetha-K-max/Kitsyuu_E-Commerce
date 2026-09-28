'use server';
/* M12: a customer submits a review. The session is re-checked here; the service checks that the order line is the
   customer's, that it counts as bought under the current setting, and that it has no review yet. */
import { redirect } from 'next/navigation';
import { submitReviewInput, type ActionState } from '@kitsyuu/contracts';
import { REVIEW_MAX_PHOTOS, submitReview } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireCustomer } from '@/lib/server';

export async function submitReviewAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireCustomer('/account/reviews');
  const files = form.getAll('photos').filter((f): f is File => typeof f !== 'string' && f.size > 0);
  if (files.length > REVIEW_MAX_PHOTOS) return { ok: false, message: `Add at most ${REVIEW_MAX_PHOTOS} photos.` };
  let done = false;
  const r = await handle(submitReviewInput, form, async input => {
    const photos = await Promise.all(files.map(async f => ({ bytes: Buffer.from(await f.arrayBuffer()) })));
    await submitReview(db(), me, input, photos, await requestContext());
    done = true;
  });
  if (done) redirect('/account/reviews?sent=1');
  return r;
}
