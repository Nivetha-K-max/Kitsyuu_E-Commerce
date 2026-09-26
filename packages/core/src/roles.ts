/* Roles and their permissions. Roles are data; permission codes arrive with the migrations of the features using them. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError, type CreateRoleInput, type UpdateRoleInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { assertAdministrationRemains, assertHoldsAll } from './guards.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export interface RoleRow { id: string; code: string; name: string; description: string; isSystem: boolean; permissions: string[]; members: number }

export async function listRoles(db: Db, actor: StaffPrincipal): Promise<RoleRow[]> {
  requirePermission(actor, 'roles.read');
  const roles = await db.selectFrom('roles as r')
    .select(['r.id', 'r.code', 'r.name', 'r.description', 'r.is_system',
      sql<number>`(select count(*)::int from public.staff_user_roles sur where sur.role_id = r.id)`.as('members'),
      sql<string[]>`coalesce((select array_agg(rp.permission_code order by rp.permission_code) from public.role_permissions rp where rp.role_id = r.id), '{}')`.as('permissions')])
    .orderBy('r.is_system', 'desc').orderBy('r.name').execute();
  return roles.map(r => ({ id: r.id, code: r.code, name: r.name, description: r.description, isSystem: r.is_system, permissions: r.permissions, members: r.members }));
}

export async function getRole(db: Db, actor: StaffPrincipal, roleId: string): Promise<RoleRow> {
  const role = (await listRoles(db, actor)).find(r => r.id === roleId);
  if (!role) throw new NotFoundError('Role not found.');
  return role;
}

export async function listPermissions(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'roles.read');
  return db.selectFrom('permissions').select(['code', 'module', 'description']).orderBy('module').orderBy('code').execute();
}

export async function createRole(db: Db, actor: StaffPrincipal, input: CreateRoleInput, ctx: MutationContext) {
  requirePermission(actor, 'roles.manage');
  return db.transaction().execute(async tx => {
    const taken = await tx.selectFrom('roles').select('id').where('code', '=', input.code).executeTakeFirst();
    if (taken) throw new ConflictError('A role with this code already exists.');
    const role = await tx.insertInto('roles').values({ code: input.code, name: input.name, description: input.description, is_system: false })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'role.create', entityType: 'roles', entityId: role.id,
      after: { code: input.code, name: input.name, description: input.description, permissions: [] }, ...auditCtx(ctx) });
    return { roleId: role.id };
  });
}

export async function updateRole(db: Db, actor: StaffPrincipal, input: UpdateRoleInput, ctx: MutationContext) {
  requirePermission(actor, 'roles.manage');
  await db.transaction().execute(async tx => {
    const role = await tx.selectFrom('roles').select(['id', 'code', 'name', 'description']).where('id', '=', input.roleId).forUpdate().executeTakeFirst();
    if (!role) throw new NotFoundError('Role not found.');
    const current = (await tx.selectFrom('role_permissions').select('permission_code').where('role_id', '=', role.id).execute()).map(p => p.permission_code).sort();
    const next = [...new Set(input.permissionCodes)].sort();
    const known = new Set((await tx.selectFrom('permissions').select('code').execute()).map(p => p.code));
    const unknown = next.filter(c => !known.has(c));
    if (unknown.length) throw new DomainError('invalid', `Unknown permission: ${unknown.join(', ')}`);
    // Changing a role requires holding everything it grants before and after the change (no escalation, no editing a more powerful role).
    assertHoldsAll(actor, current, 'You cannot change a role that grants permissions you do not have.');
    assertHoldsAll(actor, next);
    const add = next.filter(c => !current.includes(c)), remove = current.filter(c => !next.includes(c));
    const detailsChanged = role.name !== input.name || role.description !== input.description;
    if (!add.length && !remove.length && !detailsChanged) return;
    if (detailsChanged) await tx.updateTable('roles').set({ name: input.name, description: input.description }).where('id', '=', role.id).execute();
    if (remove.length) await tx.deleteFrom('role_permissions').where('role_id', '=', role.id).where('permission_code', 'in', remove).execute();
    if (add.length) await tx.insertInto('role_permissions').values(add.map(c => ({ role_id: role.id, permission_code: c }))).execute();
    await assertAdministrationRemains(tx);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'role.update', entityType: 'roles', entityId: role.id,
      before: { name: role.name, description: role.description, permissions: current },
      after: { name: input.name, description: input.description, permissions: next }, ...auditCtx(ctx) });
  });
}

export async function deleteRole(db: Db, actor: StaffPrincipal, roleId: string, ctx: MutationContext) {
  requirePermission(actor, 'roles.manage');
  await db.transaction().execute(async tx => {
    const role = await tx.selectFrom('roles').select(['id', 'code', 'name', 'description', 'is_system']).where('id', '=', roleId).forUpdate().executeTakeFirst();
    if (!role) throw new NotFoundError('Role not found.');
    if (role.is_system) throw new ForbiddenError('Built-in roles cannot be deleted.');
    const members = await tx.selectFrom('staff_user_roles').select(sql<number>`count(*)::int`.as('n')).where('role_id', '=', roleId).executeTakeFirstOrThrow();
    if (members.n > 0) throw new ConflictError('Remove this role from every staff member before deleting it.');
    const perms = (await tx.selectFrom('role_permissions').select('permission_code').where('role_id', '=', roleId).execute()).map(p => p.permission_code).sort();
    assertHoldsAll(actor, perms, 'You cannot delete a role that grants permissions you do not have.');
    await tx.deleteFrom('roles').where('id', '=', roleId).execute();   // role_permissions cascade
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'role.delete', entityType: 'roles', entityId: roleId,
      before: { code: role.code, name: role.name, description: role.description, permissions: perms }, ...auditCtx(ctx) });
  });
}
