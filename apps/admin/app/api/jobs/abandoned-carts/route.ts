import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { sendAbandonedCartReminders } from '@kitsyuu/core';
import { db, mailer } from '@/lib/server';

/* 2026-10-01, scheduled job: sends the due "your cart is waiting" emails (one per cart; only with the switch
   Settings → Customer emails → "Automatic your-cart-is-waiting email" on and a real email provider configured). The delay is
   ABANDONED_CART_DELAY_MINUTES (45 unless set). Run it every 15 minutes or so from a scheduler, with
   "Authorization: Bearer <CRON_SECRET or JOBS_SECRET>" (GET or POST). Answers 404 unless a 32+ character secret matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret =>
    !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret)));
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await sendAbandonedCartReminders(db(), mailer(), { storeUrl: process.env.STORE_URL || null })) }); }
  catch (e) { console.error('[jobs/abandoned-carts]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
