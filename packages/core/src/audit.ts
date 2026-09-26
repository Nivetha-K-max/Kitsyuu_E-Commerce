/* Reading the audit log (writing is recordAudit in @kitsyuu/db, always inside the transaction of the change). */
import { sql, type Db } from '@kitsyuu/db';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { AuditQuery } from '@kitsyuu/contracts';

export const AUDIT_PAGE_SIZE = 50;

export async function listAudit(db: Db, actor: StaffPrincipal, query: AuditQuery) {
  requirePermission(actor, 'audit.read');
  let q = db.selectFrom('audit_logs as a').leftJoin('staff_users as s', 's.id', 'a.staff_id')
    .select(['a.id', 'a.occurred_at', 'a.actor_type', 'a.action', 'a.entity_type', 'a.entity_id', 'a.before_data', 'a.after_data', 'a.ip', 'a.metadata', 's.email as staff_email']);
  if (query.action) q = q.where('a.action', '=', query.action);
  if (query.entityType) q = q.where('a.entity_type', '=', query.entityType);
  if (query.staffId) q = q.where('a.staff_id', '=', query.staffId);
  const rows = await q.orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc')
    .limit(AUDIT_PAGE_SIZE + 1).offset((query.page - 1) * AUDIT_PAGE_SIZE).execute();
  const actions = await db.selectFrom('audit_logs').select('action').distinct().orderBy('action').execute();
  const entityTypes = await db.selectFrom('audit_logs').select('entity_type').distinct().orderBy('entity_type').execute();
  return {
    rows: rows.slice(0, AUDIT_PAGE_SIZE).map(r => ({
      id: r.id, occurredAt: r.occurred_at as Date, actorType: r.actor_type, staffEmail: r.staff_email, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, before: r.before_data, after: r.after_data, ip: r.ip, metadata: r.metadata,
    })),
    hasNext: rows.length > AUDIT_PAGE_SIZE,
    actions: actions.map(a => a.action),
    entityTypes: entityTypes.map(e => e.entity_type),
  };
}

export async function recentAudit(db: Db, actor: StaffPrincipal, limit = 8) {
  requirePermission(actor, 'audit.read');
  return db.selectFrom('audit_logs as a').leftJoin('staff_users as s', 's.id', 'a.staff_id')
    .select(['a.id', 'a.occurred_at', 'a.action', 'a.entity_type', 'a.entity_id', 's.email as staff_email', 'a.actor_type'])
    .orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(limit).execute();
}

export async function auditCount(db: Db): Promise<number> {
  return (await db.selectFrom('audit_logs').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()).n;
}
