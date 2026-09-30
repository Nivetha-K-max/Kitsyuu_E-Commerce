'use server';
import { revalidatePath } from 'next/cache';
import { announcementInput, DomainError, type ActionState } from '@kitsyuu/contracts';
import { BRAND_COPY_FIELDS, saveAnnouncement, saveBrandCopy, unpublishAnnouncement } from '@kitsyuu/core';
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

/** Client change request ("Japan → India: No"): publishes the brand wording. Empty fields keep today's text. */
export async function saveBrandCopyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  try {
    const input = Object.fromEntries(BRAND_COPY_FIELDS.map(f => [f.key, String(form.get(f.key) ?? '')]));
    const r = await saveBrandCopy(db(), actor, input, await requestContext());
    revalidatePath('/content');
    return { ok: true, message: r.customFields ? `Published: ${r.customFields} field(s) changed from the original wording. The store updates within a minute.` : 'Published: every field shows the original wording.' };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    throw e;
  }
}
