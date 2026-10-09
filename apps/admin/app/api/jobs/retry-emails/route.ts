import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { retryOrderEmails } from '@kitsyuu/core';
import { db, mailer } from '@/lib/server';

/* Scheduled job (2026-10-08): sends again the order emails that failed (up to 5 attempts each, further apart every time,
   within 72 hours) and the order confirmations that were never attempted. Run it every 5 to 10 minutes. Each email is
   still sent once: every send goes through the transactional email service. The answer holds counts only (no addresses).
   Called by a scheduler with "Authorization: Bearer <CRON_SECRET or JOBS_SECRET>" (GET or POST). Answers 404 unless a
   secret of 32+ characters is configured and matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  // Only "Authorization: Bearer <secret>": the bare secret, another scheme, a query parameter or a body are not accepted.
  const given = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret =>
    !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret)));
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await retryOrderEmails(db(), mailer(), { storeUrl: process.env.STORE_URL || null })) }); }
  catch (e) { console.error('[jobs/retry-emails]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
