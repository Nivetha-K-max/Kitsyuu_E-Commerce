import { can } from '@kitsyuu/auth';
import { orderListQuery } from '@kitsyuu/contracts';
import { exportOrders } from '@kitsyuu/core';
import { currentActor, db, requestContext } from '@/lib/server';

/* The order list (same filters as /orders) as a CSV download: one row per order, no addresses or payment references.
   Needs orders.read; capped at ORDER_EXPORT_MAX_ROWS rows and recorded in the audit log. */
export async function GET(request: Request) {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  if (!can(actor, 'orders.read')) return new Response('Not permitted.', { status: 403 });
  const sp = new URL(request.url).searchParams;
  const parsed = orderListQuery.safeParse({ q: sp.get('q') ?? undefined, status: sp.get('status') ?? undefined, payment: sp.get('payment') ?? undefined,
    from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, packing: sp.get('packing') ?? undefined, view: sp.get('view') ?? undefined });
  if (!parsed.success) return new Response('Invalid filters.', { status: 400 });
  const { page: _page, ...filters } = parsed.data;
  const r = await exportOrders(db(), actor, filters, await requestContext());
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + r.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kitsyuu-orders-${stamp}.csv"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(r.rows), 'X-Export-Truncated': r.truncated ? 'yes' : 'no',
    },
  });
}
