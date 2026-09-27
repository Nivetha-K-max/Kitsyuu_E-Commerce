import { NextResponse, type NextRequest } from 'next/server';
import { handlePaymentWebhook } from '@kitsyuu/core';
import { paymentProvider } from '@/lib/commerce';
import { db } from '@/lib/server';

/* Payment provider notifications (webhooks), e.g. /api/payments/webhook/razorpay. The provider authenticates the request
   (signature over the raw body); each event is processed once. Answers carry no details. */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = paymentProvider();
  if (!provider || provider.code !== (await params).provider) return NextResponse.json({ ok: false }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 256 * 1024) return NextResponse.json({ ok: false }, { status: 413 });
  try {
    const r = await handlePaymentWebhook(db(), provider, raw, name => req.headers.get(name));
    return NextResponse.json({ ok: r.status === 200 }, { status: r.status });
  } catch (e) {
    console.error('[payments webhook]', e);
    return NextResponse.json({ ok: false }, { status: 500 });     // the provider retries later
  }
}
