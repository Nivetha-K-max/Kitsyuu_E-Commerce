'use server';
import { revalidatePath } from 'next/cache';
import { bulkEditInput, type ActionState } from '@kitsyuu/contracts';
import { bulkEditProducts } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

/* Client change request: one bulk change to the selected products. Each product is checked on its own; the message lists
   what changed, what was already so, and every product that was not changed with the reason. */
export async function bulkEditAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  // Say plainly what is missing (the product boxes are not fields that can show an error of their own).
  if (!form.getAll('productIds[]').length) return { ok: false, message: 'Select at least one product.' };
  if (!form.get('action')) return { ok: false, message: 'Choose what to change.' };
  const r = await handle(bulkEditInput, form, async input => {
    const res = await bulkEditProducts(db(), actor, input, await requestContext());
    const names = new Map((await db().selectFrom('products').select(['id', 'name']).where('id', 'in', input.productIds).execute()).map(p => [p.id, p.name]));
    const parts = [`${res.done.length} changed`, ...(res.unchanged.length ? [`${res.unchanged.length} already so`] : [])];
    const why = res.failed.map(f => `${names.get(f.productId) ?? f.productId}: ${f.reason}`).join(' · ');
    return { ok: res.failed.length === 0, message: `${parts.join(', ')}.${res.failed.length ? ` Not changed (${res.failed.length}): ${why}` : ''}` };
  });
  revalidatePath('/products', 'layout');
  revalidatePath('/pricing', 'layout');
  return r;
}
