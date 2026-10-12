import { NextResponse } from 'next/server';
import { firstOrderOffer } from '@kitsyuu/core';
import { currentCustomer, db } from '@/lib/server';

/* The first-order offer for the store's welcome popup (2026-10-12). What the offer is comes from the business's own coupon
   (Pricing → Discounts) named in Configuration → Discounts; nothing is decided here or in the browser.
   - A signed-in customer gets the offer only when the server finds them eligible (no earlier successful order, coupon
     usable); otherwise nothing, so the popup does not appear for them.
   - A guest gets the offer to read. That is not a promise: whether they may use it is checked once they are signed in,
     at the cart and again when the order is placed.
   Takes no input (no customer id, no code, nothing to tamper with). Any error answers "no offer". Never cached. */
export const dynamic = 'force-dynamic';

export async function GET() {
  let body: { signedIn: boolean; offer: null | { code: string; kind: 'percent' | 'fixed'; value: number; minOrderPaise: number | null; maxDiscountPaise: number | null; endsAt: string | null } } = { signedIn: false, offer: null };
  try {
    const me = await currentCustomer();
    const o = await firstOrderOffer(db(), me?.customerId ?? null);
    body = { signedIn: !!me, offer: o && { code: o.code, kind: o.kind, value: o.value, minOrderPaise: o.minOrderPaise, maxDiscountPaise: o.maxDiscountPaise, endsAt: o.endsAt ? o.endsAt.toISOString() : null } };
  } catch (e) {
    console.error('[api/offer]', (e as Error).message);       // database unreachable or anything else: no offer is shown
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
