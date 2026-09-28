'use server';
import { revalidatePath } from 'next/cache';
import { moderateReviewInput, type ActionState } from '@kitsyuu/contracts';
import { moderateReview } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function moderateReviewAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(moderateReviewInput, form, async input => {
    const res = await moderateReview(db(), actor, input, await requestContext());
    return { ok: true, message: !res.changed ? 'No change.' : input.decision === 'approved' ? 'Approved: the review is now shown in the store.' : 'Rejected: the review is not shown.' };
  });
  if (r.ok) revalidatePath('/reviews');
  return r;
}
