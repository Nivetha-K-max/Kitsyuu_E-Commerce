import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { applyDuePriceChanges } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* ERP module 1 scheduled job: applies price changes whose time has come (each is also applied when staff open Pricing).
   Called by a scheduler with "Authorization: Bearer <CRON_SECRET or JOBS_SECRET>" (GET or POST). Answers 404 unless a
   secret of 32+ characters is configured and matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret =>
    !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret)));
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await applyDuePriceChanges(db())) }); }
  catch (e) { console.error('[jobs/apply-prices]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
