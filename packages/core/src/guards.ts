/* Authorization guards that go beyond a single permission check. */
import { sql, type Queryable } from '@kitsyuu/db';
import { ConflictError, ForbiddenError } from '@kitsyuu/contracts';
import { loadPermissions, type StaffPrincipal } from '@kitsyuu/auth';

/** No escalation: an actor can only grant (or take away) permissions they hold themselves. */
export function assertHoldsAll(actor: StaffPrincipal, codes: Iterable<string>, message = 'You can only grant permissions you hold yourself.') {
  for (const c of codes) if (!actor.permissions.has(c)) throw new ForbiddenError(message);
}

/** To change another staff member (email, roles, status) the actor must hold every permission that person holds,
    so e.g. an admin cannot re-point a super admin's email and take the account over through a password reset. */
export async function assertOutranksOrEqual(q: Queryable, actor: StaffPrincipal, targetId: string) {
  if (targetId === actor.staffId) return;
  assertHoldsAll(actor, await loadPermissions(q, targetId), 'You cannot change a staff member who holds permissions you do not have.');
}

/** Lockout guard: after the change, at least one ACTIVE staff member must still hold both staff.manage and roles.manage. */
export async function assertAdministrationRemains(q: Queryable) {
  const holds = (code: string) => sql<boolean>`exists (select 1 from public.staff_user_roles sur join public.role_permissions rp on rp.role_id = sur.role_id
    where sur.staff_user_id = u.id and rp.permission_code = ${code})`;
  const row = await q.selectFrom('staff_users as u').select(sql<number>`count(*)::int`.as('n'))
    .where('u.status', '=', 'active').where(holds('staff.manage')).where(holds('roles.manage'))
    .executeTakeFirstOrThrow();
  if (row.n === 0) throw new ConflictError('This change would leave no active staff member able to manage staff and roles.');
}
