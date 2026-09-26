/* Typed reads of the settings table. Every auth limit comes from the database; the fallbacks only apply if a row is
   missing, and match the values seeded by the M2 migration. */
import type { Queryable } from '@kitsyuu/db';

export interface AuthSettings {
  staffIdleMinutes: number;
  staffAbsoluteHours: number;
  loginMaxFailures: number;
  loginWindowMinutes: number;
  tokenTtlMinutes: { email_verification: number; password_reset: number; staff_invitation: number };
}

const FALLBACK: AuthSettings = {
  staffIdleMinutes: 30, staffAbsoluteHours: 12, loginMaxFailures: 5, loginWindowMinutes: 15,
  tokenTtlMinutes: { email_verification: 1440, password_reset: 60, staff_invitation: 4320 },
};

const KEYS = {
  staffIdleMinutes: 'auth.staff_session_idle_minutes',
  staffAbsoluteHours: 'auth.staff_session_absolute_hours',
  loginMaxFailures: 'auth.login_max_failures',
  loginWindowMinutes: 'auth.login_window_minutes',
  tokenTtlMinutes: 'auth.token_ttl_minutes',
} as const;

export async function authSettings(q: Queryable): Promise<AuthSettings> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'in', Object.values(KEYS)).execute();
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  const num = (k: keyof typeof KEYS) => { const v = Number(byKey.get(KEYS[k])); return Number.isFinite(v) && v > 0 ? v : (FALLBACK[k] as number); };
  const ttl = byKey.get(KEYS.tokenTtlMinutes) as Partial<AuthSettings['tokenTtlMinutes']> | undefined;
  return {
    staffIdleMinutes: num('staffIdleMinutes'),
    staffAbsoluteHours: num('staffAbsoluteHours'),
    loginMaxFailures: num('loginMaxFailures'),
    loginWindowMinutes: num('loginWindowMinutes'),
    tokenTtlMinutes: { ...FALLBACK.tokenTtlMinutes, ...(ttl && typeof ttl === 'object' ? ttl : {}) },
  };
}
