import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { processReferralRewards } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* Referrals (2026-10-12), scheduled job: looks at the pending referrals and gives both customers their reward coupon
   once the referred customer's first eligible order has been delivered and its return period is over. Does nothing while
   referrals are switched off or no reward amount is set. Safe to call as often as wanted.
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
  try { return NextResponse.json({ ok: true, ...(await processReferralRewards(db())) }); }
  catch (e) { console.error('[jobs/referral-rewards]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
