/* Audit writer. Call it with the SAME transaction as the change it records, so the change and its audit row are
   committed together or not at all. audit_logs is append-only in the database (grants + triggers). */
import type { AuditActorType } from './schema.ts';
import type { Queryable } from './index.ts';

export interface AuditEntry {
  actorType: AuditActorType;
  staffId?: string | null;
  customerId?: string | null;
  action: string;             // e.g. 'staff.invite', 'role.update'
  entityType: string;         // e.g. 'staff_users'
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.insertInto('audit_logs').values({
    actor_type: e.actorType,
    staff_id: e.staffId ?? null,
    customer_id: e.customerId ?? null,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId ?? null,
    before_data: e.before === undefined ? null : JSON.stringify(e.before),
    after_data: e.after === undefined ? null : JSON.stringify(e.after),
    request_id: e.requestId ?? null,
    ip: e.ip ?? null,
    user_agent: e.userAgent ? e.userAgent.slice(0, 400) : null,
    metadata: JSON.stringify(e.metadata ?? {}),
  }).execute();
}
