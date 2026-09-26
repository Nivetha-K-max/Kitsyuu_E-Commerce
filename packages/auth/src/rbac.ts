/* Permission checks. Code asks can(actor, 'inventory.adjust'); it never checks role names or email addresses.
   Which roles hold which permissions is data (role_permissions), loaded fresh for every request. */
import type { Queryable } from '@kitsyuu/db';
import { ForbiddenError } from '@kitsyuu/contracts';

export interface StaffPrincipal {
  staffId: string;
  email: string;
  fullName: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
}

export function can(actor: { permissions: ReadonlySet<string> } | null | undefined, code: string): boolean {
  return !!actor && actor.permissions.has(code);
}

export function requirePermission(actor: { permissions: ReadonlySet<string> } | null | undefined, code: string): void {
  if (!can(actor, code)) throw new ForbiddenError();
}

/** Union of the permissions of every role the staff member holds. */
export async function loadPermissions(q: Queryable, staffId: string): Promise<Set<string>> {
  const rows = await q.selectFrom('staff_user_roles as sur')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'sur.role_id')
    .select('rp.permission_code')
    .distinct()
    .where('sur.staff_user_id', '=', staffId)
    .execute();
  return new Set(rows.map(r => r.permission_code));
}
