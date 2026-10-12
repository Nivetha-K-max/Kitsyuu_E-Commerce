'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { consumeMaterialInput, createProductionBatchInput, createProductionOrderInput, linkProductionPoInput, milestoneDeleteInput, milestoneDoneInput, milestoneInput, productionInputInput, productionStatusInput, qualityCheckInput, raiseProductionPoInput, type ActionState } from '@kitsyuu/contracts';
import { consumeMaterial, createProductionOrder, createProductionOrders, deleteMilestone, linkProductionToPurchaseOrder, saveMilestone, setMilestoneDone, raisePurchaseOrderForProduction, recordQualityCheck, setProductionInput, setProductionStatus } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => {
  revalidatePath('/production'); if (id) revalidatePath(`/production/${id}`);
  revalidatePath('/materials'); revalidatePath('/inventory'); revalidatePath('/products', 'layout');
};

export async function createProductionOrderAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(createProductionOrderInput, form, async input => { id = (await createProductionOrder(db(), actor, input, await requestContext())).id; });
  if (id) { refresh(); redirect(`/production/${id}`); }
  return r;
}
/** 2026-10-01: several sizes planned at once, as one batch. */
export async function createProductionBatchAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(createProductionBatchInput, form, async input => {
    const res = await createProductionOrders(db(), actor, input, await requestContext());
    return { ok: true, message: `Planned ${res.orders.length} production order${res.orders.length === 1 ? '' : 's'} (${res.orders.map(o => o.number).join(', ')})${res.batchRef ? `, batch ${res.batchRef}` : ''}.` };
  });
  if (r.ok) refresh();
  return r;
}
/** 2026-10-01: link the selected production orders to a purchase order (a record only; no stock moves). */
export async function linkProductionPoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  if (!form.getAll('productionOrderIds[]').length) return { ok: false, message: 'Select at least one production order.' };
  const r = await handle(linkProductionPoInput, form, async input => {
    const res = await linkProductionToPurchaseOrder(db(), actor, input, await requestContext());
    return { ok: true, message: `Linked ${res.linked} to ${res.poNumber}${res.already ? ` (${res.already} already linked)` : ''}.` };
  });
  if (r.ok) { refresh(); revalidatePath('/purchase-orders', 'layout'); }
  return r;
}
export async function productionInputAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(productionInputInput, form, async input => { await setProductionInput(db(), actor, input, await requestContext()); return { ok: true, message: 'Material planned.' }; });
  if (r.ok) refresh(String(form.get('productionOrderId')));
  return r;
}
export async function consumeMaterialAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  // What the page showed as already used of the chosen material on this order (used:<materialId>; none shown = 0). Core compares
  // it under its lock, so a use entered on an out-of-date page or sent twice is refused, not recorded again.
  const r = await handle(consumeMaterialInput, form, async input => {
    const v = form.get(`used:${input.materialId}`);
    if (v !== null && !(typeof v === 'string' && /^\d{1,10}(\.\d{1,3})?$/.test(v))) return { ok: false, message: 'This page is out of date. Reload it and record the material again.' };
    const res = await consumeMaterial(db(), actor, { ...input, expectedConsumed: v === null ? 0 : Number(v) }, await requestContext());
    return { ok: true, message: `Recorded. Material left in stock: ${res.materialBalance}.` };
  });
  if (r.ok) refresh(String(form.get('productionOrderId')));
  return r;
}
export async function productionStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(productionStatusInput, form, async input => {
    await setProductionStatus(db(), actor, input, await requestContext());
    return { ok: true, message: input.status === 'in_progress' ? 'Production started.' : 'Production order cancelled.' };
  });
  if (r.ok) refresh(String(form.get('productionOrderId')));
  return r;
}
export async function qualityCheckAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(qualityCheckInput, form, async input => {
    const res = await recordQualityCheck(db(), actor, input, await requestContext());
    return { ok: true, message: input.passed > 0 ? `Completed. ${input.passed} piece(s) added to stock (now ${res.stockAfter}).` : 'Completed. No pieces passed, so stock is unchanged.' };
  });
  if (r.ok) refresh(String(form.get('productionOrderId')));
  return r;
}

/** Client change request: raise a draft purchase order for this production order's material shortfall (linked to it). */
export async function raiseProductionPoAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let poId = '';
  const r = await handle(raiseProductionPoInput, form, async input => { poId = (await raisePurchaseOrderForProduction(db(), actor, input, await requestContext())).id; });
  if (poId) { refresh(String(form.get('productionOrderId') ?? '')); revalidatePath('/purchase-orders'); redirect(`/purchase-orders/${poId}`); }
  return r;
}

/* Production calendar (2026-10-12): milestones and tasks. Permission, the one-of-each rule and the audit are the core's. */
const refreshCalendar = () => revalidatePath('/production', 'layout');
export async function saveMilestoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(milestoneInput, form, async input => {
    const m = await saveMilestone(db(), actor, input, await requestContext());
    return { ok: true, message: input.milestoneId ? (m.changed ? 'Saved.' : 'No changes.') : 'Added to the calendar.' };
  });
  if (r.ok) refreshCalendar();
  return r;
}
export async function milestoneDoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(milestoneDoneInput, form, async input => {
    await setMilestoneDone(db(), actor, input, await requestContext());
    return { ok: true, message: input.done ? 'Marked done.' : 'Marked not done.' };
  });
  if (r.ok) refreshCalendar();
  return r;
}
export async function deleteMilestoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(milestoneDeleteInput, form, async input => {
    await deleteMilestone(db(), actor, input, await requestContext());
    return { ok: true, message: 'Removed.' };
  });
  if (r.ok) refreshCalendar();
  return r;
}
