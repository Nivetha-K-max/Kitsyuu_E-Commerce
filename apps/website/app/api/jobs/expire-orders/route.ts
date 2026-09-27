import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { expireUnpaidOrders } from '@kitsyuu/core';
import { paymentProviders } from '@/lib/commerce';
import { db } from '@/lib/server';

/* Scheduled job: cancels unpaid orders whose payment hold time (checkout.payment_window_minutes, if configured) has passed
   and returns their stock. Called by a scheduler with "Authorization: Bearer <JOBS_SECRET>"; disabled when JOBS_SECRET is
   not set. The same sweep also runs for a customer before each of their checkouts. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const secret = process.env.JOBS_SECRET;
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return !!secret && secret.length >= 32 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try { return NextResponse.json({ ok: true, ...(await expireUnpaidOrders(db(), paymentProviders(), { limit: 100 })) }); }
  catch (e) { console.error('[jobs/expire-orders]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
