'use server';
import { revalidatePath } from 'next/cache';
import { announcementInput, type ActionState } from '@kitsyuu/contracts';
import { saveAnnouncement, unpublishAnnouncement } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function saveAnnouncementAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(announcementInput, form, async input => {
    await saveAnnouncement(db(), actor, input, await requestContext());
    return { ok: true, message: input.publish ? 'Published: the store shows it within a minute.' : 'Draft saved (not shown in the store).' };
  });
  if (r.ok) revalidatePath('/content');
  return r;
}

export async function unpublishAnnouncementAction(_: ActionState, form: FormData): Promise<ActionState> {
  void form;
  const actor = await requireActor();
  try { await unpublishAnnouncement(db(), actor, await requestContext()); }
  catch (e) { if (e && typeof e === 'object' && 'digest' in e) throw e; return { ok: false, message: 'Something went wrong. Nothing was changed.' }; }
  revalidatePath('/content');
  return { ok: true, message: 'Taken down: the store no longer shows it.' };
}
