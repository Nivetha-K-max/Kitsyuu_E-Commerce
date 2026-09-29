import { attentionSummary } from '@kitsyuu/core';
import { currentActor, db } from '@/lib/server';

/* The top bar's "needs attention" counts for the signed-in staff member (read-only; each count is permission-checked
   in core). Fetched by the bell after the page has rendered, so it never slows a page down. */
export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'unauthorised' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const items = await attentionSummary(db(), actor);
  return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
}
