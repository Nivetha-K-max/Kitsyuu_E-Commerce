import { can } from '@kitsyuu/auth';
import { exportSubscribers } from '@kitsyuu/core';
import { currentActor, db, requestContext } from '@/lib/server';

/* Client change request: subscribed addresses with their consent, as CSV (marketing.read + customers.read). Audited. */
const cell = (v: unknown) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export async function GET() {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  if (!can(actor, 'marketing.read') || !can(actor, 'customers.read')) return new Response('Not permitted.', { status: 403 });
  const rows = await exportSubscribers(db(), actor, await requestContext());
  const lines = [['email', 'signed_up', 'source', 'consent'], ...rows.map(r => [r.email, new Date(r.consented_at as Date).toISOString(), r.source, r.consent_text])];
  return new Response('﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n', { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kitsyuu-newsletter-subscribers.csv"',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Rows': String(rows.length) } });
}
