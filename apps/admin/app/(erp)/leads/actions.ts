'use server';
/* Leads pipeline (2026-10-12). Permission, the one-lead-per-phone rule, the stage check and the audit are the core's. */
import { revalidatePath } from 'next/cache';
import { leadInput, leadMoveInput, type ActionState } from '@kitsyuu/contracts';
import { LEAD_STAGE_LABEL, moveLead, saveLead, type LeadStage } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const done = (r: ActionState) => { if (r.ok) revalidatePath('/leads', 'layout'); return r; };

export async function saveLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(leadInput, form, async input => {
    const r = await saveLead(db(), actor, input, await requestContext());
    return { ok: true, message: input.leadId ? (r.changed ? 'Saved.' : 'No changes.') : `${input.name} added to New leads.` };
  }));
}

export async function moveLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return done(await handle(leadMoveInput, form, async input => {
    const r = await moveLead(db(), actor, input, await requestContext());
    return { ok: true, message: r.changed ? `Moved to ${LEAD_STAGE_LABEL[r.stage as LeadStage]}.` : 'Already there.' };
  }));
}
