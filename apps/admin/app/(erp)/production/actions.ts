'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { consumeMaterialInput, createProductionBatchInput, createProductionOrderInput, linkProductionPoInput, productionInputInput, productionStatusInput, qualityCheckInput, raiseProductionPoInput, type ActionState } from '@kitsyuu/contracts';
import { consumeMaterial, createProductionOrder, createProductionOrders, linkProductionToPurchaseOrder, raisePurchaseOrderForProduction, recordQualityCheck, setProductionInput, setProductionStatus } from '@kitsyuu/core';
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
  const r = await handle(consumeMaterialInput, form, async input => {
    const res = await consumeMaterial(db(), actor, input, await requestContext());
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
