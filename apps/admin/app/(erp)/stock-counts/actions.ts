'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { openStockCountInput, stockCountIdInput, type ActionState } from '@kitsyuu/contracts';
import { cancelStockCount, openStockCount, postStockCount, recordCounts } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

const refresh = (id?: string) => { revalidatePath('/stock-counts'); if (id) revalidatePath(`/stock-counts/${id}`); revalidatePath('/inventory'); revalidatePath('/products', 'layout'); };

export async function openStockCountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  let id = '';
  const r = await handle(openStockCountInput, form, async input => { id = (await openStockCount(db(), actor, input, await requestContext())).id; });
  if (id) { refresh(); redirect(`/stock-counts/${id}`); }
  return r;
}

/** One number field per line, named counted:<lineId>; empty fields are left as they are. */
export async function recordCountsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const entries = [...form.entries()].filter(([k, v]) => k.startsWith('counted:') && String(v).trim() !== '');
  const bad = entries.find(([, v]) => !/^\d{1,6}$/.test(String(v).trim()));
  if (bad) return { ok: false, message: 'Counts must be whole numbers, 0 or more.' };
  const r = await handle(stockCountIdInput, form, async input => {
    const res = await recordCounts(db(), actor, { stockCountId: input.stockCountId, lines: entries.map(([k, v]) => ({ lineId: k.slice(8), counted: Number(String(v).trim()) })) }, await requestContext());
    return { ok: true, message: `${res.saved} count(s) saved.` };
  });
  if (r.ok) refresh(String(form.get('stockCountId')));
  return r;
}

export async function postStockCountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(stockCountIdInput, form, async input => {
    const res = await postStockCount(db(), actor, input, await requestContext());
    return { ok: true, message: `Posted: ${res.counted} size(s) counted, ${res.adjusted} adjusted.` };
  });
  if (r.ok) refresh(String(form.get('stockCountId')));
  return r;
}

export async function cancelStockCountAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(stockCountIdInput, form, async input => { await cancelStockCount(db(), actor, input, await requestContext()); return { ok: true, message: 'Count cancelled. Stock was not changed.' }; });
  if (r.ok) refresh(String(form.get('stockCountId')));
  return r;
}
