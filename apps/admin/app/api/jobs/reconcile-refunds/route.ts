import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { checkPendingRefunds } from '@/lib/payments';

/* 2026-10-14, scheduled job: settles provider refunds left 'pending' from what the payment provider reports now (read only:
   it never asks for a refund, so it cannot refund twice). Refunds it cannot match exactly are left pending and raise a staff
   alert. With no refund provider configured it does nothing (provider: false). Run it every 10 to 15 minutes. The answer
   holds counts only. "Authorization: Bearer <CRON_SECRET or JOBS_SECRET>" (GET or POST); 404 unless a 32+ character
   secret matches. */
export const dynamic = 'force-dynamic';

function authorised(req: NextRequest): boolean {
  const given = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  return [process.env.CRON_SECRET, process.env.JOBS_SECRET].some(secret => {
    if (!secret || secret.length < 32) return false;
    const a = Buffer.from(given), b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function run(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ ok: false }, { status: 404 });
  try {
    const r = await checkPendingRefunds();
    if (!r) return NextResponse.json({ ok: true, provider: false });
    const { refundedReturnIds, ...counts } = r;
    return NextResponse.json({ ok: true, provider: true, ...counts, returnsRefunded: refundedReturnIds.length });
  } catch (e) { console.error('[jobs/reconcile-refunds]', e); return NextResponse.json({ ok: false }, { status: 500 }); }
}
export const GET = run;
export const POST = run;
