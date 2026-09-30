import { attentionSummary, sweepConditionAlertsThrottled, unreadNotifications } from '@kitsyuu/core';
import { currentActor, db } from '@/lib/server';

/* The top bar's "needs attention" counts for the signed-in staff member (read-only; each count is permission-checked
   in core), plus their unread notifications (only kinds their permissions allow). Fetched by the bell after the page has
   rendered, so it never slows a page down. Condition alerts (low stock, locked sign-ins) are swept here, at most every
   few minutes. */
export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'unauthorised' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  await sweepConditionAlertsThrottled(db());
  const [items, unread] = await Promise.all([attentionSummary(db(), actor), unreadNotifications(db(), actor, 5)]);
  return Response.json({ items, unread }, { headers: { 'Cache-Control': 'no-store' } });
}
