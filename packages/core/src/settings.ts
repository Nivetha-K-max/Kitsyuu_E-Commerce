/* Platform settings for staff (M8): a typed registry of the settings the platform uses. Every setting has a type, its
   allowed values, a description, the permission it needs and whether it may be changed here. Values that carry a
   business decision (M7) or an undecided business rule are LOCKED: shown, never editable from the admin. There is no
   generic editor and no way to create keys from the UI; only registry keys marked editable can change, one validated
   value at a time, with an audit record. */
import { recordAudit, type Db } from '@kitsyuu/db';
import { DomainError, ForbiddenError, INDIAN_STATES, NotFoundError, type SettingUpdateInput } from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { ALERT_KINDS } from './alerts.ts';

export type SettingType =
  | { kind: 'integer'; min: number; max: number; unit?: string }
  | { kind: 'text'; maxLength?: number; pattern?: string; patternHint?: string; multiline?: boolean; optional?: boolean }
  | { kind: 'choice'; options: readonly { value: string; label: string }[] }
  /** Rupees in the form, stored as integer paise. Optional money settings may be cleared (stored as null). */
  | { kind: 'money'; optional?: boolean }
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
const ON_OFF: SettingType = { kind: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] };
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
  // M10: details the business enters (nothing is pre-filled). Used on packing slips and, once tax rules are decided, invoices.
  def('company.legal_name', 'Legal name', 'Company', 'Registered business name, as printed on packing slips and invoices.', { kind: 'text', maxLength: 120, optional: true }),
  def('company.address', 'Registered address', 'Company', 'Full postal address (one line per row).', { kind: 'text', maxLength: 400, multiline: true, optional: true }),
  def('company.gstin', 'GSTIN', 'Company', 'GST identification number, if registered.',
    { kind: 'text', maxLength: 15, pattern: '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$', patternHint: '15 characters, e.g. 29ABCDE1234F1Z5', optional: true }),
  def('company.support_email', 'Customer support email', 'Company', 'Shown to customers on packing slips.',
    { kind: 'text', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', patternHint: 'an email address', optional: true }),
  def('company.phone', 'Phone', 'Company', 'Customer support phone number.', { kind: 'text', maxLength: 20, pattern: '^[+0-9 ()-]{6,20}$', patternHint: 'digits, spaces, + ( ) -', optional: true }),
  // M10: shipping is chosen by the business. Until a method is set, nothing is charged and the store says "Not set up yet".
  def('shipping.method', 'Delivery charge', 'Shipping', 'How delivery is charged at checkout. "Not set up" charges nothing and tells customers so.',
    { kind: 'choice', options: [{ value: 'none', label: 'Not set up (no charge)' }, { value: 'flat', label: 'Flat rate per order' }, { value: 'zones', label: 'By delivery zone (Shipping → Zones and rates)' }] }),
  def('shipping.flat_rate_paise', 'Flat delivery charge', 'Shipping', 'Charged once per order when the flat rate is chosen.', { kind: 'money' }),
  // M12: when a purchase counts as "bought" for reviews. Not decided yet, so it starts closed (no reviews can be written).
  def('reviews.eligibility', 'Who can review', 'Reviews', 'Customers can review an item once their order reaches this point. Reviews are always checked by staff before they appear.',
    { kind: 'choice', options: [{ value: 'off', label: 'Closed (no reviews yet)' }, { value: 'paid', label: 'After payment' }, { value: 'delivered', label: 'After delivery' }] }),
  // M17: which customer emails are sent is the business's choice; each starts off.
  def('notifications.order_shipped', 'Email when an order ships', 'Customer emails', 'Sends the customer an email (with the tracking number, if entered) when an order is marked shipped.',
    { kind: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] }),
  def('notifications.order_cancelled', 'Email when the shop cancels an order', 'Customer emails', 'Sends the customer an email when staff cancel an order.',
    { kind: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] }),
  def('shipping.free_from_paise', 'Free delivery from', 'Shipping', 'Orders at or above this amount ship free. Leave empty for no free delivery.', { kind: 'money', optional: true }),
  // ERP modules 1–8. Every switch starts OFF (no row = off) so the store behaves exactly as before until the business decides.
  def('discounts.enabled', 'Discounts and coupons', 'Discounts', 'Master switch. When off, no discount or coupon is applied at checkout, whatever is set up under Pricing.', ON_OFF),
  def('discounts.stacking', 'More than one discount', 'Discounts', 'When several discounts apply to one order: only the largest one, or all of them together.',
    { kind: 'choice', options: [{ value: 'best', label: 'Only the largest discount' }, { value: 'all', label: 'All applicable discounts' }] }),
  def('returns.enabled', 'Return requests', 'Returns', 'When on, customers can request a return from their order page (within the window below). When off, the store keeps saying all sales are final.', ON_OFF),
  def('returns.window_days', 'Return window', 'Returns', 'Days after delivery during which a return can be requested. With no value, customers cannot request returns.',
    { kind: 'integer', min: 1, max: 365, unit: 'days' }),
  def('carts.abandon_after_hours', 'Abandoned cart after', 'Carts', 'A cart with items that has not changed for this long counts as abandoned. With no value, no cart is treated as abandoned.',
    { kind: 'integer', min: 1, max: 24 * 60, unit: 'hours' }),
  def('company.state', 'Registered state', 'Company', 'State of the registered business. Used for the place of supply on invoices (CGST + SGST within the state, IGST outside it).',
    { kind: 'choice', options: [{ value: '', label: 'Not set' }, ...INDIAN_STATES.map(s => ({ value: s, label: s }))] }),
  def('notifications.order_delivered', 'Email when an order is delivered', 'Customer emails', 'Sends the customer an email when the delivery is marked delivered.', ON_OFF),
  def('notifications.return_status', 'Emails about return requests', 'Customer emails', 'Sends the customer an email when their return request is approved, rejected, needs information, or is completed.', ON_OFF),
  def('notifications.refund_processed', 'Email when a refund is made', 'Customer emails', 'Sends the customer an email when a refund is recorded as processed.', ON_OFF),
  def('notifications.support_reply', 'Email when staff reply to a ticket', 'Customer emails', 'Sends the customer an email when staff reply to their support ticket (internal notes are never sent).', ON_OFF),
  def('notifications.abandoned_cart', 'Abandoned-cart reminder emails', 'Customer emails', 'Allows staff to send a reminder email for an abandoned cart (never sent automatically).', ON_OFF),
  ...Object.entries(ALERT_KINDS).map(([kind, k]) => def(`alerts.${kind}`, k.label, 'Staff alerts',
    `Show "${k.label}" in the staff notification centre (seen by staff with ${k.permission}). On unless switched off.`,
    { kind: 'choice', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] })),
];
const byKey = new Map(SETTINGS_REGISTRY.map(d => [d.key, d]));

/** Business rules that live in code or deployment configuration, shown for reference (never editable here). */
export const POLICY_NOTES = [
  { label: 'Returns and refunds', value: 'None. All sales are final unless "Return requests" is switched on under Returns.', source: 'Business decision (2026-09-27); the returns workflow exists but stays off until the business changes that decision.' },
  { label: 'Payment provider', value: 'Configured per deployment (off by default).', source: 'Website environment (PAYMENT_PROVIDER). Not set from the admin.' },
  { label: 'Shipping charges', value: 'Set under Shipping above.', source: 'Chosen by the business; until then nothing is charged and the store says "Not set up yet".' },
  { label: 'Discounts', value: 'None at launch: off unless "Discounts and coupons" is switched on.', source: 'Business decision (2026-09-27). Discounts are set up under Pricing.' },
  { label: 'Cash on delivery', value: 'Not offered at checkout.', source: 'Rates can record whether COD is allowed and its fee, but COD checkout needs a business decision before it is switched on.' },
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
  const t = d.type;
  if (t.kind === 'text') {
    const v = t.multiline ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
    if (!v) { if (t.optional) return null; throw new DomainError('invalid', 'Enter a value.'); }
    if (t.maxLength && v.length > t.maxLength) throw new DomainError('invalid', `Keep it under ${t.maxLength} characters.`);
    if (t.pattern && !new RegExp(t.pattern).test(v)) throw new DomainError('invalid', `Use the right format${t.patternHint ? `: ${t.patternHint}` : ''}.`);
    return v;
  }
  if (t.kind === 'choice') {
    if (!t.options.some(o => o.value === raw)) throw new DomainError('invalid', 'Choose one of the options.');
    return raw;
  }
  if (t.kind === 'money') {
    const v = raw.trim().replace(/[₹,\s]/g, '');
    if (!v) { if (t.optional) return null; throw new DomainError('invalid', 'Enter an amount.'); }
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) throw new DomainError('invalid', 'Enter an amount in rupees, e.g. 99 or 99.50.');
    return Math.round(Number(v) * 100);
  }
  if (d.type.kind === 'integer') {
    if (!/^\d{1,9}$/.test(raw)) throw new DomainError('invalid', 'Enter a whole number.');
    const n = Number(raw);
    if (n < d.type.min || n > d.type.max) throw new DomainError('invalid', `Enter a number from ${d.type.min} to ${d.type.max}.`);
    return n;
  }
  throw new DomainError('invalid', 'This setting cannot be changed here.');   // boolean / object settings are locked
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

export type CompanyDetails = { legalName: string | null; address: string | null; gstin: string | null; supportEmail: string | null; phone: string | null };
/** Company details entered under Settings → Company (M10). Internal read for documents such as packing slips; the caller
    has already checked the permission for the document itself. Missing values are null (never invented). */
export async function companyDetails(q: Pick<Db, 'selectFrom'>): Promise<CompanyDetails> {
  const rows = await q.selectFrom('settings').select(['key', 'value']).where('key', 'like', 'company.%').execute();
  const v = (k: string) => { const x = rows.find(r => r.key === k)?.value; return typeof x === 'string' && x ? x : null; };
  return { legalName: v('company.legal_name'), address: v('company.address'), gstin: v('company.gstin'), supportEmail: v('company.support_email'), phone: v('company.phone') };
}
