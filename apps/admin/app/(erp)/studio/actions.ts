'use server';
/* Content studio (2026-10-12): ideas, the content pipeline and its calendar. Permissions, "what a stage needs", the
   one-stage-at-a-time rule, approval and the audit are the core's. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ideaIdInput, ideaInput, ideaStatusInput, pieceDateInput, pieceDecisionInput, pieceIdInput, pieceInput, pieceMoveInput, type ActionState } from '@kitsyuu/contracts';
import { PIECE_STAGE_LABEL, decidePieceMove, deleteIdea, deletePiece, planIdea, requestPieceMove, saveIdea, savePiece, setIdeaStatus, setPieceDate } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/studio', 'layout'); return r; };

export async function saveIdeaAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ideaInput, form, async input => {
    const r = await saveIdea(db(), actor, input, await requestContext());
    return { ok: true, message: input.ideaId ? (r.changed ? 'Saved.' : 'No changes.') : 'Idea added.' };
  }));
}
export async function ideaStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ideaStatusInput, form, async input => { await setIdeaStatus(db(), actor, input, await requestContext()); return { ok: true, message: 'Moved.' }; }));
}
export async function deleteIdeaAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ideaIdInput, form, async input => { await deleteIdea(db(), actor, input, await requestContext()); return { ok: true, message: 'Idea removed.' }; }));
}
export async function planIdeaAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(ideaIdInput, form, async input => { await planIdea(db(), actor, input, await requestContext()); return { ok: true, message: 'Sent to planning: it is now in the Idea column there.' }; }));
}

export async function savePieceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(pieceInput, form, async input => {
    const r = await savePiece(db(), actor, input, await requestContext());
    return { ok: true, message: input.pieceId ? (r.changed ? 'Saved.' : 'No changes.') : 'Added to the Idea column.' };
  }));
}
export async function requestPieceMoveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(pieceMoveInput, form, async input => {
    const r = await requestPieceMove(db(), actor, input, await requestContext());
    return { ok: true, message: r.waiting ? 'Sent for approval.' : `Moved to ${PIECE_STAGE_LABEL[r.stage]}.` };
  }));
}
export async function decidePieceMoveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(pieceDecisionInput, form, async input => {
    const r = await decidePieceMove(db(), actor, input, await requestContext());
    return { ok: true, message: r.approved ? `Approved: moved to ${PIECE_STAGE_LABEL[r.stage]}.` : 'Sent back.' };
  }));
}
export async function pieceDateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(pieceDateInput, form, async input => {
    const r = await setPieceDate(db(), actor, input, await requestContext());
    return { ok: true, message: r.changed ? (input.targetOn ? `Planned for ${input.targetOn}.` : 'Date removed.') : 'No change.' };
  }));
}
export async function deletePieceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(pieceIdInput, form, async input => { await deletePiece(db(), actor, input, await requestContext()); return { ok: true, message: 'Removed.' }; });
  if (r.ok) { revalidatePath('/studio', 'layout'); redirect('/studio/planning'); }
  return r;
}
