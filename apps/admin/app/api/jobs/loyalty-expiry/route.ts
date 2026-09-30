import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { expireLoyaltyPoints } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* Client change request (second pass), scheduled job: expires unused loyalty points whose expiry date has passed (only
   when Settings → Loyalty → "Points expire after" is set; points added without an expiry never expire).
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
  try { return NextResponse.json({ ok: true, ...(await expireLoyaltyPoints(db())) }); }
  catch (e) { console.error('[jobs/loyalty-expiry]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
