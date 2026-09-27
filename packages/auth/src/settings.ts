/* Typed reads of the settings table. Every auth limit comes from the database; the fallbacks only apply if a row is
   missing, and match the values seeded by the M2 migration. */
import type { Queryable } from '@kitsyuu/db';

export interface AuthSettings {
  staffIdleMinutes: number;
  staffAbsoluteHours: number;
  customerIdleDays: number;
  customerAbsoluteDays: number;
  loginMaxFailures: number;
  customerIpMaxFailures: number;
  loginWindowMinutes: number;
  tokenTtlMinutes: { email_verification: number; password_reset: number; staff_invitation: number };
}

const FALLBACK: AuthSettings = {
  staffIdleMinutes: 30, staffAbsoluteHours: 12, customerIdleDays: 30, customerAbsoluteDays: 90, loginMaxFailures: 5, customerIpMaxFailures: 50, loginWindowMinutes: 15,
  tokenTtlMinutes: { email_verification: 1440, password_reset: 60, staff_invitation: 4320 },
};

const KEYS = {
  staffIdleMinutes: 'auth.staff_session_idle_minutes',
  staffAbsoluteHours: 'auth.staff_session_absolute_hours',
  customerIdleDays: 'auth.customer_session_days',
  customerAbsoluteDays: 'auth.customer_session_absolute_days',
  loginMaxFailures: 'auth.login_max_failures',
  customerIpMaxFailures: 'auth.customer_login_max_failures_per_ip',
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
    customerIdleDays: num('customerIdleDays'),
    customerAbsoluteDays: num('customerAbsoluteDays'),
    loginMaxFailures: num('loginMaxFailures'),
    customerIpMaxFailures: num('customerIpMaxFailures'),
    loginWindowMinutes: num('loginWindowMinutes'),
    tokenTtlMinutes: { ...FALLBACK.tokenTtlMinutes, ...(ttl && typeof ttl === 'object' ? ttl : {}) },
  };
}
