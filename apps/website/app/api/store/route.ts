import { NextResponse } from 'next/server';
import { cartRefreshMinutes } from '@kitsyuu/core';
import { currentCustomer, db } from '@/lib/server';
import { customerStore } from '@/lib/store-state';

/* The signed-in customer's cart and wishlist for the store pages (which stay static). Guests get {status: 'guest'}: their
   cart and wishlist live in the browser until they log in. Never cached. */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await currentCustomer();
    // Client change request: how often the store re-syncs a cart that has items (default 30 minutes).
    const refreshMinutes = await cartRefreshMinutes(db()).catch(() => 30);
    const body = me ? { status: 'customer' as const, refreshMinutes, ...(await customerStore(me)) } : { status: 'guest' as const, refreshMinutes };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[api/store]', e);
    return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
