/* Platform settings for staff (M8): a typed registry of the settings the platform uses. Every setting has a type, its
   allowed values, a description, the permission it needs and whether it may be changed here. Values that carry a
   business decision (M7) or an undecided business rule are LOCKED: shown, never editable from the admin. There is no
   generic editor and no way to create keys from the UI; only registry keys marked editable can change, one validated
   value at a time, with an audit record. */
import { recordAudit, type Db } from '@kitsyuu/db';
import { DomainError, ForbiddenError, NotFoundError, type SettingUpdateInput } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export type SettingType =
  | { kind: 'integer'; min: number; max: number; unit?: string }
  | { kind: 'text' }
  | { kind: 'boolean' }
  | { kind: 'object' };
export interface SettingDef {
  key: string; label: string; group: string; description: string; type: SettingType;
  /** Permission to see / to change it. */
  readPermission: 'settings.read'; editPermission: 'settings.manage';
  editable: boolean; lockedReason?: string;
}

const M7 = 'Business decision (M7). Not editable from the admin.';
const TAX = 'Tax / GST rules are not decided yet. Not editable until they are.';
const SECURITY = 'Account security setting. Changed only through a reviewed database migration.';
const PRICING = 'Pricing and checkout rule. Not editable from the admin.';
const def = (key: string, label: string, group: string, description: string, type: SettingType, lockedReason?: string): SettingDef =>
  ({ key, label, group, description, type, readPermission: 'settings.read', editPermission: 'settings.manage', editable: !lockedReason, lockedReason });

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  def('inventory.low_stock_threshold', 'Low-stock level', 'Inventory', 'A size counts as low on stock at or below this quantity, unless the size has its own reorder level.',
    { kind: 'integer', min: 0, max: 1000, unit: 'units' }),
  def('checkout.payment_window_minutes', 'Unpaid-order hold time', 'Checkout', 'How long an unpaid order keeps its stock before it is cancelled (14400 minutes = 10 days).',
    { kind: 'integer', min: 5, max: 60 * 24 * 60, unit: 'minutes' }, M7),
  def('store.currency', 'Store currency', 'Store', 'Currency of every price and order.', { kind: 'text' }, PRICING),
  def('store.timezone', 'Business time zone', 'Store', 'Time zone for business days, reports and financial years.', { kind: 'text' },
    'Changes report dates and financial years. Not editable from the admin.'),
  def('billing.prices_include_tax', 'Prices include tax', 'Billing', 'Listed prices already include tax.', { kind: 'boolean' }, TAX),
  def('billing.default_tax_rate_code', 'Default tax rate', 'Billing', 'Tax rate used when a product has no specific rate.', { kind: 'text' }, TAX),
  def('billing.invoice_prefix', 'Invoice number prefix', 'Billing', 'Prefix of invoice numbers.', { kind: 'text' }, TAX),
  def('auth.staff_session_idle_minutes', 'Staff idle sign-out', 'Account security', 'Staff are signed out after this much inactivity.', { kind: 'integer', min: 5, max: 1440, unit: 'minutes' }, SECURITY),
  def('auth.staff_session_absolute_hours', 'Staff session length', 'Account security', 'Staff sessions end this long after sign-in.', { kind: 'integer', min: 1, max: 72, unit: 'hours' }, SECURITY),
  def('auth.customer_session_days', 'Customer idle sign-out', 'Account security', 'Customer sessions end after this long unused.', { kind: 'integer', min: 1, max: 90, unit: 'days' }, SECURITY),
  def('auth.customer_session_absolute_days', 'Customer session length', 'Account security', 'Customer sessions end this long after login.', { kind: 'integer', min: 1, max: 365, unit: 'days' }, SECURITY),
  def('auth.login_max_failures', 'Failed logins per email', 'Account security', 'Failed logins allowed per email within the window.', { kind: 'integer', min: 3, max: 50 }, SECURITY),
  def('auth.customer_login_max_failures_per_ip', 'Failed customer logins per IP', 'Account security', 'Failed customer logins allowed per IP within the window.', { kind: 'integer', min: 5, max: 500 }, SECURITY),
  def('auth.login_window_minutes', 'Failed-login window', 'Account security', 'Window for counting failed logins.', { kind: 'integer', min: 1, max: 1440, unit: 'minutes' }, SECURITY),
  def('security.checkout_orders_per_hour', 'Orders per customer per hour', 'Account security', 'Maximum orders one customer may create in an hour (checkout abuse limit).', { kind: 'integer', min: 1, max: 100, unit: 'orders' }, SECURITY),
  def('auth.token_ttl_minutes', 'One-time link lifetimes', 'Account security', 'How long email-verification, password-reset and staff-invitation links work.', { kind: 'object' }, SECURITY),
];
const byKey = new Map(SETTINGS_REGISTRY.map(d => [d.key, d]));

/** Business rules that live in code or deployment configuration, shown for reference (never editable here). */
export const POLICY_NOTES = [
  { label: 'Returns and refunds', value: 'None. All sales are final.', source: 'Business decision (2026-09-27); shown to customers in the store footer and at checkout.' },
  { label: 'Payment provider', value: 'Configured per deployment (off by default).', source: 'Website environment (PAYMENT_PROVIDER). Not set from the admin.' },
  { label: 'Shipping charges', value: 'Not set up yet (nothing is charged).', source: 'Shipping rules are not decided yet.' },
  { label: 'Discounts', value: 'None at launch.', source: 'Business decision (2026-09-27).' },
] as const;

export interface SettingRow extends SettingDef { value: unknown; updatedAt: Date | null; updatedBy: string | null; canEdit: boolean }

export async function listSettings(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'settings.read');
  const rows = await db.selectFrom('settings as s').leftJoin('staff_users as u', 'u.id', 's.updated_by')
    .select(['s.key', 's.value', 's.updated_at', 'u.email as updated_by_email']).orderBy('s.key').execute();
  const values = new Map(rows.map(r => [r.key, r]));
  const manage = can(actor, 'settings.manage');
  const items: SettingRow[] = SETTINGS_REGISTRY.map(d => {
    const r = values.get(d.key);
    return { ...d, value: r?.value ?? null, updatedAt: (r?.updated_at as Date | undefined) ?? null, updatedBy: r?.updated_by_email ?? null, canEdit: d.editable && manage };
  });
  const groups = [...new Set(items.map(i => i.group))].map(group => ({ group, items: items.filter(i => i.group === group) }));
  // Keys stored in the database that the registry does not describe: shown read-only, never editable.
  const unregistered = rows.filter(r => !byKey.has(r.key)).map(r => ({ key: r.key, value: r.value }));
  return { groups, unregistered, policies: POLICY_NOTES };
}

function parseValue(d: SettingDef, raw: string): unknown {
  if (d.type.kind === 'integer') {
    if (!/^\d{1,9}$/.test(raw)) throw new DomainError('invalid', 'Enter a whole number.');
    const n = Number(raw);
    if (n < d.type.min || n > d.type.max) throw new DomainError('invalid', `Enter a number from ${d.type.min} to ${d.type.max}.`);
    return n;
  }
  throw new DomainError('invalid', 'This setting cannot be changed here.');   // only integer settings are editable today
}

export async function updateSetting(db: Db, actor: StaffPrincipal, input: SettingUpdateInput, ctx: MutationContext) {
  requirePermission(actor, 'settings.manage');
  const d = byKey.get(input.key);
  if (!d) throw new NotFoundError('Unknown setting.');
  if (!d.editable) throw new ForbiddenError(d.lockedReason ?? 'This setting is locked.');
  const value = parseValue(d, input.value);
  return db.transaction().execute(async tx => {
    const before = await tx.selectFrom('settings').select('value').where('key', '=', d.key).forUpdate().executeTakeFirst();
    if (before && JSON.stringify(before.value) === JSON.stringify(value)) return { key: d.key, value, changed: false };
    await tx.insertInto('settings').values({ key: d.key, value: JSON.stringify(value), description: d.description, is_public: false, updated_by: actor.staffId })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: actor.staffId })).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'settings.update', entityType: 'settings', entityId: d.key,
      before: { value: before?.value ?? null }, after: { value }, metadata: { label: d.label }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { key: d.key, value, changed: true };
  });
}
