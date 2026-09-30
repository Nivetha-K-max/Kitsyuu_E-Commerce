import { DomainError, ForbiddenError } from '@kitsyuu/contracts';
import { exportFinance, FINANCE_EXPORTS, type FinanceExport } from '@kitsyuu/core';
import { currentActor, db, requestContext } from '@/lib/server';

/* ERP module 6: finance data as CSV (finance.read). Recorded in the audit log. */
export async function GET(request: Request) {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  const sp = new URL(request.url).searchParams;
  const kind = sp.get('kind') as FinanceExport;
  if (!(FINANCE_EXPORTS as readonly string[]).includes(kind)) return new Response('Unknown export.', { status: 400 });
  try {
    const r = await exportFinance(db(), actor, kind, { from: sp.get('from') ?? '', to: sp.get('to') ?? '' }, await requestContext());
    return new Response('﻿' + r.csv, { headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kitsyuu-finance-${kind}-${sp.get('from')}-to-${sp.get('to')}.csv"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(r.rows) } });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response('Not permitted.', { status: 403 });
    if (e instanceof DomainError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
