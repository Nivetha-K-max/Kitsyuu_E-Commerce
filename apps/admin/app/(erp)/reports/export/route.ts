import { can } from '@kitsyuu/auth';
import { DomainError, ForbiddenError } from '@kitsyuu/contracts';
import { exportReport, REPORTS, type ReportKind } from '@kitsyuu/core';
import { currentActor, db, requestContext } from '@/lib/server';

/* M16: a report as a CSV download (reports.read plus the report's own permission). Recorded in the audit log. */
export async function GET(request: Request) {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  if (!can(actor, 'reports.read')) return new Response('Not permitted.', { status: 403 });
  const sp = new URL(request.url).searchParams;
  const kind = sp.get('report') as ReportKind;
  if (!(REPORTS as readonly string[]).includes(kind)) return new Response('Unknown report.', { status: 400 });
  try {
    const r = await exportReport(db(), actor, kind, { from: sp.get('from') ?? '', to: sp.get('to') ?? '' }, await requestContext());
    return new Response('﻿' + r.csv, { headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kitsyuu-${kind}-${sp.get('from')}-to-${sp.get('to')}.csv"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(r.rows) } });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response('Not permitted.', { status: 403 });
    if (e instanceof DomainError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
