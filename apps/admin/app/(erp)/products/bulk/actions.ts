'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { bulkDraftIdInput, bulkDraftNoteInput, bulkEditInput, type ActionState } from '@kitsyuu/contracts';
import { applyBulkEditDraft, cancelBulkEditDraft, createBulkEditDraft } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

/* Client change request: a bulk change to the selected products. 2026-10-01: it is saved as a draft change set first
   (nothing changes), reviewed on its own page (old → new per product) and only then applied. */
export async function bulkEditAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  // Say plainly what is missing (the product boxes are not fields that can show an error of their own).
  if (!form.getAll('productIds[]').length) return { ok: false, message: 'Select at least one product.' };
  if (!form.get('action')) return { ok: false, message: 'Choose what to change.' };
  let id: string | null = null;
  const r = await handle(bulkEditInput, form, async input => {
    const { productIds, ...change } = input;
    const note = bulkDraftNoteInput.safeParse({ note: form.get('note') ?? undefined });
    const d = await createBulkEditDraft(db(), actor, { productIds, changes: [change], note: note.success ? note.data.note : null }, await requestContext());
    id = d.id;
    return { ok: true, message: `${d.number} saved for review.` };
  });
  if (r.ok && id) { revalidatePath('/products/bulk', 'layout'); redirect(`/products/bulk/${id}`); }
  return r;
}

export async function applyBulkDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(bulkDraftIdInput, form, async input => {
    const res = await applyBulkEditDraft(db(), actor, input, await requestContext());
    const parts = [`${res.applied.length} changed`, ...(res.unchanged.length ? [`${res.unchanged.length} already so`] : []), ...(res.failed.length ? [`${res.failed.length} not changed (listed below)`] : [])];
    return { ok: res.failed.length === 0, message: `Applied: ${parts.join(', ')}.` };
  });
  revalidatePath('/products', 'layout');
  revalidatePath('/pricing', 'layout');
  return r;
}

export async function cancelBulkDraftAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(bulkDraftIdInput, form, async input => { await cancelBulkEditDraft(db(), actor, input, await requestContext()); return { ok: true, message: 'Bulk edit cancelled. Nothing was changed.' }; });
  revalidatePath('/products/bulk', 'layout');
  return r;
}
