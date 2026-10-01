import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { availableCarriers, syncShipmentTracking } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* 2026-10-01, scheduled job: asks couriers with a tracking API for the latest status of parcels on their way and records it
   on the shipment (what the customer sees). No courier API is connected yet, so it reports providers: 0 and changes nothing.
   "Authorization: Bearer <CRON_SECRET or JOBS_SECRET>" (GET or POST); 404 unless a 32+ character secret matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret =>
    !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret)));
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await syncShipmentTracking(db(), availableCarriers())) }); }
  catch (e) { console.error('[jobs/sync-tracking]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
