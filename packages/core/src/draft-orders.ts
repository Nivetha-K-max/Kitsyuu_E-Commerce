/* Draft orders and orders created by staff (2026-10-01).

   A draft order is an order being prepared by staff: the customer (or, at a branch, a walk-in contact), the items, a staff
   discount within the limits, delivery / billing addresses and notes. It holds no stock and is not an order. Confirming it
   creates a real order in the same orders table, through the same pricing (priceOrder), the same stock ledger and the
   same order workflow as a customer's checkout:
   - online, paid online: the order waits for payment (pending_payment) with its stock held like a checkout; the customer
     pays it from their account (Orders → Pay), and can be sent the link by email;
   - online, cash on delivery: only where the store's COD rules allow it (as at checkout); the order goes to fulfilment;
   - offline at a branch (channel retail): paid in the store (cash / card / UPI) and handed over; the stock is taken from
     that branch (sell_order_at_location), not from the online stock.
   Staff discount: a % of the items, never above the maximum set in Settings → Discounts ("Maximum staff discount"; with no
   value staff cannot give discounts), and never below a product's minimum price (Products → Minimum price). It is checked
   when it is entered and again when the draft is confirmed, and kept on the order (amount, %, reason, who gave it). */
import { recordAudit, sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, MAX_QTY_PER_LINE } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { priceOrder, defaultCommerceConfig, type CartTotals, type CommerceConfig, type DiscountRule, type ShippingProvider } from './pricing.ts';
import { lineLabel, lineProblemText, pricedLine, variantQuery, type PricedLine } from './cart.ts';
import { checkoutSettings } from './checkout.ts';
import { earnForOrder } from './loyalty.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (c: MutationContext) => ({ ip: c.ip, userAgent: c.userAgent, requestId: c.requestId });
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

export type Address = { name: string; phone: string; line1: string; line2: string | null; city: string; state: string; pin: string; country: string };
/** An address as typed in a form: any field may be missing or empty until it is checked. */
export type AddressInput = { [K in keyof Address]?: Address[K] | null };
export type Contact = { name: string | null; email: string | null; phone: string | null };
export type DraftPayment = 'online' | 'cod' | 'cash' | 'card' | 'upi';
export const IN_STORE_PAYMENTS = ['cash', 'card', 'upi'] as const;

/** Offline orders are handed over in the store: nothing is delivered, so nothing is charged for delivery. */
export const inStore: ShippingProvider = { code: 'in_store', quote: async () => ({ amountPaise: 0, method: 'in_store', label: 'Collected in store', configured: true }) };

// ---------------------------------------------------------------- staff discount limits
/** The largest staff discount (basis points), or null: no maximum set, so staff cannot give discounts. */
export async function staffDiscountMaxBp(q: Queryable): Promise<number | null> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'discounts.staff_max_percent').executeTakeFirst();
  const n = Number(r?.value);
  return r && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Checks a staff discount of `bp` on these lines; returns its amount or throws the reason it is refused. */
export async function checkStaffDiscount(q: Queryable, lines: Pick<PricedLine, 'productId' | 'name' | 'size' | 'colourLabel' | 'unitPaise' | 'lineTotalPaise'>[], bp: number) {
  const max = await staffDiscountMaxBp(q);
  if (max === null) throw new DomainError('invalid', 'Staff discounts are not set up: a maximum staff discount must be set in Settings → Discounts first.');
  if (!Number.isInteger(bp) || bp < 1) throw new DomainError('invalid', 'Enter a discount above 0%.');
  if (bp > max) throw new DomainError('invalid', `${pct(bp)} is above the maximum staff discount of ${pct(max)}.`);
  const ids = [...new Set(lines.map(l => l.productId))];
  const mins = new Map((ids.length ? await q.selectFrom('products').select(['id', 'min_price_paise']).where('id', 'in', ids).execute() : []).map(r => [r.id, r.min_price_paise]));
  for (const l of lines) {
    const min = mins.get(l.productId), net = Math.floor(l.unitPaise * (10_000 - bp) / 10_000);
    if (min && net < min) throw new DomainError('invalid', `${lineLabel(l)}: ${inr(l.unitPaise)} less ${pct(bp)} is ${inr(net)}, below its minimum price of ${inr(min)}.`);
  }
  return Math.round(lines.reduce((n, l) => n + l.lineTotalPaise, 0) * bp / 10_000);
}

/** The staff discount as a pricing rule, so totals, tax and invoices treat it like any other discount. */
export const staffRule = (bp: number, reason: string): DiscountRule => ({
  code: 'STAFF', label: `Staff discount ${pct(bp)}: ${reason}`,
  evaluate: async ({ subtotalPaise }) => Math.round(subtotalPaise * bp / 10_000),
});

// ---------------------------------------------------------------- reading
async function draftLines(q: Queryable, draftId: string): Promise<PricedLine[]> {
  const items = await q.selectFrom('draft_order_items').select(['variant_id', 'qty']).where('draft_id', '=', draftId).orderBy('created_at').orderBy('id').execute();
  if (!items.length) return [];
  const rows = new Map((await variantQuery(q).where('v.id', 'in', items.map(i => i.variant_id)).execute()).map(r => [r.variant_id, r]));
  // A size of a product that is no longer on sale is shown as unavailable (it cannot be confirmed).
  return items.map(i => {
    const v = rows.get(i.variant_id);
    return v ? pricedLine(v, i.qty) : null;
  }).filter((l): l is PricedLine => !!l);
}

type DraftRow = Awaited<ReturnType<typeof loadDraft>>;
async function loadDraft(q: Queryable, id: string, lock = false) {
  let query = q.selectFrom('draft_orders').selectAll().where('id', '=', id);
  if (lock) query = query.forUpdate();
  const d = await query.executeTakeFirst();
  if (!d) throw new NotFoundError('Draft order not found.');
  return d;
}

function pricingConfig(d: { channel: string; discount_bp: number | null; discount_reason: string | null }, config?: CommerceConfig): CommerceConfig {
  const base = config ?? defaultCommerceConfig;
  // Staff orders carry only the staff discount (no automatic coupons or rules): what staff agreed with the customer.
  return { shipping: d.channel === 'retail' ? inStore : base.shipping, discounts: d.discount_bp ? [staffRule(d.discount_bp, d.discount_reason ?? '')] : [] };
}

async function priceDraft(q: Queryable, d: NonNullable<DraftRow>, lines: PricedLine[], payment: DraftPayment, config?: CommerceConfig): Promise<CartTotals> {
  const ship = d.shipping_address as Address | null;
  return priceOrder(q, lines.filter(l => !l.problem), {
    config: pricingConfig(d, config), customerId: d.customer_id,
    shipTo: d.channel === 'online' && ship ? { state: ship.state, pin: ship.pin, country: ship.country || 'India', deliveryRateId: null } : null,
    payment: d.channel === 'online' ? { method: payment === 'cod' ? 'cod' : 'online', usePoints: false } : null,
  });
}

export async function listDraftOrders(db: Db, actor: StaffPrincipal, opts: { status?: 'open' | 'confirmed' | 'cancelled' | 'all'; customerId?: string } = {}) {
  requirePermission(actor, 'orders.read');
  let q = db.selectFrom('draft_orders as d').leftJoin('customers as c', 'c.id', 'd.customer_id').leftJoin('staff_users as s', 's.id', 'd.owner_id')
    .leftJoin('locations as l', 'l.id', 'd.location_id').leftJoin('orders as o', 'o.id', 'd.order_id')
    .select(['d.id', 'd.number', 'd.status', 'd.channel', 'd.contact', 'd.discount_bp', 'd.created_at', 'd.updated_at', 'c.email as customer_email', 'c.full_name as customer_name',
      's.email as owner_email', 'l.name as location_name', 'o.order_number', 'd.order_id',
      sql<number>`(select coalesce(sum(i.qty), 0)::int from public.draft_order_items i where i.draft_id = d.id)`.as('units')])
    .orderBy('d.updated_at', 'desc').limit(200);
  if (opts.status && opts.status !== 'all') q = q.where('d.status', '=', opts.status);
  else if (!opts.status) q = q.where('d.status', '=', 'open');
  if (opts.customerId) q = q.where('d.customer_id', '=', opts.customerId);
  return q.execute();
}

/** A draft with its priced lines and totals (for the payment method shown), its customer and branch. */
export async function getDraftOrder(db: Db, actor: StaffPrincipal, id: string, opts: { payment?: DraftPayment; config?: CommerceConfig } = {}) {
  requirePermission(actor, 'orders.read');
  const d = await loadDraft(db, id);
  const lines = await draftLines(db, id);
  const payment = opts.payment ?? (d.channel === 'retail' ? 'cash' : 'online');
  const totals = await priceDraft(db, d, lines, payment, opts.config);
  const [customer, location, owner, addresses, maxBp] = await Promise.all([
    d.customer_id ? db.selectFrom('customers').select(['id', 'email', 'full_name', 'phone']).where('id', '=', d.customer_id).executeTakeFirst() : null,
    d.location_id ? db.selectFrom('locations').select(['id', 'name', 'code']).where('id', '=', d.location_id).executeTakeFirst() : null,
    d.owner_id ? db.selectFrom('staff_users').select(['email', 'full_name']).where('id', '=', d.owner_id).executeTakeFirst() : null,
    d.customer_id ? db.selectFrom('addresses').select(['id', 'full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country', 'is_default'])
      .where('customer_id', '=', d.customer_id).orderBy('is_default', 'desc').orderBy('created_at').execute() : [],
    staffDiscountMaxBp(db),
  ]);
  return { draft: d, lines, totals, payment, customer, location, owner, addresses, maxDiscountBp: maxBp,
    canConfirm: d.status === 'open' && lines.length > 0 && lines.every(l => !l.problem) && (d.channel === 'retail' || !!d.shipping_address) };
}

/** The sizes staff can add to a draft, with the stock that counts for it (online stock, or the branch's own stock). */
export async function draftSizeOptions(db: Db, actor: StaffPrincipal, draftId: string) {
  requirePermission(actor, 'orders.read');
  const d = await loadDraft(db, draftId);
  const rows = await variantQuery(db).where('v.is_active', '=', true).orderBy('p.name').orderBy('v.colour_slug').orderBy('v.sort_order').execute();
  const branch = d.channel === 'retail' && d.location_id
    ? new Map((await db.selectFrom('location_stock').select(['variant_id', 'qty']).where('location_id', '=', d.location_id).execute()).map(r => [r.variant_id, r.qty]))
    : null;
  return rows.map(v => ({ variantId: v.variant_id, label: lineLabel(pricedLine(v, 1)), sku: v.sku, unitPaise: v.unit_paise, inStock: branch ? (branch.get(v.variant_id) ?? 0) : v.stock_qty }));
}

// ---------------------------------------------------------------- changing a draft
async function openDraft(tx: Tx, id: string) {
  const d = await loadDraft(tx, id, true);
  if (d.status !== 'open') throw new ConflictError(`Draft ${d.number} is ${d.status}; it can no longer be changed.`);
  return d;
}
const touch = (tx: Tx, id: string) => tx.updateTable('draft_orders').set({ updated_at: sql`now()` }).where('id', '=', id).execute();

export async function createDraftOrder(db: Db, actor: StaffPrincipal, input: { channel: 'online' | 'retail'; customerId?: string | null; locationId?: string | null; contact?: Partial<Contact>; note?: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'orders.create');
  return db.transaction().execute(async tx => {
    let contact: Contact = { name: input.contact?.name?.trim() || null, email: input.contact?.email?.trim().toLowerCase() || null, phone: input.contact?.phone?.trim() || null };
    if (input.customerId) {
      const c = await tx.selectFrom('customers').select(['id', 'email', 'full_name', 'phone', 'status']).where('id', '=', input.customerId).executeTakeFirst();
      if (!c) throw new NotFoundError('Customer not found.');
      if (c.status !== 'active') throw new ConflictError('This customer account is disabled.');
      contact = { name: c.full_name, email: c.email, phone: c.phone };
    } else if (input.channel === 'online') throw new DomainError('invalid', 'Choose the customer: an online order is paid and tracked from their account.');
    else if (!contact.name && !contact.phone) throw new DomainError('invalid', 'Enter the customer’s name or phone number.');
    if (input.channel === 'retail') {
      const l = input.locationId ? await tx.selectFrom('locations').select(['is_online', 'is_active', 'name']).where('id', '=', input.locationId).executeTakeFirst() : null;
      if (!l) throw new DomainError('invalid', 'Choose the branch where the customer is buying.');
      if (l.is_online) throw new DomainError('invalid', `${l.name} is the online stock, not a branch: choose a retail location.`);
      if (!l.is_active) throw new ConflictError(`${l.name} is inactive.`);
    }
    const number = (await sql<{ n: string }>`select public.next_document_number('draft_order', 'DRAFT') as n`.execute(tx)).rows[0].n;
    // The customer's default address is the delivery address to start with (staff can change it).
    const def = input.customerId && input.channel === 'online' ? await tx.selectFrom('addresses').select(['full_name', 'phone', 'line1', 'line2', 'city', 'state', 'pin', 'country'])
      .where('customer_id', '=', input.customerId).orderBy('is_default', 'desc').orderBy('created_at').executeTakeFirst() : null;
    const row = await tx.insertInto('draft_orders').values({
      number, channel: input.channel, customer_id: input.customerId ?? null, location_id: input.channel === 'retail' ? input.locationId! : null,
      contact: JSON.stringify(contact), note: input.note?.trim() || null, owner_id: actor.staffId,
      shipping_address: def ? JSON.stringify({ name: def.full_name, phone: def.phone, line1: def.line1, line2: def.line2, city: def.city, state: def.state, pin: def.pin, country: def.country }) : null,
    }).returning(['id', 'number']).executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.create', entityType: 'draft_orders', entityId: row.id,
      after: { number, channel: input.channel, customer_id: input.customerId ?? null, location_id: input.locationId ?? null }, ...auditCtx(ctx) });
    return row;
  });
}

/** Sets the quantity of a size on the draft (0 removes it). Stock is checked here and again when the draft is confirmed. */
export async function setDraftItem(db: Db, actor: StaffPrincipal, input: { draftId: string; variantId: string; qty: number }, ctx: MutationContext) {
  requirePermission(actor, 'orders.create');
  if (!Number.isInteger(input.qty) || input.qty < 0 || input.qty > MAX_QTY_PER_LINE) throw new DomainError('invalid', `Enter a quantity from 0 to ${MAX_QTY_PER_LINE}.`);
  return db.transaction().execute(async tx => {
    const d = await openDraft(tx, input.draftId);
    if (input.qty === 0) {
      await tx.deleteFrom('draft_order_items').where('draft_id', '=', d.id).where('variant_id', '=', input.variantId).execute();
    } else {
      const v = await variantQuery(tx).where('v.id', '=', input.variantId).executeTakeFirst();
      if (!v) throw new NotFoundError('That size is not on sale.');
      const line = pricedLine(v, input.qty);
      // At a branch the stock that counts is the branch's own.
      const have = d.channel === 'retail'
        ? (await tx.selectFrom('location_stock').select('qty').where('location_id', '=', d.location_id!).where('variant_id', '=', v.variant_id).executeTakeFirst())?.qty ?? 0
        : v.stock_qty;
      if (!v.is_active) throw new ConflictError(`${lineLabel(line)} is not offered.`);
      if (have < input.qty) throw new ConflictError(`Only ${have} of ${lineLabel(line)} ${have === 1 ? 'is' : 'are'} in stock${d.channel === 'retail' ? ' at this branch' : ''}.`);
      if (d.discount_bp) await checkStaffDiscount(tx, [line], d.discount_bp);
      await tx.insertInto('draft_order_items').values({ draft_id: d.id, variant_id: v.variant_id, qty: input.qty })
        .onConflict(oc => oc.columns(['draft_id', 'variant_id']).doUpdateSet({ qty: input.qty })).execute();
    }
    await touch(tx, d.id);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.item', entityType: 'draft_orders', entityId: d.id, after: { variant_id: input.variantId, qty: input.qty }, ...auditCtx(ctx) });
  });
}

const addressOk = (a: AddressInput | null | undefined): a is Address => !!a && !!a.name?.trim() && /^[6-9][0-9]{9}$/.test(String(a.phone ?? '').replace(/\D/g, '').slice(-10))
  && !!a.line1?.trim() && !!a.city?.trim() && !!a.state?.trim() && /^[1-9][0-9]{5}$/.test(String(a.pin ?? ''));
const cleanAddress = (a: Address): Address => ({ name: a.name.trim(), phone: String(a.phone).replace(/\D/g, '').slice(-10), line1: a.line1.trim(), line2: a.line2?.trim() || null,
  city: a.city.trim(), state: a.state.trim(), pin: String(a.pin).trim(), country: a.country?.trim() || 'India' });

/** Delivery address and billing address (null billing = same as delivery). Stored on the draft and copied onto the order. */
export async function setDraftAddresses(db: Db, actor: StaffPrincipal, input: { draftId: string; shipping: AddressInput; billingSame: boolean; billing?: AddressInput | null }, ctx: MutationContext) {
  requirePermission(actor, 'orders.create');
  if (!addressOk(input.shipping)) throw new DomainError('invalid', 'Enter the full delivery address: name, a 10-digit mobile number, address line, city, state and a 6-digit PIN.');
  if (!input.billingSame && !addressOk(input.billing)) throw new DomainError('invalid', 'Enter the full billing address, or tick "Billing address is the same as the delivery address".');
  return db.transaction().execute(async tx => {
    const d = await openDraft(tx, input.draftId);
    if (d.channel !== 'online') throw new ConflictError('An order at a branch is handed over in the store: it has no delivery address.');
    await tx.updateTable('draft_orders').set({ shipping_address: JSON.stringify(cleanAddress(input.shipping as Address)),
      billing_address: input.billingSame ? null : JSON.stringify(cleanAddress(input.billing as Address)) }).where('id', '=', d.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.addresses', entityType: 'draft_orders', entityId: d.id, after: { billing_same: input.billingSame }, ...auditCtx(ctx) });
  });
}

/** Gives (or removes, with 0) the staff discount. Refused above the maximum or below a product's minimum price. */
export async function setDraftDiscount(db: Db, actor: StaffPrincipal, input: { draftId: string; percent: number; reason: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'orders.discount');
  const bp = Math.round(input.percent * 100), reason = input.reason?.trim() || null;
  return db.transaction().execute(async tx => {
    const d = await openDraft(tx, input.draftId);
    if (bp > 0) {
      if (!reason || reason.length < 3) throw new DomainError('invalid', 'Enter the reason for the discount (e.g. "Customer loyalty discount").');
      await checkStaffDiscount(tx, await draftLines(tx, d.id), bp);
    }
    await tx.updateTable('draft_orders').set({ discount_bp: bp > 0 ? bp : null, discount_reason: bp > 0 ? reason!.slice(0, 200) : null }).where('id', '=', d.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.discount', entityType: 'draft_orders', entityId: d.id,
      before: { discount_bp: d.discount_bp, reason: d.discount_reason }, after: { discount_bp: bp > 0 ? bp : null, reason }, ...auditCtx(ctx) });
  });
}

export async function setDraftNote(db: Db, actor: StaffPrincipal, input: { draftId: string; note: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'orders.create');
  return db.transaction().execute(async tx => {
    const d = await openDraft(tx, input.draftId);
    const note = input.note?.trim().slice(0, 1000) || null;
    await tx.updateTable('draft_orders').set({ note }).where('id', '=', d.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.note', entityType: 'draft_orders', entityId: d.id, after: { note }, ...auditCtx(ctx) });
  });
}

export async function cancelDraftOrder(db: Db, actor: StaffPrincipal, input: { draftId: string }, ctx: MutationContext) {
  requirePermission(actor, 'orders.create');
  return db.transaction().execute(async tx => {
    const d = await openDraft(tx, input.draftId);
    await tx.updateTable('draft_orders').set({ status: 'cancelled', cancelled_at: sql`now()` }).where('id', '=', d.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'draft_order.cancel', entityType: 'draft_orders', entityId: d.id, before: { status: 'open' }, after: { status: 'cancelled' }, ...auditCtx(ctx) });
  });
}

// ---------------------------------------------------------------- confirming: the draft becomes an order
const PAYMENT_LABEL: Record<DraftPayment, string> = { online: 'online payment', cod: 'cash on delivery', cash: 'cash', card: 'card', upi: 'UPI' };

/** Creates the order from the draft (see the top of this file). expectedTotalPaise: the total the staff member saw. */
export async function confirmDraftOrder(db: Db, actor: StaffPrincipal, input: { draftId: string; payment: DraftPayment; expectedTotalPaise: number }, ctx: MutationContext, config?: CommerceConfig)
  : Promise<{ orderId: string; orderNumber: string; status: string; channel: 'online' | 'retail'; payment: DraftPayment }> {
  requirePermission(actor, 'orders.create');
  const { paymentWindowMinutes } = await checkoutSettings(db);
  try {
    return await db.transaction().execute(async tx => {
      const d = await openDraft(tx, input.draftId);
      const retail = d.channel === 'retail';
      if (retail !== (IN_STORE_PAYMENTS as readonly string[]).includes(input.payment))
        throw new DomainError('invalid', retail ? 'An order at a branch is paid in the store: cash, card or UPI.' : 'Choose online payment or cash on delivery.');
      const lines = await draftLines(tx, d.id);
      if (!lines.length) throw new ConflictError('Add at least one item to the draft.');
      // Branch orders: the branch's own stock must cover every line.
      if (retail) for (const l of lines) {
        const have = (await tx.selectFrom('location_stock').select('qty').where('location_id', '=', d.location_id!).where('variant_id', '=', l.variantId).executeTakeFirst())?.qty ?? 0;
        if (have < l.qty) throw new ConflictError(`Only ${have} of ${lineLabel(l)} ${have === 1 ? 'is' : 'are'} in stock at this branch.`);
      } else {
        const problems = lines.filter(l => l.problem).map(lineProblemText);
        if (problems.length) throw new ConflictError(`${problems.join(' ')} Update the draft and try again.`);
      }
      const ship = d.shipping_address as Address | null;
      if (!retail && !ship) throw new ConflictError('Enter the delivery address first.');
      if (d.discount_bp) await checkStaffDiscount(tx, lines, d.discount_bp);
      const t = await priceDraft(tx, d, lines, input.payment, config);
      if (t.shipping.unavailable) throw new ConflictError(t.shipping.unavailable);
      const cod = input.payment === 'cod';
      if (cod && t.payment?.method !== 'cod') throw new ConflictError(t.payment?.cod.reason ?? 'Cash on delivery is not available for this order.');
      if (t.totalPaise !== input.expectedTotalPaise) throw new ConflictError('Prices, stock or delivery charges changed since this page was opened. Check the draft and confirm again.');
      const staffDiscount = t.discounts.find(x => x.code === 'STAFF')?.amountPaise ?? 0;
      const contact = d.contact as Contact;
      const location = retail ? await tx.selectFrom('locations').select(['name', 'address']).where('id', '=', d.location_id!).executeTakeFirstOrThrow() : null;

      const order = await tx.insertInto('orders').values({
        customer_id: d.customer_id, cart_id: null, idempotency_key: `draft-${d.id.replace(/-/g, '')}`,
        status: retail ? 'delivered' : 'pending_payment', payment_status: retail ? 'paid' : 'pending', currency: 'INR',
        subtotal_paise: t.subtotalPaise, discount_paise: t.discountPaise, shipping_paise: t.shippingPaise, tax_paise: t.taxPaise,
        total_paise: t.totalPaise, prices_include_tax: t.pricesIncludeTax,
        pricing: JSON.stringify({ tax: t.tax, shipping: t.shipping, discounts: t.discounts, ...(cod ? { cod: { feePaise: t.codFeePaise } } : {}), source: { draft: d.number } }),
        payment_method: input.payment, cod_status: cod ? 'to_collect' : null, cod_fee_paise: t.codFeePaise,
        contact: JSON.stringify(contact),
        // A branch sale has no delivery: its address is the branch (shown on the invoice as where it was sold).
        shipping_address: JSON.stringify(retail ? { name: contact.name ?? 'Walk-in customer', phone: contact.phone, line1: location!.name, line2: location!.address, city: '', state: '', pin: '', country: 'India' } : ship),
        billing_address: d.billing_address ? JSON.stringify(d.billing_address) : null,
        channel: d.channel, location_id: d.location_id, created_by: actor.staffId, draft_order_id: d.id,
        staff_discount_paise: staffDiscount, staff_discount_bp: staffDiscount ? d.discount_bp : null,
        staff_discount_reason: staffDiscount ? d.discount_reason : null, staff_discount_by: staffDiscount ? actor.staffId : null,
        paid_at: retail ? sql<Date>`now()` : null,
        payment_expires_at: !retail && !cod && paymentWindowMinutes ? sql<Date>`now() + make_interval(mins => ${paymentWindowMinutes})` : null,
      }).returning(['id', 'order_number']).executeTakeFirstOrThrow();
      await tx.insertInto('order_items').values(lines.map(l => ({
        order_id: order.id, product_id: l.productId, variant_id: l.variantId, sku: l.sku, name: l.name, size: l.size, colour: l.colourLabel,
        image_path: l.imagePath, unit_price_paise: l.unitPaise, qty: l.qty, line_total_paise: l.lineTotalPaise,
      }))).execute();
      const by = `by staff (draft ${d.number})`;
      if (retail) {
        await tx.insertInto('order_status_history').values([
          { order_id: order.id, from_status: null, to_status: 'paid', note: `Paid in store (${PAYMENT_LABEL[input.payment]}) at ${location!.name}, ${by}` },
          { order_id: order.id, from_status: 'paid', to_status: 'delivered', note: `Handed over at ${location!.name}` },
        ]).execute();
        await sql`select public.sell_order_at_location(${order.id}::uuid, ${actor.staffId}::uuid)`.execute(tx);
        // Loyalty points for a customer with an account (2026-10-01): a branch sale is paid and handed over at once, so it
        // earns under either rule ("when paid" / "when delivered"); earnForOrder never awards an order twice.
        if (d.customer_id) { await earnForOrder(tx, order.id, 'paid'); await earnForOrder(tx, order.id, 'delivered'); }
      } else {
        await tx.insertInto('order_status_history').values({ order_id: order.id, from_status: null, to_status: 'pending_payment', note: `Order created ${by}` }).execute();
        // Same as a checkout: the order takes its stock now and keeps it while it waits for payment.
        await sql`select public.reserve_order_stock(${order.id}::uuid)`.execute(tx);
        if (cod) {
          await tx.updateTable('orders').set({ status: 'processing', payment_status: 'unpaid' }).where('id', '=', order.id).execute();
          await tx.insertInto('order_status_history').values({ order_id: order.id, from_status: 'pending_payment', to_status: 'processing', note: 'Cash on delivery: confirmed for fulfilment' }).execute();
        }
      }
      await tx.updateTable('draft_orders').set({ status: 'confirmed', order_id: order.id, confirmed_at: sql`now()` }).where('id', '=', d.id).execute();
      const status = retail ? 'delivered' : cod ? 'processing' : 'pending_payment';
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.created_by_staff', entityType: 'orders', entityId: order.id,
        after: { status, channel: d.channel, location_id: d.location_id, payment_method: input.payment, total_paise: t.totalPaise, staff_discount_paise: staffDiscount },
        metadata: { order_number: order.order_number, draft: d.number, units: t.units, ...(staffDiscount ? { discount_bp: d.discount_bp, discount_reason: d.discount_reason } : {}) }, ...auditCtx(ctx) });
      return { orderId: order.id, orderNumber: order.order_number, status, channel: d.channel, payment: input.payment };
    });
  } catch (e) {
    if ((e as { code?: string })?.code === '23514') throw new ConflictError('Part of this order just sold out. Check the draft and try again.');
    throw e;
  }
}

/** Where an order came from: online or offline (and the branch), who created it (staff), its staff discount and draft. */
export async function orderOrigin(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'orders.read');
  return db.selectFrom('orders as o').leftJoin('locations as l', 'l.id', 'o.location_id').leftJoin('staff_users as c', 'c.id', 'o.created_by')
    .leftJoin('staff_users as g', 'g.id', 'o.staff_discount_by').leftJoin('draft_orders as d', 'd.id', 'o.draft_order_id')
    .select(['o.channel', 'o.payment_method', 'l.name as branch', 'c.email as created_by', 'o.staff_discount_paise', 'o.staff_discount_bp', 'o.staff_discount_reason',
      'g.email as discount_by', 'd.id as draft_id', 'd.number as draft_number', 'o.subtotal_paise', 'o.total_paise', 'o.pricing', 'o.pos_number'])
    .where('o.id', '=', orderId).executeTakeFirst();
}

/** For the ERP customer page: the customer's draft orders, abandoned checkouts (orders placed and not paid) and every
    discount on their orders (staff discounts with reason and who gave them, coupons / discount rules). */
export async function customerOrderWorkflows(db: Db, actor: StaffPrincipal, customerId: string) {
  requirePermission(actor, 'orders.read');
  const [drafts, unpaid, staffDiscounts, redemptions] = await Promise.all([
    listDraftOrders(db, actor, { status: 'all', customerId }),
    db.selectFrom('orders as o').leftJoin('checkout_reminders as r', 'r.order_id', 'o.id')
      .select(['o.id', 'o.order_number', 'o.status', 'o.total_paise', 'o.created_at', 'o.updated_at', 'o.payment_expires_at', 'r.status as reminder_status', 'r.sent_at as reminder_sent_at',
        sql<number>`(select coalesce(sum(i.qty), 0)::int from public.order_items i where i.order_id = o.id)`.as('units')])
      .where('o.customer_id', '=', customerId).where('o.status', 'in', ['pending_payment', 'payment_failed']).orderBy('o.created_at', 'desc').execute(),
    db.selectFrom('orders as o').leftJoin('staff_users as s', 's.id', 'o.staff_discount_by')
      .select(['o.id', 'o.order_number', 'o.created_at', 'o.staff_discount_paise as amount_paise', 'o.staff_discount_bp', 'o.staff_discount_reason as reason', 's.email as staff_email'])
      .where('o.customer_id', '=', customerId).where('o.staff_discount_paise', '>', 0).orderBy('o.created_at', 'desc').execute(),
    db.selectFrom('discount_redemptions as r').innerJoin('orders as o', 'o.id', 'r.order_id').innerJoin('discounts as d', 'd.id', 'r.discount_id')
      .select(['o.id', 'o.order_number', 'r.created_at', 'r.amount_paise', 'r.code', 'd.name'])
      .where('r.customer_id', '=', customerId).orderBy('r.created_at', 'desc').execute(),
  ]);
  return { drafts, unpaid, discounts: [
    ...staffDiscounts.map(x => ({ orderId: x.id, orderNumber: x.order_number, at: x.created_at as Date, amountPaise: x.amount_paise, kind: 'staff' as const,
      label: `Staff discount ${x.staff_discount_bp ? x.staff_discount_bp / 100 + '%' : ''}: ${x.reason ?? ''}`, by: x.staff_email })),
    ...redemptions.map(x => ({ orderId: x.id, orderNumber: x.order_number, at: x.created_at as Date, amountPaise: x.amount_paise, kind: 'rule' as const,
      label: x.code ? `Coupon ${x.code} (${x.name})` : x.name, by: null })),
  ].sort((a, b) => +b.at - +a.at) };
}
