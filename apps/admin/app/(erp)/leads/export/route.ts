import { can } from '@kitsyuu/auth';
import { LEAD_STAGE_LABEL, exportLeads, type LeadStage } from '@kitsyuu/core';
import { currentActor, db, requestContext } from '@/lib/server';

/* Leads as a spreadsheet (CSV that Excel opens), 2026-10-12. Needs leads.read; the export is audited in the core.
   Cells that could be read as a formula are neutralised, as in the other exports. */
const cell = (v: unknown) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export async function GET() {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  if (!can(actor, 'leads.read')) return new Response('Not permitted.', { status: 403 });
  const rows = await exportLeads(db(), actor, await requestContext());
  const lines = [['name', 'phone', 'email', 'interest', 'timeline', 'source', 'stage', 'disqualified_because', 'added', 'stage_since'],
    ...rows.map(r => [r.name, r.phone, r.email, r.interest, r.timeline, r.source, LEAD_STAGE_LABEL[r.stage as LeadStage], r.disqualify_reason, new Date(r.created_at as Date).toISOString(), new Date(r.stage_changed_at as Date).toISOString()])];
  return new Response('﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n', { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kitsyuu-leads.csv"',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(rows.length) } });
}
