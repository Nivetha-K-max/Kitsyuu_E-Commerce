'use server';
import { revalidatePath } from 'next/cache';
import { bannerInput, campaignInput, deleteSegmentInput, segmentInput, setBannerActiveInput, setCampaignActiveInput, type ActionState } from '@kitsyuu/contracts';
import { deleteSegment, saveBanner, saveCampaign, saveSegment, setBannerActive, setCampaignActive } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/marketing', 'layout'); return r; };

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
