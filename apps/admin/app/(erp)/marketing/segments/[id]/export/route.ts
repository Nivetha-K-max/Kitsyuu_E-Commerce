import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getSegment } from '@kitsyuu/core';
import { recordAudit } from '@kitsyuu/db';
import { currentActor, db, requestContext } from '@/lib/server';

/* ERP module 4: a segment's customers as CSV (marketing.read + customers.read, since it holds contact details). Audited. */
const cell = (v: unknown) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor) return new Response('Sign in first.', { status: 401 });
  if (!can(actor, 'marketing.read') || !can(actor, 'customers.read')) return new Response('Not permitted.', { status: 403 });
  const { id } = await params;
  try {
    const { segment, members } = await getSegment(db(), actor, id);
    const lines = [['email', 'name', 'paid_orders', 'spent_inr', 'last_order', 'joined'],
      ...members.rows.map(m => [m.email, m.full_name ?? '', m.orders, (m.spent_paise / 100).toFixed(2), m.last_order_at ? new Date(m.last_order_at).toISOString() : '', new Date(m.created_at as Date).toISOString()])];
    const ctx = await requestContext();
    await db().transaction().execute(tx => recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'segment.export', entityType: 'customer_segments', entityId: id,
      metadata: { rows: members.rows.length }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null }));
    return new Response('﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n', { headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kitsyuu-segment-${segment.name.replace(/[^\w-]+/g, '-').toLowerCase()}.csv"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (e) {
    if (e instanceof NotFoundError) return new Response('Not found.', { status: 404 });
    throw e;
  }
}
