import { pingDatabase } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* Health check for monitoring (M9): 200 when the admin app can reach its database, 503 otherwise. Public and cheap;
   it reveals only up/down and latency, never configuration or data. */
export const dynamic = 'force-dynamic';

export async function GET() {
  let database: Awaited<ReturnType<typeof pingDatabase>>;
  try { database = await pingDatabase(db()); } catch { database = { ok: false, latencyMs: null, dbTime: null }; }
  return Response.json({ ok: database.ok, app: 'admin', database: database.ok ? 'up' : 'down', latencyMs: database.latencyMs },
    { status: database.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
