import { NextResponse, type NextRequest } from 'next/server';
import { checkCartAvailability } from '@kitsyuu/core';
import { db } from '@/lib/server';

/* 2026-10-01: a guest's browser cart checked against the stock now (sold out, fewer left, no longer sold). The store calls it
   when the cart is shown, every cart refresh interval and when the tab is shown again. Read-only: nothing is stored or
   reserved; checkout always checks again on the server. Answers only about products on sale (public data). */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { lines?: unknown } | null;
    const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 50).filter((l): l is { productId: string; size: string; colour?: string | null; qty: number } =>
      !!l && typeof l === 'object' && typeof (l as { productId?: unknown }).productId === 'string' && typeof (l as { size?: unknown }).size === 'string') : [];
    const result = lines.length ? await checkCartAvailability(db(), lines) : [];
    return NextResponse.json({ lines: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[api/cart/check]', e);
    // An optional background check: when stock cannot be read just now, say so without an HTTP error (the cart keeps the
    // catalogue's view; checkout always checks on the server).
    return NextResponse.json({ lines: null, unavailable: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
