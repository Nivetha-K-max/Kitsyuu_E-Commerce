/* M18: staff two-factor enrolment and verification (see mfa.ts for the crypto). Self-service for the signed-in staff
   member; sign-in (staff-auth.ts) asks for a code only when the person has two-factor switched on. Every change is audited. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { verifyPassword } from './crypto.ts';
import {
  decryptSecret, encryptSecret, hashRecoveryCode, looksLikeRecoveryCode, mfaKey, newMfaSecret, newRecoveryCodes, otpauthUri, verifyTotp, base32Encode,
} from './mfa.ts';
import type { StaffPrincipal } from './rbac.ts';
import type { RequestContext } from './sessions.ts';

const ctxAudit = (ctx: RequestContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export async function staffMfaStatus(q: Queryable, staffId: string) {
  const r = await q.selectFrom('staff_mfa').select(['enabled_at']).where('staff_user_id', '=', staffId).executeTakeFirst();
  const left = r?.enabled_at ? (await q.selectFrom('staff_mfa_recovery_codes').select(sql<number>`count(*)::int`.as('n'))
    .where('staff_user_id', '=', staffId).where('used_at', 'is', null).executeTakeFirstOrThrow()).n : 0;
  return { available: mfaKey() !== null, enabled: !!r?.enabled_at, pending: !!r && !r.enabled_at, recoveryCodesLeft: left };
}

/** Starts (or restarts) enrolment: a new secret, not active until confirmed with a first code. */
export async function startStaffMfa(db: Db, actor: StaffPrincipal, account: string) {
  const key = mfaKey();
  if (!key) return { ok: false as const, error: 'unavailable' as const };
  const current = await db.selectFrom('staff_mfa').select('enabled_at').where('staff_user_id', '=', actor.staffId).executeTakeFirst();
  if (current?.enabled_at) return { ok: false as const, error: 'already_enabled' as const };
  const secret = newMfaSecret();
  await db.insertInto('staff_mfa').values({ staff_user_id: actor.staffId, secret_enc: encryptSecret(key, secret), enabled_at: null, last_used_step: null })
    .onConflict(oc => oc.column('staff_user_id').doUpdateSet({ secret_enc: encryptSecret(key, secret), enabled_at: null, last_used_step: null })).execute();
  return { ok: true as const, secret: base32Encode(secret), uri: otpauthUri(secret, account) };
}

/** Confirms enrolment with a first code; switches two-factor on and returns ten one-time recovery codes (shown once). */
export async function confirmStaffMfa(db: Db, actor: StaffPrincipal, code: string, ctx: RequestContext) {
  const key = mfaKey();
  if (!key) return { ok: false as const, error: 'unavailable' as const };
  return db.transaction().execute(async tx => {
    const r = await tx.selectFrom('staff_mfa').select(['secret_enc', 'enabled_at']).where('staff_user_id', '=', actor.staffId).forUpdate().executeTakeFirst();
    if (!r || r.enabled_at) return { ok: false as const, error: 'not_pending' as const };
    const step = verifyTotp(decryptSecret(key, r.secret_enc), code.trim(), null);
    if (step === null) return { ok: false as const, error: 'bad_code' as const };
    await tx.updateTable('staff_mfa').set({ enabled_at: sql<Date>`now()`, last_used_step: String(step) }).where('staff_user_id', '=', actor.staffId).execute();
    await tx.deleteFrom('staff_mfa_recovery_codes').where('staff_user_id', '=', actor.staffId).execute();
    const rc = newRecoveryCodes();
    await tx.insertInto('staff_mfa_recovery_codes').values(rc.hashes.map(h => ({ staff_user_id: actor.staffId, code_hash: h }))).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.mfa_enable', entityType: 'staff_users', entityId: actor.staffId, ...ctxAudit(ctx) });
    return { ok: true as const, recoveryCodes: rc.codes };
  });
}

/** Switches two-factor off for oneself; needs the current password. */
export async function disableStaffMfa(db: Db, actor: StaffPrincipal, password: string, ctx: RequestContext) {
  const s = await db.selectFrom('staff_users').select('password_hash').where('id', '=', actor.staffId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(s.password_hash, password))) return { ok: false as const, error: 'wrong_password' as const };
  await db.transaction().execute(async tx => {
    await tx.deleteFrom('staff_mfa_recovery_codes').where('staff_user_id', '=', actor.staffId).execute();
    const r = await tx.deleteFrom('staff_mfa').where('staff_user_id', '=', actor.staffId).executeTakeFirst();
    if (Number(r.numDeletedRows)) await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'staff.mfa_disable', entityType: 'staff_users', entityId: actor.staffId, ...ctxAudit(ctx) });
  });
  return { ok: true as const };
}

/** Removes another person's two-factor (e.g. a lost phone). The caller checks staff.manage and rank. */
export async function removeStaffMfa(q: Queryable, staffId: string) {
  await q.deleteFrom('staff_mfa_recovery_codes').where('staff_user_id', '=', staffId).execute();
  const r = await q.deleteFrom('staff_mfa').where('staff_user_id', '=', staffId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Sign-in check. 'none' = two-factor is off for this person; otherwise the code (TOTP or recovery) decides.
    When two-factor is on but this deployment has no key, sign-in cannot be completed (fail closed). */
export async function checkSecondFactor(tx: Queryable, staffId: string, code: string | undefined): Promise<'none' | 'required' | 'ok' | 'bad' | 'recovery_used' | 'unavailable'> {
  const r = await tx.selectFrom('staff_mfa').select(['secret_enc', 'enabled_at', 'last_used_step']).where('staff_user_id', '=', staffId).forUpdate().executeTakeFirst();
  if (!r?.enabled_at) return 'none';
  if (!code || !code.trim()) return 'required';
  if (looksLikeRecoveryCode(code)) {
    const u = await tx.updateTable('staff_mfa_recovery_codes').set({ used_at: sql<Date>`now()` })
      .where('staff_user_id', '=', staffId).where('code_hash', '=', hashRecoveryCode(code)).where('used_at', 'is', null).executeTakeFirst();
    return Number(u.numUpdatedRows) ? 'recovery_used' : 'bad';
  }
  const key = mfaKey();
  if (!key) return 'unavailable';
  const step = verifyTotp(decryptSecret(key, r.secret_enc), code.trim(), r.last_used_step === null ? null : Number(r.last_used_step));
  if (step === null) return 'bad';
  await tx.updateTable('staff_mfa').set({ last_used_step: String(step) }).where('staff_user_id', '=', staffId).execute();
  return 'ok';
}
