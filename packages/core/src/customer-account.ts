/* Customer account (M6): the signed-in customer's profile, addresses and orders. Every function is scoped to
   `principal.customerId` in the SQL itself, so another customer's rows are never read or changed; a row that is not the
   customer's behaves exactly like one that does not exist (NotFoundError), so ids cannot be probed. Changes are audited
   in the same transaction. */
import { recordAudit, sql, type Db, type OrderStatus, type PaymentStatus } from '@kitsyuu/db';
import { ConflictError, NotFoundError, type AddressInput, type CustomerProfileInput } from '@kitsyuu/contracts';
import { customerOrderActions } from './checkout.ts';
import type { CustomerPrincipal, RequestContext } from '@kitsyuu/auth';

const audit = (p: CustomerPrincipal, ctx: RequestContext, action: string, entityType: string, entityId: string | null, extra: { before?: unknown; after?: unknown } = {}) =>
  ({ actorType: 'customer' as const, customerId: p.customerId, action, entityType, entityId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null, ...extra });

// ---------------------------------------------------------------- profile ----------------------------------------------------------------

export interface CustomerProfile {
  email: string; fullName: string | null; phone: string | null; emailVerified: boolean;
  createdAt: Date; passwordChangedAt: Date | null; lastLoginAt: Date | null;
}

export async function getCustomerProfile(db: Db, p: CustomerPrincipal): Promise<CustomerProfile> {
  const c = await db.selectFrom('customers')
    .select(['email', 'full_name', 'phone', 'email_verified_at', 'created_at', 'password_changed_at', 'last_login_at'])
    .where('id', '=', p.customerId).executeTakeFirst();
  if (!c) throw new NotFoundError('Account not found.');
  return { email: c.email, fullName: c.full_name, phone: c.phone, emailVerified: c.email_verified_at !== null,
    createdAt: c.created_at as Date, passwordChangedAt: c.password_changed_at, lastLoginAt: c.last_login_at };
}

export async function updateCustomerProfile(db: Db, p: CustomerPrincipal, input: CustomerProfileInput, ctx: RequestContext): Promise<void> {
  await db.transaction().execute(async tx => {
    const before = await tx.selectFrom('customers').select(['full_name', 'phone']).where('id', '=', p.customerId).forUpdate().executeTakeFirst();
    if (!before) throw new NotFoundError('Account not found.');
    await tx.updateTable('customers').set({ full_name: input.fullName, phone: input.phone }).where('id', '=', p.customerId).execute();
    await recordAudit(tx, audit(p, ctx, 'customer.profile_update', 'customers', p.customerId,
      { before: { full_name: before.full_name, phone: before.phone }, after: { full_name: input.fullName, phone: input.phone } }));
  });
}

// ---------------------------------------------------------------- addresses ----------------------------------------------------------------

export interface CustomerAddress {
  id: string; fullName: string; phone: string; line1: string; line2: string | null; city: string; state: string; pin: string;
  country: string; isDefault: boolean;
}
const MAX_ADDRESSES = 20;
const ADDRESS_COLUMNS = ['id', 'full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country', 'is_default'] as const;
type AddressRow = { id: string; full_name: string; phone: string; line1: string; line2: string | null; city: string; state: string; pin: string; country: string; is_default: boolean };
const toAddress = (r: AddressRow): CustomerAddress => ({ id: r.id, fullName: r.full_name, phone: r.phone, line1: r.line1, line2: r.line2,
  city: r.city, state: r.state, pin: r.pin, country: r.country, isDefault: r.is_default });

/** The customer's addresses, default first. */
export async function listCustomerAddresses(db: Db, p: CustomerPrincipal): Promise<CustomerAddress[]> {
  const rows = await db.selectFrom('addresses').select([...ADDRESS_COLUMNS]).where('customer_id', '=', p.customerId)
    .orderBy('is_default', 'desc').orderBy('created_at', 'desc').execute();
  return rows.map(toAddress);
}

export async function getCustomerAddress(db: Db, p: CustomerPrincipal, addressId: string): Promise<CustomerAddress> {
  const row = await db.selectFrom('addresses').select([...ADDRESS_COLUMNS]).where('id', '=', addressId).where('customer_id', '=', p.customerId).executeTakeFirst();
  if (!row) throw new NotFoundError('Address not found.');
  return toAddress(row);
}

/** Adds (no addressId) or updates one of the customer's addresses. The first address, or one marked default, becomes
    the only default. Returns the address id. */
export async function saveCustomerAddress(db: Db, p: CustomerPrincipal, input: AddressInput, ctx: RequestContext): Promise<string> {
  const values = { full_name: input.fullName, phone: input.phone, line1: input.line1, line2: input.line2, city: input.city, state: input.state, pin: input.pin };
  return db.transaction().execute(async tx => {
    // Lock the customer's row: concurrent saves then see each other's default changes.
    await tx.selectFrom('customers').select('id').where('id', '=', p.customerId).forUpdate().executeTakeFirstOrThrow();
    const count = (await tx.selectFrom('addresses').select(sql<number>`count(*)::int`.as('n')).where('customer_id', '=', p.customerId).executeTakeFirstOrThrow()).n;
    if (input.addressId) {
      const before = await tx.selectFrom('addresses').select([...ADDRESS_COLUMNS]).where('id', '=', input.addressId).where('customer_id', '=', p.customerId).executeTakeFirst();
      if (!before) throw new NotFoundError('Address not found.');
      const makeDefault = input.isDefault && !before.is_default;
      if (makeDefault) await tx.updateTable('addresses').set({ is_default: false }).where('customer_id', '=', p.customerId).where('is_default', '=', true).execute();
      await tx.updateTable('addresses').set({ ...values, ...(makeDefault ? { is_default: true } : {}) })
        .where('id', '=', input.addressId).where('customer_id', '=', p.customerId).execute();
      await recordAudit(tx, audit(p, ctx, 'customer.address_update', 'addresses', input.addressId, { before: toAddress(before), after: { ...values, is_default: before.is_default || makeDefault } }));
      return input.addressId;
    }
    if (count >= MAX_ADDRESSES) throw new ConflictError(`You can keep up to ${MAX_ADDRESSES} addresses. Remove one to add another.`);
    const isDefault = input.isDefault || count === 0;
    if (isDefault) await tx.updateTable('addresses').set({ is_default: false }).where('customer_id', '=', p.customerId).where('is_default', '=', true).execute();
    const row = await tx.insertInto('addresses').values({ ...values, customer_id: p.customerId, country: 'India', is_default: isDefault })
      .returning('id').executeTakeFirstOrThrow();
    await recordAudit(tx, audit(p, ctx, 'customer.address_create', 'addresses', row.id, { after: { ...values, is_default: isDefault } }));
    return row.id;
  });
}

export async function setDefaultCustomerAddress(db: Db, p: CustomerPrincipal, addressId: string, ctx: RequestContext): Promise<void> {
  await db.transaction().execute(async tx => {
    await tx.selectFrom('customers').select('id').where('id', '=', p.customerId).forUpdate().executeTakeFirstOrThrow();
    const target = await tx.selectFrom('addresses').select('id').where('id', '=', addressId).where('customer_id', '=', p.customerId).executeTakeFirst();
    if (!target) throw new NotFoundError('Address not found.');
    await tx.updateTable('addresses').set({ is_default: false }).where('customer_id', '=', p.customerId).where('is_default', '=', true).execute();
    await tx.updateTable('addresses').set({ is_default: true }).where('id', '=', addressId).where('customer_id', '=', p.customerId).execute();
    await recordAudit(tx, audit(p, ctx, 'customer.address_default', 'addresses', addressId));
  });
}

/** Deletes one of the customer's addresses; if it was the default, the most recent remaining address becomes default. */
export async function deleteCustomerAddress(db: Db, p: CustomerPrincipal, addressId: string, ctx: RequestContext): Promise<void> {
  await db.transaction().execute(async tx => {
    await tx.selectFrom('customers').select('id').where('id', '=', p.customerId).forUpdate().executeTakeFirstOrThrow();
    const gone = await tx.deleteFrom('addresses').where('id', '=', addressId).where('customer_id', '=', p.customerId)
      .returning([...ADDRESS_COLUMNS]).executeTakeFirst();
    if (!gone) throw new NotFoundError('Address not found.');
    if (gone.is_default) {
      const next = await tx.selectFrom('addresses').select('id').where('customer_id', '=', p.customerId).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      if (next) await tx.updateTable('addresses').set({ is_default: true }).where('id', '=', next.id).execute();
    }
    await recordAudit(tx, audit(p, ctx, 'customer.address_delete', 'addresses', addressId, { before: toAddress(gone) }));
  });
}

// ---------------------------------------------------------------- orders ----------------------------------------------------------------

/** Orders that belong to the customer: linked by customer_id, or (before M6) by the Supabase user id this customer mirrors. */
async function ownerFilter(db: Db, p: CustomerPrincipal) {
  const c = await db.selectFrom('customers').select('legacy_auth_user_id').where('id', '=', p.customerId).executeTakeFirst();
  const legacy = c?.legacy_auth_user_id ?? null;
  return { legacy };
}

export interface CustomerOrderSummary {
  orderNumber: string; createdAt: Date; status: OrderStatus; paymentStatus: PaymentStatus | null; totalPaise: number; currency: string; units: number; lines: number;
}

export async function listCustomerOrders(db: Db, p: CustomerPrincipal): Promise<CustomerOrderSummary[]> {
  const { legacy } = await ownerFilter(db, p);
  const rows = await db.selectFrom('orders as o')
    .select(['o.order_number', 'o.created_at', 'o.status', 'o.payment_status', 'o.total_paise', 'o.currency',
      sql<number>`(select coalesce(sum(i.qty), 0)::int from order_items i where i.order_id = o.id)`.as('units'),
      sql<number>`(select count(*)::int from order_items i where i.order_id = o.id)`.as('lines')])
    .where(eb => eb.or([
      eb('o.customer_id', '=', p.customerId),
      ...(legacy ? [eb.and([eb('o.customer_id', 'is', null), eb('o.user_id', '=', legacy)])] : []),
    ]))
    .orderBy('o.created_at', 'desc').limit(100).execute();
  return rows.map(r => ({ orderNumber: r.order_number, createdAt: r.created_at as Date, status: r.status, paymentStatus: r.payment_status,
    totalPaise: r.total_paise, currency: r.currency, units: r.units, lines: r.lines }));
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  paidAt: Date | null;
  subtotalPaise: number; discountPaise: number; shippingPaise: number; taxPaise: number; pricesIncludeTax: boolean;
  contact: { name: string | null; email: string | null; phone: string | null };
  /** Unpaid orders: until when the items are held. */
  paymentExpiresAt: Date | null;
  /** The customer can pay (again) / cancel this order now. */
  canPay: boolean; canCancel: boolean;
  items: { sku: string; name: string; size: string; imagePath: string | null; productId: string | null; unitPricePaise: number; qty: number; lineTotalPaise: number }[];
  shipping: { name: string | null; phone: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null; country: string | null };
  /** Client change request: null when billing is the delivery address. */
  billing: { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null } | null;
  /** Second pass: cash on delivery (to collect / collected / refused) and its fee; loyalty points used on the order. */
  paymentMethod: 'online' | 'cod'; codStatus: 'to_collect' | 'collected' | 'refused' | null; codFeePaise: number;
  pointsUsed: number; pointsDiscountPaise: number;
  history: { status: OrderStatus; at: Date }[];
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One of the customer's orders by its order number; NotFoundError if it is not theirs. */
export async function getCustomerOrder(db: Db, p: CustomerPrincipal, orderNumber: string): Promise<CustomerOrderDetail> {
  const { legacy } = await ownerFilter(db, p);
  const o = await db.selectFrom('orders as o')
    .select(['o.id', 'o.order_number', 'o.created_at', 'o.status', 'o.payment_status', 'o.total_paise', 'o.subtotal_paise', 'o.currency', 'o.paid_at', 'o.shipping_address',
      'o.contact', 'o.discount_paise', 'o.shipping_paise', 'o.tax_paise', 'o.prices_include_tax', 'o.payment_expires_at', 'o.customer_id', 'o.billing_address',
      'o.payment_method', 'o.cod_status', 'o.cod_fee_paise', 'o.loyalty_points_used', 'o.loyalty_discount_paise'])
    .where('o.order_number', '=', orderNumber)
    .where(eb => eb.or([
      eb('o.customer_id', '=', p.customerId),
      ...(legacy ? [eb.and([eb('o.customer_id', 'is', null), eb('o.user_id', '=', legacy)])] : []),
    ]))
    .executeTakeFirst();
  if (!o) throw new NotFoundError('Order not found.');
  const [items, history] = await Promise.all([
    db.selectFrom('order_items').select(['sku', 'name', 'size', 'image_path', 'product_id', 'unit_price_paise', 'qty', 'line_total_paise'])
      .where('order_id', '=', o.id).orderBy('name').execute(),
    db.selectFrom('order_status_history').select(['to_status', 'created_at']).where('order_id', '=', o.id).orderBy('created_at').execute(),
  ]);
  const a = (o.shipping_address ?? {}) as Record<string, unknown>;
  const c = (o.contact ?? {}) as Record<string, unknown>;
  const actions = customerOrderActions(o, true);
  return {
    orderNumber: o.order_number, createdAt: o.created_at as Date, status: o.status, paymentStatus: o.payment_status, totalPaise: o.total_paise,
    subtotalPaise: o.subtotal_paise, discountPaise: o.discount_paise, shippingPaise: o.shipping_paise, taxPaise: o.tax_paise, pricesIncludeTax: o.prices_include_tax,
    currency: o.currency, paidAt: o.paid_at,
    contact: { name: text(c.name), email: text(c.email), phone: text(c.phone) },
    paymentExpiresAt: actions.canPay ? (o.payment_expires_at as Date | null) : null,
    // Asked of the order workflow. canPay assumes a payment provider is configured; the website also checks that.
    canPay: actions.canPay, canCancel: actions.canCancel,
    units: items.reduce((n, i) => n + i.qty, 0), lines: items.length,
    items: items.map(i => ({ sku: i.sku, name: i.name, size: i.size, imagePath: i.image_path, productId: i.product_id, unitPricePaise: i.unit_price_paise, qty: i.qty, lineTotalPaise: i.line_total_paise })),
    shipping: { name: text(a.name ?? a.full_name), phone: text(a.phone), line1: text(a.line1), line2: text(a.line2), city: text(a.city), state: text(a.state), pin: text(a.pin), country: text(a.country) },
    history: history.map(h => ({ status: h.to_status, at: h.created_at as Date })),
    paymentMethod: o.payment_method, codStatus: o.cod_status, codFeePaise: o.cod_fee_paise, pointsUsed: o.loyalty_points_used, pointsDiscountPaise: o.loyalty_discount_paise,
    billing: o.billing_address ? (b => ({ name: text(b.name), line1: text(b.line1), line2: text(b.line2), city: text(b.city), state: text(b.state), pin: text(b.pin) }))(o.billing_address as Record<string, unknown>) : null,
  };
}
