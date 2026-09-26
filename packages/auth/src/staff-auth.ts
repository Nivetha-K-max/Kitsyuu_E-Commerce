/* Staff authentication flows. Staff accounts are only ever created by invitation (the create-staff script or a staff
   member holding staff.manage); nothing here can create one. Each flow runs in one transaction together with its
   audit record. Responses never reveal whether an email address has an account. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.ts';
import type { Mailer } from './mailer.ts';
import type { StaffPrincipal } from './rbac.ts';
import { createStaffSession, revokeAllStaffSessions, revokeStaffSession, type RequestContext } from './sessions.ts';
import { authSettings } from './settings.ts';
import { loginThrottle, recordLoginAttempt } from './throttle.ts';

const ctxAudit = (ctx: RequestContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; staffId: string }
  | { ok: false; error: 'invalid' | 'throttled'; retryAfterMinutes?: number };

export async function loginStaff(db: Db, input: { email: string; password: string }, ctx: RequestContext): Promise<LoginResult> {
  const s = await authSettings(db);
  const ip = ctx.ip ?? null;
  const t = await loginThrottle(db, 'staff', input.email, ip, s);
  if (!t.allowed) return { ok: false, error: 'throttled', retryAfterMinutes: t.retryAfterMinutes };

  const staff = await db.selectFrom('staff_users').select(['id', 'password_hash', 'status']).where('email', '=', input.email).executeTakeFirst();
  const passwordOk = await verifyPassword(staff?.password_hash ?? null, input.password);
  if (!staff || !passwordOk || staff.status !== 'active') {
    await recordLoginAttempt(db, { realm: 'staff', email: input.email, ip, succeeded: false, reason: !staff ? 'unknown_email' : !passwordOk ? 'bad_password' : `status_${staff.status}` });
    return { ok: false, error: 'invalid' };
  }
  return db.transaction().execute(async tx => {
    await recordLoginAttempt(tx, { realm: 'staff', email: input.email, ip, succeeded: true });
    await tx.updateTable('staff_users').set({ last_login_at: sql<Date>`now()` }).where('id', '=', staff.id).execute();
    const session = await createStaffSession(tx, staff.id, ctx, s);
    await recordAudit(tx, { actorType: 'staff', staffId: staff.id, action: 'auth.login', entityType: 'staff_sessions', entityId: session.sessionId, ...ctxAudit(ctx) });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, staffId: staff.id };
  });
}

export async function logoutStaff(db: Db, token: string, ctx: RequestContext): Promise<void> {
  await db.transaction().execute(async tx => {
    const ended = await revokeStaffSession(tx, token);
    if (ended) await recordAudit(tx, { actorType: 'staff', staffId: ended.staffId, action: 'auth.logout', entityType: 'staff_sessions', entityId: ended.sessionId, ...ctxAudit(ctx) });
  });
}

/** Creates a one-time invitation token for an invited staff member (inside the caller's transaction). */
export async function issueStaffInvite(q: Queryable, staffId: string, ip: string | null): Promise<{ token: string; expiresAt: Date }> {
  const s = await authSettings(q);
  const { token, hash } = newToken();
  // Any earlier unused invitation for this person stops working.
  await q.updateTable('auth_tokens').set({ used_at: sql<Date>`now()`, metadata: JSON.stringify({ superseded: true }) })
    .where('staff_user_id', '=', staffId).where('purpose', '=', 'staff_invitation').where('used_at', 'is', null).execute();
  const row = await q.insertInto('auth_tokens').values({
    purpose: 'staff_invitation', staff_user_id: staffId, token_hash: hash, created_ip: ip,
    expires_at: sql<Date>`now() + make_interval(mins => ${s.tokenTtlMinutes.staff_invitation})`,
  }).returning('expires_at').executeTakeFirstOrThrow();
  return { token, expiresAt: row.expires_at as Date };
}

type LinkResult = { ok: true; token: string; expiresAt: Date } | { ok: false; error: 'invalid_link' };

export async function acceptStaffInvite(db: Db, input: { token: string; password: string; fullName: string }, ctx: RequestContext): Promise<LinkResult> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction().execute(async tx => {
    const invite = await tx.selectFrom('auth_tokens as t').innerJoin('staff_users as u', 'u.id', 't.staff_user_id')
      .select(['t.id as token_id', 'u.id as staff_id', 'u.full_name'])
      .where('t.token_hash', '=', hashToken(input.token)).where('t.purpose', '=', 'staff_invitation')
      .where('t.used_at', 'is', null).where('t.expires_at', '>', sql<Date>`now()`).where('u.status', '=', 'invited')
      .forUpdate().executeTakeFirst();
    if (!invite) return { ok: false as const, error: 'invalid_link' as const };
    await tx.updateTable('staff_users').set({
      password_hash: passwordHash, full_name: input.fullName, status: 'active',
      email_verified_at: sql<Date>`now()`, password_changed_at: sql<Date>`now()`, last_login_at: sql<Date>`now()`,
    }).where('id', '=', invite.staff_id).execute();
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()` }).where('id', '=', invite.token_id).execute();
    const session = await createStaffSession(tx, invite.staff_id, ctx);
    await recordAudit(tx, { actorType: 'staff', staffId: invite.staff_id, action: 'staff.invite_accept', entityType: 'staff_users', entityId: invite.staff_id,
      before: { status: 'invited', full_name: invite.full_name }, after: { status: 'active', full_name: input.fullName }, ...ctxAudit(ctx) });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt };
  });
}

/** Always resolves the same way whether or not the email belongs to an active staff member. */
export async function requestStaffPasswordReset(db: Db, mailer: Mailer, input: { email: string }, ctx: RequestContext & { resetUrl: (token: string) => string }): Promise<void> {
  const s = await authSettings(db);
  const staff = await db.selectFrom('staff_users').select(['id', 'email']).where('email', '=', input.email).where('status', '=', 'active').executeTakeFirst();
  if (!staff) return;
  const recent = await db.selectFrom('auth_tokens').select(sql<number>`count(*)::int`.as('n'))
    .where('staff_user_id', '=', staff.id).where('purpose', '=', 'password_reset')
    .where('created_at', '>', sql<Date>`now() - make_interval(mins => ${s.loginWindowMinutes})`).executeTakeFirstOrThrow();
  if (recent.n >= s.loginMaxFailures) return;   // quietly limit reset emails per account
  const { token, hash } = newToken();
  await db.transaction().execute(async tx => {
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()`, metadata: JSON.stringify({ superseded: true }) })
      .where('staff_user_id', '=', staff.id).where('purpose', '=', 'password_reset').where('used_at', 'is', null).execute();
    await tx.insertInto('auth_tokens').values({
      purpose: 'password_reset', staff_user_id: staff.id, token_hash: hash, created_ip: ctx.ip ?? null,
      expires_at: sql<Date>`now() + make_interval(mins => ${s.tokenTtlMinutes.password_reset})`,
    }).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: staff.id, action: 'auth.password_reset_request', entityType: 'staff_users', entityId: staff.id, ...ctxAudit(ctx) });
  });
  await mailer.send({
    to: staff.email,
    subject: 'Reset your KITSYUU admin password',
    text: `A password reset was requested for your KITSYUU admin account.\n\nSet a new password: ${ctx.resetUrl(token)}\n\nThe link works once and expires in ${s.tokenTtlMinutes.password_reset} minutes. If you did not ask for this, ignore this email.`,
  });
}

export async function resetStaffPassword(db: Db, input: { token: string; password: string }, ctx: RequestContext): Promise<{ ok: true } | { ok: false; error: 'invalid_link' }> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction().execute(async tx => {
    const row = await tx.selectFrom('auth_tokens as t').innerJoin('staff_users as u', 'u.id', 't.staff_user_id')
      .select(['t.id as token_id', 'u.id as staff_id'])
      .where('t.token_hash', '=', hashToken(input.token)).where('t.purpose', '=', 'password_reset')
      .where('t.used_at', 'is', null).where('t.expires_at', '>', sql<Date>`now()`).where('u.status', '=', 'active')
      .forUpdate().executeTakeFirst();
    if (!row) return { ok: false as const, error: 'invalid_link' as const };
    await tx.updateTable('staff_users').set({ password_hash: passwordHash, password_changed_at: sql<Date>`now()` }).where('id', '=', row.staff_id).execute();
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()` }).where('id', '=', row.token_id).execute();
    const ended = await revokeAllStaffSessions(tx, row.staff_id);
    await recordAudit(tx, { actorType: 'staff', staffId: row.staff_id, action: 'auth.password_reset', entityType: 'staff_users', entityId: row.staff_id, metadata: { sessions_ended: ended }, ...ctxAudit(ctx) });
    return { ok: true as const };
  });
}

export async function changeStaffPassword(db: Db, actor: StaffPrincipal, input: { current: string; password: string }, ctx: RequestContext): Promise<{ ok: true } | { ok: false; error: 'wrong_current' }> {
  const staff = await db.selectFrom('staff_users').select('password_hash').where('id', '=', actor.staffId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(staff.password_hash, input.current))) return { ok: false, error: 'wrong_current' };
  const passwordHash = await hashPassword(input.password);
  await db.transaction().execute(async tx => {
    await tx.updateTable('staff_users').set({ password_hash: passwordHash, password_changed_at: sql<Date>`now()` }).where('id', '=', actor.staffId).execute();
    const ended = await revokeAllStaffSessions(tx, actor.staffId, actor.sessionId);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'auth.password_change', entityType: 'staff_users', entityId: actor.staffId, metadata: { other_sessions_ended: ended }, ...ctxAudit(ctx) });
  });
  return { ok: true };
}
