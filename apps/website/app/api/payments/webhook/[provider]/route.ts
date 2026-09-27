import { NextResponse, type NextRequest } from 'next/server';
import { handlePaymentWebhook } from '@kitsyuu/core';
import { paymentProvider } from '@/lib/commerce';
import { db } from '@/lib/server';

/* Payment provider notifications (webhooks), e.g. /api/payments/webhook/razorpay. The provider authenticates the request
   (signature over the raw body); each event is processed once. Answers carry no details. */
export const dynamic = 'force-dynamic';

/** Largest body accepted. Provider notifications are a few kilobytes. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/** The raw body as text, or null when it is larger than `limit` bytes. The request is refused on its Content-Length before
    anything is read, and a body without one (chunked) is read piece by piece and abandoned as soon as it passes the limit,
    so an oversized request is never held in memory. */
async function readBodyCapped(req: NextRequest, limit: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = paymentProvider();
  if (!provider || provider.code !== (await params).provider) return NextResponse.json({ ok: false }, { status: 404 });
  const raw = await readBodyCapped(req, MAX_WEBHOOK_BYTES);
  if (raw === null) return NextResponse.json({ ok: false }, { status: 413 });
  try {
    const r = await handlePaymentWebhook(db(), provider, raw, name => req.headers.get(name));
    return NextResponse.json({ ok: r.status === 200 }, { status: r.status });
  } catch (e) {
    console.error('[payments webhook]', e);
    return NextResponse.json({ ok: false }, { status: 500 });     // the provider retries later
  }
}
