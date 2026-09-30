/* Input contracts for ERP modules 1–8 (pricing & discounts, shipping, returns & refunds, marketing, support, finance,
   carts & wishlists, notifications). Shape only; permissions, ownership and business checks happen in @kitsyuu/core.
   Self-contained on purpose (index.ts re-exports this file, so importing from it here would be a cycle). */
import { z } from 'zod';

const uuid = z.uuid();
const productId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Unknown product.');
const categoryId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'Unknown category.');
const collectionId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Unknown collection.');
const optUuid = uuid.optional().or(z.literal('').transform(() => undefined));
const optText = (max: number) => z.string().trim().max(max).optional().transform(v => v || null);
const reqText = (min: number, max: number, message: string) => z.string().trim().min(min, message).max(max);
const checkbox = z.union([z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')]).optional().transform(v => v === 'on' || v === 'true');
const ids = <T extends z.ZodType>(s: T, max = 500) => z.array(s).max(max).optional().transform(v => v ?? []);
const page = z.coerce.number().int().min(1).max(10_000).default(1);

/** Rupees typed by a person ("2499", "2,499.50", "₹ 2499") → integer paise, string arithmetic only. */
function rupees(input: string): number | null {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/^₹\s*/, '').replace(/,/g, ''));
  if (!m) return null;
  const p = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(p) ? p : null;
}
const MAX_PAISE = 1_000_000_000;
const money = (opts: { optional?: boolean; zero?: boolean } = {}) => z.string().max(20).optional().transform((v, ctx) => {
  if (!v || !v.trim()) {
    if (opts.optional) return null;
    ctx.addIssue({ code: 'custom', message: 'Enter an amount in rupees.' }); return z.NEVER;
  }
  const p = rupees(v);
  if (p === null) { ctx.addIssue({ code: 'custom', message: 'Enter an amount in rupees, e.g. 499 or 499.50.' }); return z.NEVER; }
  if (p === 0 && !opts.zero) { ctx.addIssue({ code: 'custom', message: 'The amount must be more than ₹0.' }); return z.NEVER; }
  if (p > MAX_PAISE) { ctx.addIssue({ code: 'custom', message: 'The amount is too large.' }); return z.NEVER; }
  return p;
});
const optInt = (min: number, max: number) => z.string().trim().max(10).optional().transform((v, ctx) => {
  if (!v) return null;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) { ctx.addIssue({ code: 'custom', message: `Enter a whole number from ${min} to ${max}.` }); return z.NEVER; }
  return Number(v);
});
/** <input type="datetime-local"> is India time (the business time zone); '' = not set. */
const dateTime = (required = false) => z.string().trim().max(25).optional().transform((v, ctx) => {
  if (!v) {
    if (required) { ctx.addIssue({ code: 'custom', message: 'Choose a date and time.' }); return z.NEVER; }
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) { ctx.addIssue({ code: 'custom', message: 'Choose a valid date and time.' }); return z.NEVER; }
  const d = new Date(`${v.length === 16 ? v + ':00' : v}+05:30`);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: 'custom', message: 'Choose a valid date and time.' }); return z.NEVER; }
  return d;
});
const dateOnly = (required = true) => z.string().trim().max(10).optional().transform((v, ctx) => {
  if (!v) { if (required) { ctx.addIssue({ code: 'custom', message: 'Choose a date.' }); return z.NEVER; } return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) { ctx.addIssue({ code: 'custom', message: 'Use YYYY-MM-DD.' }); return z.NEVER; }
  return v;
});
const percentBp = z.string().trim().max(8).transform((v, ctx) => {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v);
  const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  if (!m || bp <= 0 || bp > 10_000) { ctx.addIssue({ code: 'custom', message: 'Enter a percentage above 0 and at most 100 (e.g. 10 or 12.5).' }); return z.NEVER; }
  return bp;
});
const couponCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/, 'Use 3–32 letters, digits, - or _.');
const dateRange = <T extends { startsAt: Date | null; endsAt: Date | null }>(v: T, ctx: z.RefinementCtx) => {
  if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'The end must be after the start.' });
};

// ============================== 1 · pricing & discounts ==============================
export const productPricingInput = z.object({
  productId, variantId: optUuid,
  /** For a size: '' = use the product price. For the product: required. */
  price: money({ optional: true }), compareAt: money({ optional: true }),
});
export const schedulePriceInput = z.object({
  productId, variantId: optUuid, price: money({ optional: true }), compareAt: money({ optional: true }), clearCompareAt: checkbox,
  effectiveAt: dateTime(true), note: optText(300),
}).superRefine((v, ctx) => {
  if (v.price === null && v.compareAt === null && !v.clearCompareAt) ctx.addIssue({ code: 'custom', path: ['price'], message: 'Enter a new price, a new compare-at price, or clear the compare-at price.' });
  if (v.clearCompareAt && v.compareAt !== null) ctx.addIssue({ code: 'custom', path: ['compareAt'], message: 'Either set a compare-at price or clear it, not both.' });
});
export const cancelPriceChangeInput = z.object({ changeId: uuid });
export const bulkPriceInput = z.object({
  productIds: z.array(productId).min(1, 'Choose at least one product.').max(500),
  mode: z.enum(['increase_percent', 'decrease_percent', 'increase_amount', 'decrease_amount', 'set']),
  amount: z.string().trim().max(20),
  /** For a sale: keep the current price as the compare-at ("was") price. */
  keepCompareAt: checkbox,
}).transform((v, ctx) => {
  const pct = v.mode.endsWith('_percent');
  const n = pct ? (/^(\d{1,3})(?:\.(\d{1,2}))?$/.test(v.amount) ? Math.round(Number(v.amount) * 100) : NaN) : rupees(v.amount);
  if (n === null || !Number.isFinite(n) || n <= 0 || (pct && n >= 10_000 && v.mode === 'decrease_percent') || (pct && n > 100_000)) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: pct ? 'Enter a percentage, e.g. 10 (a decrease must be under 100).' : 'Enter an amount in rupees.' });
    return z.NEVER;
  }
  return { productIds: v.productIds, mode: v.mode, amount: n, keepCompareAt: v.keepCompareAt };
});
export const discountInput = z.object({
  discountId: optUuid,
  name: reqText(1, 120, 'Enter a name.'),
  code: z.string().trim().toUpperCase().max(32).optional().transform(v => v || null).pipe(couponCode.nullable()),
  kind: z.enum(['percent', 'fixed']),
  value: z.string().trim().max(20),
  scope: z.enum(['order', 'products', 'categories', 'collections']),
  productIds: ids(productId), categoryIds: ids(categoryId), collectionIds: ids(collectionId),
  minOrder: money({ optional: true }), maxDiscount: money({ optional: true }),
  startsAt: dateTime(), endsAt: dateTime(), active: checkbox,
  usageLimit: optInt(1, 1_000_000), perCustomerLimit: optInt(1, 1000), campaignId: optUuid,
}).transform((v, ctx) => {
  const value = v.kind === 'percent' ? percentBp.safeParse(v.value) : money().safeParse(v.value);
  if (!value.success) { ctx.addIssue({ code: 'custom', path: ['value'], message: v.kind === 'percent' ? 'Enter a percentage above 0 and at most 100.' : 'Enter an amount in rupees.' }); return z.NEVER; }
  const targets = { products: v.productIds, categories: v.categoryIds, collections: v.collectionIds } as const;
  if (v.scope !== 'order' && targets[v.scope].length === 0) { ctx.addIssue({ code: 'custom', path: ['scope'], message: `Choose at least one of the ${v.scope}.` }); return z.NEVER; }
  if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) { ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'The end must be after the start.' }); return z.NEVER; }
  return { ...v, value: value.data as number };
});
export const setDiscountActiveInput = z.object({ discountId: uuid, active: z.enum(['true', 'false']).transform(v => v === 'true') });
/** Store: a coupon typed at checkout ('' removes it). */
export const couponInput = z.object({ code: z.string().trim().toUpperCase().max(32).transform(v => v || null).pipe(couponCode.nullable()) });

// ============================== 2 · shipping ==============================
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const;
export const shippingZoneInput = z.object({
  zoneId: optUuid, name: reqText(1, 80, 'Enter a zone name.'),
  states: ids(z.enum(INDIAN_STATES), 40),
  pinPrefixes: z.string().trim().max(500).optional().transform((v, ctx) => {
    const list = (v ?? '').split(/[\s,]+/).filter(Boolean);
    if (list.some(p => !/^\d{1,6}$/.test(p))) { ctx.addIssue({ code: 'custom', message: 'PIN prefixes are 1–6 digits, separated by commas.' }); return z.NEVER; }
    return [...new Set(list)];
  }),
  active: checkbox,
}).superRefine((v, ctx) => { if (!v.states.length && !v.pinPrefixes.length) ctx.addIssue({ code: 'custom', path: ['states'], message: 'Choose at least one state or enter a PIN prefix.' }); });
export const shippingRateInput = z.object({
  rateId: optUuid, zoneId: uuid, name: reqText(1, 60, 'Enter a name, e.g. Standard.'),
  amount: money({ zero: true }), freeFrom: money({ optional: true }), minOrder: money({ optional: true, zero: true }), maxOrder: money({ optional: true }),
  codAllowed: checkbox, codFee: money({ optional: true, zero: true }), estMin: optInt(0, 60), estMax: optInt(0, 60), active: checkbox,
}).superRefine((v, ctx) => {
  if (v.minOrder !== null && v.maxOrder !== null && v.maxOrder <= v.minOrder) ctx.addIssue({ code: 'custom', path: ['maxOrder'], message: 'Must be above the minimum.' });
  if (v.estMin !== null && v.estMax !== null && v.estMax < v.estMin) ctx.addIssue({ code: 'custom', path: ['estMax'], message: 'Must be at least the minimum.' });
});
export const deleteShippingRateInput = z.object({ rateId: uuid });
export const courierInput = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Use 2–32 lower-case letters, digits or _.'),
  name: reqText(1, 80, 'Enter the courier name.'), mode: z.enum(['manual', 'api']),
  trackingUrlTemplate: z.string().trim().max(300).optional().transform((v, ctx) => {
    if (!v) return null;
    if (!/^https:\/\//.test(v) || !v.includes('{tracking}')) { ctx.addIssue({ code: 'custom', message: 'An https:// address containing {tracking}.' }); return z.NEVER; }
    return v;
  }),
  active: checkbox, notes: optText(500),
});
export const SHIPMENT_STATUSES = ['pending', 'processing', 'packed', 'shipped', 'in_transit', 'delivered', 'failed_delivery', 'cancelled'] as const;
export const shipmentUpdateInput = z.object({
  shipmentId: uuid, status: z.enum(SHIPMENT_STATUSES), courierCode: z.string().trim().max(32).optional().transform(v => v || null),
  trackingNumber: z.string().trim().max(60).optional().transform(v => v || null)
    .pipe(z.string().regex(/^[A-Za-z0-9-]{4,60}$/, 'Letters, digits and hyphens (4–60).').nullable()),
  note: optText(300), failureReason: optText(300),
});
export const shipmentListQuery = z.object({
  q: z.string().trim().max(60).optional().transform(v => v || undefined),
  status: z.enum(['all', 'open', ...SHIPMENT_STATUSES]).default('open'),
  courier: z.string().trim().max(32).optional().transform(v => v || undefined), page,
});

// ============================== 3 · returns & refunds ==============================
export const RETURN_STATUSES = ['requested', 'under_review', 'info_requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'received',
  'inspection', 'refund_pending', 'refunded', 'exchange_pending', 'exchanged', 'completed', 'cancelled'] as const;
export const returnRequestInput = z.object({
  orderNumber: z.string().trim().regex(/^[A-Z0-9-]{4,40}$/, 'Unknown order.'),
  reasonCode: z.string().regex(/^[a-z][a-z_]{1,31}$/, 'Choose a reason.'),
  description: optText(2000),
  items: z.array(z.object({ orderItemId: uuid, qty: z.coerce.number().int().min(0).max(100) })).max(50)
    .transform(v => v.filter(i => i.qty > 0)).pipe(z.array(z.object({ orderItemId: uuid, qty: z.number() })).min(1, 'Choose at least one item and quantity.')),
});
export const cancelReturnInput = z.object({ returnNumber: z.string().regex(/^RET-[A-Z0-9]{8}$/) });
export const RETURN_ACTIONS = ['review', 'request_info', 'approve', 'reject', 'schedule_pickup', 'picked_up', 'receive', 'inspect',
  'restock', 'ship_exchange', 'complete', 'cancel'] as const;
export const returnActionInput = z.object({
  returnId: uuid, action: z.enum(RETURN_ACTIONS), note: optText(1000),
  resolution: z.enum(['refund', 'exchange']).optional().or(z.literal('').transform(() => undefined)),
  pickupAt: dateTime(), pickupRef: optText(80),
  inspectionResult: z.enum(['ok', 'damaged', 'not_returnable']).optional().or(z.literal('').transform(() => undefined)),
  refundAmount: money({ optional: true }),
});
export const returnItemInput = z.object({
  returnId: uuid, returnItemId: uuid, restockQty: z.coerce.number().int().min(0).max(100).optional(),
  exchangeVariantId: optUuid,
});
export const refundInput = z.object({
  returnId: uuid, mode: z.enum(['provider', 'manual']), amount: money(),
  reference: optText(120), note: reqText(3, 300, 'Say why (at least 3 characters).'),
}).superRefine((v, ctx) => { if (v.mode === 'manual' && !v.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the reference of the refund you made (bank / UPI / Razorpay dashboard).' }); });
export const returnListQuery = z.object({
  q: z.string().trim().max(40).optional().transform(v => v || undefined),
  status: z.enum(['open', 'all', ...RETURN_STATUSES]).default('open'), page,
});

// ============================== 4 · marketing ==============================
export const campaignInput = z.object({
  campaignId: optUuid, name: reqText(1, 120, 'Enter a campaign name.'), description: optText(1000),
  startsAt: dateTime(), endsAt: dateTime(), active: checkbox, productIds: ids(productId), collectionIds: ids(collectionId),
}).superRefine(dateRange);
export const setCampaignActiveInput = z.object({ campaignId: uuid, active: z.enum(['true', 'false']).transform(v => v === 'true') });
export const bannerInput = z.object({
  bannerId: optUuid, placement: z.enum(['home', 'shop']), heading: reqText(1, 80, 'Enter a heading.'), body: optText(240),
  ctaLabel: optText(30),
  link: z.string().trim().max(200).optional().transform((v, ctx) => {
    if (!v) return null;
    if (!/^\/[^/]/.test(v)) { ctx.addIssue({ code: 'custom', message: 'A path inside the store, starting with / (e.g. /shop?collection=new-arrivals).' }); return z.NEVER; }
    return v;
  }),
  startsAt: dateTime(), endsAt: dateTime(), active: checkbox, sortOrder: optInt(0, 1000), campaignId: optUuid,
}).superRefine((v, ctx) => {
  dateRange(v, ctx);
  if (!!v.ctaLabel !== !!v.link) ctx.addIssue({ code: 'custom', path: ['link'], message: 'A button needs both a label and a link.' });
});
export const setBannerActiveInput = z.object({ bannerId: uuid, active: z.enum(['true', 'false']).transform(v => v === 'true') });
export const segmentInput = z.object({
  segmentId: optUuid, name: reqText(1, 80, 'Enter a segment name.'), description: optText(300),
  joinedWithinDays: optInt(1, 3650), minOrders: optInt(0, 10_000), maxOrders: optInt(0, 10_000), minSpend: money({ optional: true }),
  lastOrderOlderThanDays: optInt(1, 3650), lastOrderWithinDays: optInt(1, 3650), hasAbandonedCart: checkbox,
}).transform(v => ({ segmentId: v.segmentId, name: v.name, description: v.description,
  rules: { joinedWithinDays: v.joinedWithinDays, minOrders: v.minOrders, maxOrders: v.maxOrders, minSpendPaise: v.minSpend,
    lastOrderOlderThanDays: v.lastOrderOlderThanDays, lastOrderWithinDays: v.lastOrderWithinDays, hasAbandonedCart: v.hasAbandonedCart } }))
  .superRefine((v, ctx) => {
    if (Object.values(v.rules).every(x => x === null || x === false)) ctx.addIssue({ code: 'custom', path: ['name'], message: 'Set at least one rule.' });
    if (v.rules.minOrders !== null && v.rules.maxOrders !== null && v.rules.maxOrders < v.rules.minOrders) ctx.addIssue({ code: 'custom', path: ['maxOrders'], message: 'Must be at least the minimum.' });
  });
export const deleteSegmentInput = z.object({ segmentId: uuid });
export type SegmentRules = z.output<typeof segmentInput>['rules'];

// ============================== 5 · support ==============================
export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const categoryCode = z.string().regex(/^[a-z][a-z_]{1,31}$/, 'Choose a category.');
const orderNumberOpt = z.string().trim().toUpperCase().max(40).optional().transform(v => v || null)
  .pipe(z.string().regex(/^[A-Z0-9-]{4,40}$/, 'Unknown order number.').nullable());
export const customerTicketInput = z.object({
  subject: reqText(3, 160, 'Enter a subject (at least 3 characters).'), categoryCode, orderNumber: orderNumberOpt,
  body: reqText(10, 4000, 'Describe the issue (at least 10 characters).'),
});
export const customerTicketReplyInput = z.object({ ticketNumber: z.string().regex(/^TCK-[A-Z0-9]{8}$/), body: reqText(1, 4000, 'Write a message.') });
export const staffTicketInput = z.object({
  customerEmail: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter the customer’s email.' })),
  contactName: optText(120), subject: reqText(3, 160, 'Enter a subject.'), categoryCode, priority: z.enum(TICKET_PRIORITIES),
  orderNumber: orderNumberOpt, body: reqText(3, 4000, 'Describe the issue.'),
});
export const ticketReplyInput = z.object({
  ticketId: uuid, body: reqText(1, 4000, 'Write a message.'), internal: checkbox,
  status: z.enum(TICKET_STATUSES).optional().or(z.literal('').transform(() => undefined)),
});
export const ticketUpdateInput = z.object({
  ticketId: uuid, status: z.enum(TICKET_STATUSES), priority: z.enum(TICKET_PRIORITIES), categoryCode,
  assignedTo: z.string().optional().transform(v => v || null).pipe(uuid.nullable()),
});
export const ticketListQuery = z.object({
  q: z.string().trim().max(60).optional().transform(v => v || undefined),
  status: z.enum(['active', 'all', ...TICKET_STATUSES]).default('active'),
  priority: z.enum(['all', ...TICKET_PRIORITIES]).default('all'),
  assignee: z.enum(['all', 'me', 'unassigned']).default('all'),
  category: z.string().max(32).optional().transform(v => v || undefined), page,
});

// ============================== 6 · finance ==============================
export const taxRateInput = z.object({
  rateId: optUuid, code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'Use 2–20 capital letters, digits or _.'),
  label: reqText(1, 80, 'Enter a label, e.g. GST 5%.'),
  ratePercent: z.string().trim().max(6).transform((v, ctx) => {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v);
    const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
    if (!m || bp < 0 || bp > 10_000) { ctx.addIssue({ code: 'custom', message: 'Enter a percentage from 0 to 100.' }); return z.NEVER; }
    return bp;
  }),
  inclusive: checkbox, validFrom: dateOnly(), validTo: dateOnly(false), active: checkbox,
}).superRefine((v, ctx) => { if (v.validTo && v.validFrom && v.validTo < v.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Must be on or after the start.' }); });
export const productTaxInput = z.object({ productId, taxRateCode: z.string().trim().toUpperCase().max(20).optional().transform(v => v || null) });
export const createInvoiceInput = z.object({ orderId: uuid });
export const voidInvoiceInput = z.object({ invoiceId: uuid, reason: reqText(3, 300, 'Say why (at least 3 characters).') });
export const financeNoteInput = z.object({
  kind: z.enum(['credit', 'debit']), invoiceId: uuid, reason: reqText(3, 300, 'Enter the reason.'), amount: money(), tax: money({ optional: true, zero: true }),
});
export const financeNoteStatusInput = z.object({ noteId: uuid, status: z.enum(['issued', 'void']) });
export const expenseInput = z.object({
  expenseId: optUuid, categoryCode, amount: money(), tax: money({ optional: true, zero: true }), vendorId: optUuid,
  date: dateOnly(), description: reqText(1, 300, 'Describe the expense.'), reference: optText(120),
});
export const voidExpenseInput = z.object({ expenseId: uuid });
export const vendorPaymentInput = z.object({
  paymentId: optUuid, vendorId: uuid, purchaseOrderId: optUuid, amount: money(), status: z.enum(['scheduled', 'paid', 'void']),
  paidOn: dateOnly(false), method: z.enum(['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other']).optional().or(z.literal('').transform(() => undefined)),
  reference: optText(120), notes: optText(500),
}).superRefine((v, ctx) => { if (v.status === 'paid' && !v.paidOn) ctx.addIssue({ code: 'custom', path: ['paidOn'], message: 'Enter the date it was paid.' }); });
export const financeRangeQuery = z.object({ from: dateOnly(false), to: dateOnly(false) });

// ============================== 7 · carts & wishlists ==============================
export const cartListQuery = z.object({
  view: z.enum(['active', 'abandoned', 'converted', 'all']).default('active'),
  q: z.string().trim().max(60).optional().transform(v => v || undefined), page,
});
export const cartRecoveryInput = z.object({ cartId: uuid, status: z.enum(['open', 'dismissed', 'recovered']), note: optText(300) });
export const sendCartRecoveryInput = z.object({ cartId: uuid });

// ============================== 8 · notifications ==============================
export const notificationListQuery = z.object({
  show: z.enum(['all', 'unread']).default('all'), severity: z.enum(['all', 'info', 'warning', 'critical']).default('all'), page,
});
export const markNotificationsInput = z.object({
  ids: z.array(z.string().regex(/^\d{1,18}$/)).max(200).optional().transform(v => v ?? []), all: checkbox,
}).superRefine((v, ctx) => { if (!v.all && !v.ids.length) ctx.addIssue({ code: 'custom', message: 'Nothing chosen.' }); });
