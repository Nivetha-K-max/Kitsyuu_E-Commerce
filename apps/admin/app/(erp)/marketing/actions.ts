'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { bannerInput, campaignInput, deleteSegmentInput, segmentInput, setBannerActiveInput, setCampaignActiveInput, subscriberIdInput, type ActionState } from '@kitsyuu/contracts';
import { rejectReferral, runReferralRewards, deleteSegment, saveBanner, saveCampaign, saveSegment, setBannerActive, setCampaignActive, unsubscribeSubscriber } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/marketing', 'layout'); return r; };

// Referrals (2026-10-12): permissions are checked in the core (marketing.manage); both actions are audited there.
const rejectReferralInput = z.object({ referralId: z.string().regex(/^[0-9a-f-]{36}$/i, 'Not a valid referral.'), reason: z.string().trim().min(3, 'Give a reason.').max(300, 'Keep it under 300 characters.') });
export async function rejectReferralAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(rejectReferralInput, form, async input => { await rejectReferral(db(), actor, input, await requestContext()); return { ok: true, message: 'Referral rejected. No reward will be given for it.' }; }));
}
export async function runReferralRewardsAction(_: ActionState, _form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(z.object({}), _form, async () => {
    const r = await runReferralRewards(db(), actor, await requestContext());
    return { ok: true, message: r.off ? 'Referral rewards are switched off or no reward amount is set: nothing was checked.'
      : `Checked ${r.checked} waiting referral${r.checked === 1 ? '' : 's'}: ${r.rewarded} rewarded, ${r.rejected} rejected, ${r.waiting} still waiting.` };
  }));
}

export async function saveCampaignAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(campaignInput, form, async input => { await saveCampaign(db(), actor, input, await requestContext()); return { ok: true, message: input.campaignId ? 'Campaign saved.' : 'Campaign created.' }; }));
}
export async function setCampaignActiveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(setCampaignActiveInput, form, async input => { await setCampaignActive(db(), actor, input, await requestContext()); return { ok: true, message: input.active ? 'Campaign active.' : 'Campaign paused.' }; }));
}
export async function saveBannerAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(bannerInput, form, async input => {
    await saveBanner(db(), actor, input, await requestContext());
    return { ok: true, message: input.active ? 'Banner saved and published (shown in the store while inside its dates).' : 'Banner saved as a draft (not shown in the store).' };
  }));
}
export async function setBannerActiveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(setBannerActiveInput, form, async input => { await setBannerActive(db(), actor, input, await requestContext()); return { ok: true, message: input.active ? 'Banner published.' : 'Banner taken down.' }; }));
}
export async function saveSegmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(segmentInput, form, async input => { await saveSegment(db(), actor, input, await requestContext()); return { ok: true, message: 'Segment saved.' }; }));
}
export async function deleteSegmentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(deleteSegmentInput, form, async input => { await deleteSegment(db(), actor, input, await requestContext()); return { ok: true, message: 'Segment deleted.' }; }));
}

/** Client change request: staff unsubscribe an address (for example when the person asks by email). */
export async function unsubscribeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(subscriberIdInput, form, async input => { await unsubscribeSubscriber(db(), actor, input, await requestContext()); return { ok: true, message: 'Unsubscribed.' }; }));
}
