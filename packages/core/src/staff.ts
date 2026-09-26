/* Staff management. Every mutation: permission check → guards → change + audit record in ONE transaction. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, NotFoundError, type InviteStaffInput, type SetStaffRolesInput, type SetStaffStatusInput, type UpdateStaffInput } from '@kitsyuu/contracts';
import { issueStaffInvite, requirePermission, revokeAllStaffSessions, type Mailer, type RequestContext, type StaffPrincipal } from '@kitsyuu/auth';
import { assertAdministrationRemains, assertHoldsAll, assertOutranksOrEqual } from './guards.ts';

export interface MutationContext extends RequestContext { inviteUrl?: (token: string) => string }
const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export interface StaffRow {
  id: string; email: string; fullName: string; status: 'invited' | 'active' | 'disabled';
  lastLoginAt: Date | null; createdAt: Date; roles: { id: string; code: string; name: string }[];
}

async function rolesOf(q: Queryable, staffIds: string[]) {
  if (!staffIds.length) return new Map<string, StaffRow['roles']>();
  const rows = await q.selectFrom('staff_user_roles as sur').innerJoin('roles as r', 'r.id', 'sur.role_id')
    .select(['sur.staff_user_id', 'r.id', 'r.code', 'r.name']).where('sur.staff_user_id', 'in', staffIds).orderBy('r.code').execute();
  const map = new Map<string, StaffRow['roles']>();
  for (const r of rows) (map.get(r.staff_user_id) ?? map.set(r.staff_user_id, []).get(r.staff_user_id)!).push({ id: r.id, code: r.code, name: r.name });
  return map;
}

export async function listStaff(db: Db, actor: StaffPrincipal): Promise<StaffRow[]> {
  requirePermission(actor, 'staff.read');
  const rows = await db.selectFrom('staff_users').select(['id', 'email', 'full_name', 'status', 'last_login_at', 'created_at'])
    .orderBy('status').orderBy('email').execute();
  const roles = await rolesOf(db, rows.map(r => r.id));
  return rows.map(r => ({ id: r.id, email: r.email, fullName: r.full_name, status: r.status, lastLoginAt: r.last_login_at as Date | null, createdAt: r.created_at as Date, roles: roles.get(r.id) ?? [] }));
}

export async function getStaff(db: Db, actor: StaffPrincipal, staffId: string) {
  requirePermission(actor, 'staff.read');
  const r = await db.selectFrom('staff_users').select(['id', 'email', 'full_name', 'status', 'last_login_at', 'created_at', 'password_changed_at', 'disabled_at'])
    .where('id', '=', staffId).executeTakeFirst();
  if (!r) throw new NotFoundError('Staff member not found.');
  const sessions = await db.selectFrom('staff_sessions').select(sql<number>`count(*)::int`.as('n')).where('staff_user_id', '=', staffId)
    .where('revoked_at', 'is', null).where('expires_at', '>', sql<Date>`now()`).where('idle_expires_at', '>', sql<Date>`now()`).executeTakeFirstOrThrow();
  const pending = await db.selectFrom('auth_tokens').select(['expires_at']).where('staff_user_id', '=', staffId).where('purpose', '=', 'staff_invitation')
    .where('used_at', 'is', null).where('expires_at', '>', sql<Date>`now()`).executeTakeFirst();
  return {
    id: r.id, email: r.email, fullName: r.full_name, status: r.status, lastLoginAt: r.last_login_at as Date | null, createdAt: r.created_at as Date,
    passwordChangedAt: r.password_changed_at as Date | null, disabledAt: r.disabled_at as Date | null,
    roles: (await rolesOf(db, [r.id])).get(r.id) ?? [], activeSessions: sessions.n, inviteExpiresAt: (pending?.expires_at as Date | undefined) ?? null,
  };
}

async function roleSet(q: Queryable, roleIds: string[]) {
  if (!roleIds.length) return { roles: [] as { id: string; code: string }[], permissions: new Set<string>() };
  const roles = await q.selectFrom('roles').select(['id', 'code']).where('id', 'in', roleIds).execute();
  if (roles.length !== new Set(roleIds).size) throw new NotFoundError('One of the chosen roles does not exist.');
  const perms = await q.selectFrom('role_permissions').select('permission_code').where('role_id', 'in', roleIds).execute();
  return { roles, permissions: new Set(perms.map(p => p.permission_code)) };
}

async function sendInvite(mailer: Mailer, email: string, link: string, expiresAt: Date) {
  await mailer.send({
    to: email,
    subject: 'Your KITSYUU admin invitation',
    text: `You have been invited to the KITSYUU admin.\n\nSet your password: ${link}\n\nThe link works once and expires ${expiresAt.toISOString()}.`,
  });
}

export async function inviteStaff(db: Db, mailer: Mailer, actor: StaffPrincipal, input: InviteStaffInput, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  if (!ctx.inviteUrl) throw new Error('inviteUrl is required');
  const result = await db.transaction().execute(async tx => {
    const { roles, permissions } = await roleSet(tx, input.roleIds);
    assertHoldsAll(actor, permissions);
    const exists = await tx.selectFrom('staff_users').select('id').where('email', '=', input.email).executeTakeFirst();
    if (exists) throw new ConflictError('A staff account with this email already exists.');
    const staff = await tx.insertInto('staff_users').values({ email: input.email, full_name: input.fullName, status: 'invited', invited_by: actor.staffId })
      .returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values(roles.map(r => ({ staff_user_id: staff.id, role_id: r.id, granted_by: actor.staffId }))).execute();
    const invite = await issueStaffInvite(tx, staff.id, ctx.ip ?? null);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.invite', entityType: 'staff_users', entityId: staff.id,
      after: { email: input.email, full_name: input.fullName, status: 'invited', roles: roles.map(r => r.code).sort() }, ...auditCtx(ctx) });
    return { staffId: staff.id, ...invite };
  });
  await sendInvite(mailer, input.email, ctx.inviteUrl(result.token), result.expiresAt);
  return { staffId: result.staffId };
}

export async function resendInvite(db: Db, mailer: Mailer, actor: StaffPrincipal, staffId: string, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  if (!ctx.inviteUrl) throw new Error('inviteUrl is required');
  const result = await db.transaction().execute(async tx => {
    const staff = await tx.selectFrom('staff_users').select(['id', 'email', 'status']).where('id', '=', staffId).forUpdate().executeTakeFirst();
    if (!staff) throw new NotFoundError('Staff member not found.');
    if (staff.status !== 'invited') throw new ConflictError('Only invited staff who have not set a password can be re-invited.');
    await assertOutranksOrEqual(tx, actor, staffId);
    const invite = await issueStaffInvite(tx, staffId, ctx.ip ?? null);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.invite_resend', entityType: 'staff_users', entityId: staffId, ...auditCtx(ctx) });
    return { email: staff.email, ...invite };
  });
  await sendInvite(mailer, result.email, ctx.inviteUrl(result.token), result.expiresAt);
}

export async function updateStaff(db: Db, actor: StaffPrincipal, input: UpdateStaffInput, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  await db.transaction().execute(async tx => {
    const before = await tx.selectFrom('staff_users').select(['email', 'full_name']).where('id', '=', input.staffId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Staff member not found.');
    await assertOutranksOrEqual(tx, actor, input.staffId);
    if (before.email === input.email && before.full_name === input.fullName) return;
    if (before.email !== input.email) {
      const taken = await tx.selectFrom('staff_users').select('id').where('email', '=', input.email).where('id', '!=', input.staffId).executeTakeFirst();
      if (taken) throw new ConflictError('A staff account with this email already exists.');
    }
    await tx.updateTable('staff_users').set({ email: input.email, full_name: input.fullName }).where('id', '=', input.staffId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.update', entityType: 'staff_users', entityId: input.staffId,
      before: { email: before.email, full_name: before.full_name }, after: { email: input.email, full_name: input.fullName }, ...auditCtx(ctx) });
  });
}

export async function setStaffRoles(db: Db, actor: StaffPrincipal, input: SetStaffRolesInput, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  await db.transaction().execute(async tx => {
    const staff = await tx.selectFrom('staff_users').select('id').where('id', '=', input.staffId).forUpdate().executeTakeFirst();
    if (!staff) throw new NotFoundError('Staff member not found.');
    await assertOutranksOrEqual(tx, actor, input.staffId);
    const current = await tx.selectFrom('staff_user_roles as sur').innerJoin('roles as r', 'r.id', 'sur.role_id').select(['r.id', 'r.code'])
      .where('sur.staff_user_id', '=', input.staffId).execute();
    const next = await roleSet(tx, [...new Set(input.roleIds)]);
    assertHoldsAll(actor, next.permissions);
    const add = next.roles.filter(r => !current.some(c => c.id === r.id));
    const remove = current.filter(c => !next.roles.some(r => r.id === c.id));
    if (!add.length && !remove.length) return;
    if (remove.length) await tx.deleteFrom('staff_user_roles').where('staff_user_id', '=', input.staffId).where('role_id', 'in', remove.map(r => r.id)).execute();
    if (add.length) await tx.insertInto('staff_user_roles').values(add.map(r => ({ staff_user_id: input.staffId, role_id: r.id, granted_by: actor.staffId }))).execute();
    await assertAdministrationRemains(tx);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.roles_update', entityType: 'staff_users', entityId: input.staffId,
      before: { roles: current.map(r => r.code).sort() }, after: { roles: next.roles.map(r => r.code).sort() }, ...auditCtx(ctx) });
  });
}

export async function setStaffStatus(db: Db, actor: StaffPrincipal, input: SetStaffStatusInput, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  if (input.staffId === actor.staffId) throw new ConflictError('You cannot change the status of your own account.');
  await db.transaction().execute(async tx => {
    const staff = await tx.selectFrom('staff_users').select(['id', 'status', 'password_hash']).where('id', '=', input.staffId).forUpdate().executeTakeFirst();
    if (!staff) throw new NotFoundError('Staff member not found.');
    await assertOutranksOrEqual(tx, actor, input.staffId);
    if (input.status === 'disabled') {
      if (staff.status === 'disabled') return;
      await tx.updateTable('staff_users').set({ status: 'disabled', disabled_at: sql<Date>`now()` }).where('id', '=', input.staffId).execute();
      const ended = await revokeAllStaffSessions(tx, input.staffId);
      await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()`, metadata: JSON.stringify({ superseded: true, reason: 'disabled' }) })
        .where('staff_user_id', '=', input.staffId).where('used_at', 'is', null).execute();
      await assertAdministrationRemains(tx);
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.disable', entityType: 'staff_users', entityId: input.staffId,
        before: { status: staff.status }, after: { status: 'disabled' }, metadata: { sessions_ended: ended }, ...auditCtx(ctx) });
    } else {
      if (staff.status !== 'disabled') return;
      const status = staff.password_hash ? 'active' : 'invited';
      await tx.updateTable('staff_users').set({ status, disabled_at: null }).where('id', '=', input.staffId).execute();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.enable', entityType: 'staff_users', entityId: input.staffId,
        before: { status: 'disabled' }, after: { status }, ...auditCtx(ctx) });
    }
  });
}

export async function revokeStaffSessions(db: Db, actor: StaffPrincipal, staffId: string, ctx: MutationContext) {
  requirePermission(actor, 'staff.manage');
  await db.transaction().execute(async tx => {
    await assertOutranksOrEqual(tx, actor, staffId);
    const ended = await revokeAllStaffSessions(tx, staffId, staffId === actor.staffId ? actor.sessionId : undefined);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.sessions_revoke', entityType: 'staff_users', entityId: staffId,
      metadata: { sessions_ended: ended }, ...auditCtx(ctx) });
  });
}
