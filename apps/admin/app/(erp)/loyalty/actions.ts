'use server';
import { revalidatePath } from 'next/cache';
import { loyaltyAdjustInput, loyaltyImportInput, type ActionState } from '@kitsyuu/contracts';
import { adjustLoyaltyPoints, importLoyaltyPoints } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

/* Client change request, second pass: loyalty points. Staff add or remove points with a reason, and import opening
   balances from a file; every change is a ledger row and an audit record (core/loyalty.ts). */
export async function adjustPointsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(loyaltyAdjustInput, form, async input => {
    const res = await adjustLoyaltyPoints(db(), actor, input, await requestContext());
    return { ok: true, message: `${input.points > 0 ? 'Added' : 'Removed'} ${Math.abs(input.points)} points. Balance: ${res.balance}.` };
  });
  if (r.ok) { revalidatePath('/loyalty'); revalidatePath('/customers', 'layout'); }
  return r;
}

export async function importPointsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const file = form.get('file');
  const text = typeof file === 'object' && file && 'text' in file && (file as File).size > 0 ? await (file as File).text() : String(form.get('text') ?? '');
  const data = new FormData();
  data.set('text', text); data.set('reason', String(form.get('reason') ?? ''));
  const r = await handle(loyaltyImportInput, data, async input => {
    const res = await importLoyaltyPoints(db(), actor, input, await requestContext());
    return { ok: true, message: `Imported ${res.points} points for ${res.customers} customer(s).` };
  });
  if (r.ok) { revalidatePath('/loyalty'); revalidatePath('/customers', 'layout'); }
  return r;
}
