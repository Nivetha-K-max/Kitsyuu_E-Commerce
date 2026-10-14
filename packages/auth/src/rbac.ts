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
  /** 2026-10-14: the locations (branches) this staff member may work at; null or absent = every location. */
  locationIds?: ReadonlySet<string> | null;
}

type Scoped = { locationIds?: ReadonlySet<string> | null } | null | undefined;

/** 2026-10-14: may this staff member work at this location? Unassigned staff (no staff_locations rows) and staff.manage
    holders are unrestricted (locationIds null); a principal built without the field is unrestricted too. */
export function canUseLocation(actor: Scoped, locationId: string | null | undefined): boolean {
  if (!actor) return false;
  return !actor.locationIds || (!!locationId && actor.locationIds.has(locationId));
}

export function requireLocation(actor: Scoped, locationId: string | null | undefined): void {
  if (!canUseLocation(actor, locationId)) throw new ForbiddenError('You are not assigned to this branch.');
}

/** The location ids a list should be limited to, or null for every location. */
export function locationScope(actor: Scoped): string[] | null {
  return actor?.locationIds ? [...actor.locationIds] : null;
}

/** 2026-10-14: the staff member's assigned locations (staff_locations), or null when unrestricted: no rows, or staff.manage
    (whoever assigns branches is never limited to one; the super_admin and admin roles hold it). Permissions only, as above. */
export async function loadLocationScope(q: Queryable, staffId: string, permissions: ReadonlySet<string>): Promise<Set<string> | null> {
  if (permissions.has('staff.manage')) return null;
  try {
    const rows = await q.selectFrom('staff_locations').select('location_id').where('staff_user_id', '=', staffId).execute();
    return rows.length ? new Set(rows.map(r => r.location_id)) : null;
  } catch (e) {
    // Code released before migration 20261014005000 has run: nobody can have an assignment yet, so nobody is limited
    // (rather than every sign-in failing). Any other error is real.
    if ((e as { code?: string })?.code === '42P01') return null;
    throw e;
  }
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
