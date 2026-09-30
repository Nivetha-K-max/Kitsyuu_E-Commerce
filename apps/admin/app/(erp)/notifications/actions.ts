'use server';
import { revalidatePath } from 'next/cache';
import { markNotificationsInput, type ActionState } from '@kitsyuu/contracts';
import { markNotificationsRead } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requireActor } from '@/lib/server';

export async function markNotificationsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(markNotificationsInput, form, async input => {
    const n = await markNotificationsRead(db(), actor, input);
    return { ok: true, message: n ? `${n} marked as read.` : 'Nothing new to mark.' };
  });
  if (r.ok) revalidatePath('/notifications');
  return r;
}
