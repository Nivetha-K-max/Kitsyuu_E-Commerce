'use server';
import { revalidatePath } from 'next/cache';
import { sizeChartInput, type ActionState } from '@kitsyuu/contracts';
import { saveSizeChart } from '@kitsyuu/core';
import { handle } from '@/lib/actions';
import { db, requestContext, requireActor } from '@/lib/server';

export async function saveSizeChartAction(_: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const r = await handle(sizeChartInput, form, async input => {
    await saveSizeChart(db(), actor, input, await requestContext());
    return { ok: true, message: input.chartId ? 'Size chart saved.' : 'Size chart added.' };
  });
  if (r.ok) revalidatePath('/size-charts');
  return r;
}
