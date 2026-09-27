import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { expireUnpaidOrders } from '@kitsyuu/core';
import { paymentProviders } from '@/lib/commerce';
import { db } from '@/lib/server';

/* Scheduled job: cancels unpaid orders whose payment hold time (checkout.payment_window_minutes, 10 days) has passed and
   returns their stock. The same sweep also runs for a customer before each of their checkouts.
   Called daily by Vercel Cron (GET, "Authorization: Bearer <CRON_SECRET>", see vercel.json) or by any scheduler with
   POST and "Authorization: Bearer <JOBS_SECRET>". Answers 404 unless a secret of 32+ characters is configured and matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret =>
    !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret)));
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await expireUnpaidOrders(db(), paymentProviders(), { limit: 100 })) }); }
  catch (e) { console.error('[jobs/expire-orders]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
