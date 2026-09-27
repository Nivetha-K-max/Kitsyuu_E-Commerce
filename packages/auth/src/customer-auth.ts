/* Customer authentication flows (M6). Same building blocks as staff auth: Argon2id passwords, one-time tokens stored only
   as SHA-256, login throttling in auth_attempts, database-backed sessions, and an audit record in the same transaction
   as each change. Responses never reveal whether an email address has an account.

   Accounts mirrored from Supabase Auth (legacy_auth_user_id set, no password_hash yet) move to platform login on their
   first successful sign-in: the password is checked once by the injected `legacyCheck` (the website asks Supabase Auth),
   then stored as an Argon2id hash. No password hash is ever copied from Supabase. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { hashPassword, hashToken, newToken, verifyPassword } from './crypto.ts';
import type { Mailer } from './mailer.ts';
import type { RequestContext } from './sessions.ts';
import { authSettings, type AuthSettings } from './settings.ts';
import { loginThrottle, recordLoginAttempt } from './throttle.ts';
import { createCustomerSession, revokeAllCustomerSessions, revokeCustomerSession, type CustomerPrincipal } from './customer-sessions.ts';

/** Checks an email + password against the legacy login system (Supabase Auth). Must return false (never throw) on failure. */
export type LegacyPasswordCheck = (email: string, password: string) => Promise<boolean>;

const ctxAudit = (ctx: RequestContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const customerAudit = (customerId: string, ctx: RequestContext) => ({ actorType: 'customer' as const, customerId, entityType: 'customers', entityId: customerId, ...ctxAudit(ctx) });

type SessionResult = { ok: true; token: string; expiresAt: Date; customerId: string };

// ---------------------------------------------------------------- one-time links ----------------------------------------------------------------

/** Issues a fresh one-time link (earlier unused links of the same purpose stop working) and emails it. Limited to
    `loginMaxFailures` links per account per `loginWindowMinutes`, quietly (the caller's response never changes). */
async function sendLink(db: Db, mailer: Mailer, s: AuthSettings, customer: { id: string; email: string }, purpose: 'email_verification' | 'password_reset',
  ctx: RequestContext, url: (token: string) => string): Promise<boolean> {
  const recent = await db.selectFrom('auth_tokens').select(sql<number>`count(*)::int`.as('n'))
    .where('customer_id', '=', customer.id).where('purpose', '=', purpose)
    .where('created_at', '>', sql<Date>`now() - make_interval(mins => ${s.loginWindowMinutes})`).executeTakeFirstOrThrow();
  if (recent.n >= s.loginMaxFailures) return false;
  const { token, hash } = newToken();
  await db.transaction().execute(async tx => {
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()`, metadata: JSON.stringify({ superseded: true }) })
      .where('customer_id', '=', customer.id).where('purpose', '=', purpose).where('used_at', 'is', null).execute();
    await tx.insertInto('auth_tokens').values({
      purpose, customer_id: customer.id, token_hash: hash, created_ip: ctx.ip ?? null,
      expires_at: sql<Date>`now() + make_interval(mins => ${s.tokenTtlMinutes[purpose]})`,
    }).execute();
    await recordAudit(tx, { ...customerAudit(customer.id, ctx), action: purpose === 'password_reset' ? 'auth.password_reset_request' : 'auth.email_verification_request' });
  });
  const minutes = s.tokenTtlMinutes[purpose], lifetime = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  await mailer.send(purpose === 'password_reset'
    ? { to: customer.email, subject: 'Reset your KITSYUU password',
        text: `A password reset was requested for your KITSYUU account.\n\nSet a new password: ${url(token)}\n\nThe link works once and expires in ${lifetime}. If you did not ask for this, you can ignore this email.` }
    : { to: customer.email, subject: 'Confirm your KITSYUU account',
        text: `Welcome to KITSYUU.\n\nConfirm your email address to finish creating your account: ${url(token)}\n\nThe link works once and expires in ${lifetime}. If you did not create an account, you can ignore this email.` });
  return true;
}

// ---------------------------------------------------------------- signup + verification ----------------------------------------------------------------

/** Creates an account and emails a confirmation link. The response is identical whether or not the email already has an
    account: an unconfirmed existing account gets its confirmation link again; a confirmed one gets nothing (no email can be
    used to spam its owner). The password is always hashed, so the time taken does not differ either. */
export async function signupCustomer(db: Db, mailer: Mailer, input: { email: string; password: string; fullName: string },
  ctx: RequestContext & { verifyUrl: (token: string) => string }): Promise<void> {
  const s = await authSettings(db);
  const passwordHash = await hashPassword(input.password);
  let customer = await db.selectFrom('customers').select(['id', 'email', 'email_verified_at', 'status']).where('email', '=', input.email).executeTakeFirst();
  if (!customer) {
    const created = await db.transaction().execute(async tx => {
      const row = await tx.insertInto('customers').values({
        email: input.email, full_name: input.fullName, password_hash: passwordHash, password_changed_at: sql<Date>`now()`,
      }).onConflict(oc => oc.column('email').doNothing()).returning(['id', 'email']).executeTakeFirst();
      if (row) await recordAudit(tx, { ...customerAudit(row.id, ctx), action: 'customer.signup' });
      return row;
    });
    if (!created) return;                                           // created concurrently: treat as existing
    customer = { ...created, email_verified_at: null, status: 'active' };
  }
  if (customer.status === 'active' && !customer.email_verified_at) await sendLink(db, mailer, s, customer, 'email_verification', ctx, ctx.verifyUrl);
}

/** Confirms the email address from the emailed link and signs the customer in. */
export async function verifyCustomerEmail(db: Db, input: { token: string }, ctx: RequestContext): Promise<SessionResult | { ok: false; error: 'invalid_link' }> {
  const s = await authSettings(db);
  return db.transaction().execute(async tx => {
    const row = await tx.selectFrom('auth_tokens as t').innerJoin('customers as c', 'c.id', 't.customer_id')
      .select(['t.id as token_id', 'c.id as customer_id'])
      .where('t.token_hash', '=', hashToken(input.token)).where('t.purpose', '=', 'email_verification')
      .where('t.used_at', 'is', null).where('t.expires_at', '>', sql<Date>`now()`).where('c.status', '=', 'active')
      .forUpdate().executeTakeFirst();
    if (!row) return { ok: false as const, error: 'invalid_link' as const };
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()` }).where('id', '=', row.token_id).execute();
    await tx.updateTable('customers').set({ email_verified_at: sql<Date>`coalesce(email_verified_at, now())`, last_login_at: sql<Date>`now()` })
      .where('id', '=', row.customer_id).execute();
    const session = await createCustomerSession(tx, row.customer_id, ctx, s);
    await recordAudit(tx, { ...customerAudit(row.customer_id, ctx), action: 'customer.email_verify', metadata: { session_id: session.sessionId } });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, customerId: row.customer_id };
  });
}

/** Sends a new confirmation link to an unconfirmed account. Always resolves the same way. */
export async function resendCustomerVerification(db: Db, mailer: Mailer, input: { email: string }, ctx: RequestContext & { verifyUrl: (token: string) => string }): Promise<void> {
  const s = await authSettings(db);
  const customer = await db.selectFrom('customers').select(['id', 'email']).where('email', '=', input.email)
    .where('status', '=', 'active').where('email_verified_at', 'is', null).executeTakeFirst();
  if (customer) await sendLink(db, mailer, s, customer, 'email_verification', ctx, ctx.verifyUrl);
}

// ---------------------------------------------------------------- login / logout ----------------------------------------------------------------

export type CustomerLoginResult = SessionResult | { ok: false; error: 'invalid' | 'throttled' | 'unverified'; retryAfterMinutes?: number };

export async function loginCustomer(db: Db, mailer: Mailer, input: { email: string; password: string },
  ctx: RequestContext & { verifyUrl: (token: string) => string }, legacyCheck?: LegacyPasswordCheck): Promise<CustomerLoginResult> {
  const s = await authSettings(db);
  const ip = ctx.ip ?? null;
  const t = await loginThrottle(db, 'customer', input.email, ip, s);
  if (!t.allowed) return { ok: false, error: 'throttled', retryAfterMinutes: t.retryAfterMinutes };

  const customer = await db.selectFrom('customers')
    .select(['id', 'email', 'password_hash', 'status', 'email_verified_at', 'legacy_auth_user_id'])
    .where('email', '=', input.email).executeTakeFirst();
  const legacy = !!customer && !customer.password_hash && !!customer.legacy_auth_user_id && !!legacyCheck;
  let passwordOk: boolean;
  if (legacy) passwordOk = await legacyCheck!(input.email, input.password).catch(() => false);
  else passwordOk = await verifyPassword(customer?.password_hash ?? null, input.password);

  if (!customer || !passwordOk || customer.status !== 'active') {
    await recordLoginAttempt(db, { realm: 'customer', email: input.email, ip, succeeded: false,
      reason: !customer ? 'unknown_email' : !passwordOk ? 'bad_password' : `status_${customer.status}` });
    return { ok: false, error: 'invalid' };
  }
  // The password was right: from here on the answer may depend on the account (the caller knows the password).
  const migratedHash = legacy ? await hashPassword(input.password) : null;
  if (!customer.email_verified_at) {
    if (migratedHash) await db.updateTable('customers').set({ password_hash: migratedHash }).where('id', '=', customer.id).where('password_hash', 'is', null).execute();
    await recordLoginAttempt(db, { realm: 'customer', email: input.email, ip, succeeded: false, reason: 'unverified' });
    await sendLink(db, mailer, s, customer, 'email_verification', ctx, ctx.verifyUrl);
    return { ok: false, error: 'unverified' };
  }
  return db.transaction().execute(async tx => {
    if (migratedHash) {
      await tx.updateTable('customers').set({ password_hash: migratedHash }).where('id', '=', customer.id).where('password_hash', 'is', null).execute();
      await recordAudit(tx, { ...customerAudit(customer.id, ctx), action: 'auth.legacy_password_migrated' });
    }
    await recordLoginAttempt(tx, { realm: 'customer', email: input.email, ip, succeeded: true });
    await tx.updateTable('customers').set({ last_login_at: sql<Date>`now()` }).where('id', '=', customer.id).execute();
    const session = await createCustomerSession(tx, customer.id, ctx, s);
    await recordAudit(tx, { ...customerAudit(customer.id, ctx), action: 'auth.login', metadata: { session_id: session.sessionId } });
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, customerId: customer.id };
  });
}

export async function logoutCustomer(db: Db, token: string, ctx: RequestContext): Promise<void> {
  await db.transaction().execute(async tx => {
    const ended = await revokeCustomerSession(tx, token);
    if (ended) await recordAudit(tx, { ...customerAudit(ended.customerId, ctx), action: 'auth.logout', metadata: { session_id: ended.sessionId } });
  });
}

/** Signs the customer out on every device, including this one. */
export async function logoutCustomerEverywhere(db: Db, principal: CustomerPrincipal, ctx: RequestContext): Promise<number> {
  return db.transaction().execute(async tx => {
    const ended = await revokeAllCustomerSessions(tx, principal.customerId);
    await recordAudit(tx, { ...customerAudit(principal.customerId, ctx), action: 'auth.logout_everywhere', metadata: { sessions_ended: ended } });
    return ended;
  });
}

/** Ends one of the customer's other sessions (Security page). */
export async function endCustomerSession(db: Db, principal: CustomerPrincipal, sessionId: string, ctx: RequestContext): Promise<boolean> {
  return db.transaction().execute(async tx => {
    const res = await tx.updateTable('customer_sessions').set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', sessionId).where('customer_id', '=', principal.customerId).where('revoked_at', 'is', null).executeTakeFirst();
    const ended = Number(res.numUpdatedRows) === 1;
    if (ended) await recordAudit(tx, { ...customerAudit(principal.customerId, ctx), action: 'auth.session_revoke', metadata: { session_id: sessionId } });
    return ended;
  });
}

// ---------------------------------------------------------------- passwords ----------------------------------------------------------------

/** Always resolves the same way whether or not the email belongs to an account. Works for mirrored Supabase accounts
    too (setting a password moves them to platform login). */
export async function requestCustomerPasswordReset(db: Db, mailer: Mailer, input: { email: string }, ctx: RequestContext & { resetUrl: (token: string) => string }): Promise<void> {
  const s = await authSettings(db);
  const customer = await db.selectFrom('customers').select(['id', 'email']).where('email', '=', input.email).where('status', '=', 'active').executeTakeFirst();
  if (customer) await sendLink(db, mailer, s, customer, 'password_reset', ctx, ctx.resetUrl);
}

/** Sets a new password from the emailed link. The link also proves the email address, and every session ends. */
export async function resetCustomerPassword(db: Db, input: { token: string; password: string }, ctx: RequestContext): Promise<{ ok: true } | { ok: false; error: 'invalid_link' }> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction().execute(async tx => {
    const row = await tx.selectFrom('auth_tokens as t').innerJoin('customers as c', 'c.id', 't.customer_id')
      .select(['t.id as token_id', 'c.id as customer_id'])
      .where('t.token_hash', '=', hashToken(input.token)).where('t.purpose', '=', 'password_reset')
      .where('t.used_at', 'is', null).where('t.expires_at', '>', sql<Date>`now()`).where('c.status', '=', 'active')
      .forUpdate().executeTakeFirst();
    if (!row) return { ok: false as const, error: 'invalid_link' as const };
    await tx.updateTable('customers').set({
      password_hash: passwordHash, password_changed_at: sql<Date>`now()`, email_verified_at: sql<Date>`coalesce(email_verified_at, now())`,
    }).where('id', '=', row.customer_id).execute();
    await tx.updateTable('auth_tokens').set({ used_at: sql<Date>`now()` }).where('id', '=', row.token_id).execute();
    const ended = await revokeAllCustomerSessions(tx, row.customer_id);
    await recordAudit(tx, { ...customerAudit(row.customer_id, ctx), action: 'auth.password_reset', metadata: { sessions_ended: ended } });
    return { ok: true as const };
  });
}

/** Changes the password of the signed-in customer; their other sessions end, this one stays. */
export async function changeCustomerPassword(db: Db, principal: CustomerPrincipal, input: { current: string; password: string }, ctx: RequestContext): Promise<{ ok: true } | { ok: false; error: 'wrong_current' }> {
  const row = await db.selectFrom('customers').select('password_hash').where('id', '=', principal.customerId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(row.password_hash, input.current))) return { ok: false, error: 'wrong_current' };
  const passwordHash = await hashPassword(input.password);
  await db.transaction().execute(async tx => {
    await tx.updateTable('customers').set({ password_hash: passwordHash, password_changed_at: sql<Date>`now()` }).where('id', '=', principal.customerId).execute();
    const ended = await revokeAllCustomerSessions(tx, principal.customerId, principal.sessionId);
    await recordAudit(tx, { ...customerAudit(principal.customerId, ctx), action: 'auth.password_change', metadata: { other_sessions_ended: ended } });
  });
  return { ok: true };
}

