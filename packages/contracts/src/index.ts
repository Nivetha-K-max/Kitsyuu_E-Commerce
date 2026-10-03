/* Input contracts shared by the apps and the server packages. Schemas check SHAPE only; permission and ownership
   checks always happen on the server against the session (never trust ids or roles sent by the client). */
import { z } from 'zod';

export * from './errors.ts';

export const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address.' }));
/** New passwords: length is what matters most (NIST SP 800-63B); no composition rules. */
export const newPassword = z.string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.')
  .refine(p => p.trim().length >= 12, 'Use at least 12 non-space characters.');
export const oneTimeToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid.');
export const uuid = z.uuid();
const fullName = z.string().trim().min(1, 'Enter a name.').max(120);

export const loginInput = z.object({ email, password: z.string().min(1, 'Enter your password.').max(128),
  /** M18: the authenticator code or a recovery code; only needed when two-factor sign-in is on for the account. */
  code: z.string().trim().max(20).optional().transform(v => v || undefined) });

const confirmMatches = { message: 'The two passwords do not match.', path: ['confirm'] };

export const acceptInviteInput = z.object({ token: oneTimeToken, fullName, password: newPassword, confirm: z.string() })
  .refine(v => v.password === v.confirm, confirmMatches);
export const resetRequestInput = z.object({ email });
export const resetPasswordInput = z.object({ token: oneTimeToken, password: newPassword, confirm: z.string() })
  .refine(v => v.password === v.confirm, confirmMatches);
export const changePasswordInput = z.object({ current: z.string().min(1, 'Enter your current password.').max(128), password: newPassword, confirm: z.string() })
  .refine(v => v.password === v.confirm, confirmMatches);

export const inviteStaffInput = z.object({ email, fullName, roleIds: z.array(uuid).min(1, 'Choose at least one role.').max(20) });
export const updateStaffInput = z.object({ staffId: uuid, email, fullName });
export const setStaffRolesInput = z.object({ staffId: uuid, roleIds: z.array(uuid).max(20) });
export const setStaffStatusInput = z.object({ staffId: uuid, status: z.enum(['active', 'disabled']) });

export const roleCode = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2–40 lower-case letters, digits or underscores, starting with a letter.');
export const permissionCode = z.string().regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
export const createRoleInput = z.object({ code: roleCode, name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default('') });
export const updateRoleInput = z.object({
  roleId: uuid,
  name: z.string().trim().min(1, 'Enter a name.').max(80),
  description: z.string().trim().max(300).default(''),
  permissionCodes: z.array(permissionCode).max(200),
});
export const deleteRoleInput = z.object({ roleId: uuid });

export const auditQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  action: z.string().trim().max(80).optional().transform(v => v || undefined),
  entityType: z.string().trim().max(80).optional().transform(v => v || undefined),
  staffId: z.uuid().optional().or(z.literal('').transform(() => undefined)),
});

// ---------- catalogue: products, price, stock ----------
/** Existing catalogue ids (ky-proto-001, kts-1a2b3c4d) are kept exactly; they are never regenerated. */
export const productId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Unknown product.');
export const categoryId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'Choose a category.');

/** Largest accepted price: ₹1,00,00,000 (1 crore). Well inside the database's integer column. */
export const MAX_PRICE_PAISE = 1_000_000_000;

/** Parses a rupee amount typed by a person ("2499", "2,499.50", "₹ 2499.5") into integer paise, using string
    arithmetic only (never floating point). Returns null for anything that is not a plain positive amount. */
export function rupeesToPaise(input: string): number | null {
  const s = input.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}
/** Integer paise → "2,499.00" style rupee text (no floating point). */
export function paiseToRupees(paise: number): string {
  const rupees = Math.trunc(paise / 100).toLocaleString('en-IN');
  return `${rupees}.${String(Math.abs(paise % 100)).padStart(2, '0')}`;
}

export const priceInput = z.string().max(20).transform((v, ctx) => {
  const paise = rupeesToPaise(v);
  if (paise === null) { ctx.addIssue({ code: 'custom', message: 'Enter an amount in rupees, e.g. 2499 or 2499.50 (at most 2 decimals).' }); return z.NEVER; }
  if (paise <= 0) { ctx.addIssue({ code: 'custom', message: 'The price must be more than ₹0.' }); return z.NEVER; }
  if (paise > MAX_PRICE_PAISE) { ctx.addIssue({ code: 'custom', message: 'The price is above the ₹1,00,00,000 limit.' }); return z.NEVER; }
  return paise;
});

export const productListQuery = z.object({
  q: z.string().trim().max(80).optional().transform(v => v || undefined),
  category: categoryId.optional().or(z.literal('').transform(() => undefined)),
  status: z.enum(['all', 'active', 'inactive', 'draft', 'review', 'archived']).default('all'),
  /** Filters that combine with the others: a collection, and availability of the sellable sizes. */
  collection: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional().or(z.literal('').transform(() => undefined)),
  stock: z.enum(['all', 'in_stock', 'low', 'out']).default('all'),
});

const optionalText = (max: number) => z.string().trim().max(max).transform(v => v || null);
export const updateProductInput = z.object({
  productId,
  name: z.string().trim().min(2, 'Enter a product name.').max(120),
  description: z.string().trim().max(4000),
  categoryId,
  subcategoryId: categoryId.optional().or(z.literal('').transform(() => undefined)),
  colourLabel: optionalText(80),
  material: optionalText(300),
  care: optionalText(300),
  origin: optionalText(120),
  /** M10: 4, 6 or 8 digits; empty clears it. Omitted (older forms) leaves it unchanged. */
  /** M11: optional search-engine text; empty = the store default. Omitted (older forms) leaves it unchanged. */
  seoTitle: z.string().trim().max(70, 'Keep the SEO title under 70 characters.').transform(v => v || null).optional(),
  seoDescription: z.string().trim().max(160, 'Keep the SEO description under 160 characters.').transform(v => v || null).optional(),
  hsnCode: z.string().trim().regex(/^([0-9]{4}([0-9]{2}([0-9]{2})?)?)?$/, 'Enter 4, 6 or 8 digits.').transform(v => v || null).optional(),
  features: z.string().max(4000).transform(v => v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(160, 'Keep each feature under 160 characters.')).max(20, 'At most 20 features.')),
  isFeatured: z.enum(['on', 'off']).default('off').transform(v => v === 'on'),
});

export const setProductStatusInput = z.object({ productId, status: z.enum(['active', 'draft', 'review', 'archived']) });
export const updatePriceInput = z.object({
  productId,
  price: priceInput,
  /** The price the person saw when they opened the form: the change is refused if it has changed since. */
  expectedPricePaise: z.coerce.number().int().min(0),
});

export const stockListQuery = z.object({
  q: z.string().trim().max(80).optional().transform(v => v || undefined),
  status: z.enum(['all', 'attention', 'low_stock', 'out_of_stock', 'in_stock']).default('all'),
});
export const adjustStockInput = z.object({
  variantId: uuid,
  direction: z.enum(['increase', 'decrease'], { message: 'Choose increase or decrease.' }),
  quantity: z.coerce.number({ message: 'Enter a whole number.' }).int('Enter a whole number.').min(1, 'Enter at least 1.').max(100_000, 'At most 100,000 at a time.'),
  reason: z.string().trim().min(1, 'Choose a reason.').regex(/^[a-z][a-z_]*$/, 'Choose a reason.'),
  note: z.string().trim().max(300, 'Keep the note under 300 characters.').transform(v => v || null),
  /** The quantity the person saw: the adjustment is refused if stock has changed since. */
  expectedQty: z.coerce.number().int().min(0),
});

// ---------- orders ----------
export const ORDER_STATUSES = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'payment_failed', 'refunded'] as const;
export type OrderStatusCode = typeof ORDER_STATUSES[number];
export const PAYMENT_STATUSES = ['unpaid', 'pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded'] as const;

/** Status changes staff may make. Fulfilment moves forward only; unpaid orders can be cancelled.
    Nothing here marks an order paid, cancels a paid order or refunds: those need the payment/refund flow (later phase),
    so no status change in the admin app can move money or contradict a payment record. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatusCode, readonly OrderStatusCode[]>> = {
  pending_payment: ['cancelled'],
  payment_failed: ['cancelled'],
  paid: ['processing'],
  processing: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  refunded: [],
};
export const canTransition = (from: OrderStatusCode, to: OrderStatusCode) => ORDER_TRANSITIONS[from]?.includes(to) ?? false;

/** The order state machine, per actor (M7). Every status change goes through core's applyOrderTransition(), which checks
    these maps; no page or component changes a status itself.
    - staff:    fulfilment forward, and cancelling unpaid orders (ORDER_TRANSITIONS above).
    - system:   the payment flow, driven only by verified Razorpay data (signature + provider API or signed webhook):
                paid, payment failed (the customer may retry), and cancelling an unpaid order whose payment window expired
                or that a new checkout replaced.
    - customer: may cancel their own unpaid order. */
export type OrderActor = 'staff' | 'system' | 'customer';
const NONE: readonly OrderStatusCode[] = [];
export const ORDER_TRANSITIONS_BY_ACTOR: Readonly<Record<OrderActor, Readonly<Record<OrderStatusCode, readonly OrderStatusCode[]>>>> = {
  staff: ORDER_TRANSITIONS,
  system: {
    pending_payment: ['paid', 'payment_failed', 'cancelled'], payment_failed: ['paid', 'cancelled'],
    paid: NONE, processing: NONE, shipped: NONE, delivered: NONE, cancelled: NONE, refunded: NONE,
  },
  customer: {
    pending_payment: ['cancelled'], payment_failed: ['cancelled'],
    paid: NONE, processing: NONE, shipped: NONE, delivered: NONE, cancelled: NONE, refunded: NONE,
  },
};
export const canTransitionAs = (actor: OrderActor, from: OrderStatusCode, to: OrderStatusCode) =>
  ORDER_TRANSITIONS_BY_ACTOR[actor][from]?.includes(to) ?? false;
/** Client change request (second pass): cash-on-delivery orders, which never wait for an online payment. The checkout
    sends a new COD order straight to fulfilment (system: pending payment → processing), and staff may cancel one before
    dispatch or record a parcel the customer refused (processing / shipped → cancelled). Only the COD flows use these
    (applyOrderTransition with cod: true), so nothing changes for orders paid online. */
export const COD_TRANSITIONS: Readonly<Record<OrderActor, Partial<Record<OrderStatusCode, readonly OrderStatusCode[]>>>> = {
  system: { pending_payment: ['processing'] },
  staff: { processing: ['cancelled'], shipped: ['cancelled'] },
  customer: {},
};
export const canCodTransition = (actor: OrderActor, from: OrderStatusCode, to: OrderStatusCode) => COD_TRANSITIONS[actor][from]?.includes(to) ?? false;
/** Orders that still wait for payment (they hold stock until payment_expires_at). */
export const UNPAID_ORDER_STATUSES: readonly OrderStatusCode[] = ['pending_payment', 'payment_failed'];
/** Transitions that need a written reason (kept in the order's status history). */
export const NOTE_REQUIRED_FOR: readonly OrderStatusCode[] = ['cancelled'];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
export const orderListQuery = z.object({
  q: z.string().trim().max(80).optional().transform(v => v || undefined),
  status: z.enum(['all', 'open', ...ORDER_STATUSES]).default('all'),
  payment: z.enum(['all', 'none', ...PAYMENT_STATUSES]).default('all'),
  from: isoDate.optional().or(z.literal('').transform(() => undefined)),
  to: isoDate.optional().or(z.literal('').transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  /** Client change request: Active (confirmed, not yet delivered), Draft (placed, not paid yet, newer than the abandoned-
      checkout delay), Abandoned (still unpaid after that delay; 24 h unless set in Configuration). All = no view filter. */
  view: z.enum(['all', 'active', 'draft', 'abandoned']).default('all'),
});
export const updateOrderStatusInput = z.object({
  orderId: uuid,
  toStatus: z.enum(ORDER_STATUSES, { message: 'Choose the new status.' }),
  /** The status the person saw when they opened the order: the change is refused if it has changed since. */
  expectedStatus: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500, 'Keep the note under 500 characters.').transform(v => v || null),
  /** M8 fulfilment details, used when the order becomes shipped (ignored otherwise). Tracking is optional. */
  carrierCode: z.string().trim().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Choose a courier.').default('manual'),
  trackingNumber: z.string().trim().max(64, 'Keep the tracking number under 64 characters.')
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -/.]*$|^$/, 'Use letters, digits, spaces, hyphens, slashes or dots.').default('').transform(v => v || null),
}).superRefine((v, ctx) => {
  if (!canTransition(v.expectedStatus, v.toStatus))
    ctx.addIssue({ code: 'custom', path: ['toStatus'], message: `An order cannot go from ${v.expectedStatus.replace(/_/g, ' ')} to ${v.toStatus.replace(/_/g, ' ')}.` });
  if (NOTE_REQUIRED_FOR.includes(v.toStatus) && !v.note)
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason; it is kept in the order history.' });
});
export type OrderListQuery = z.infer<typeof orderListQuery>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusInput>;

// ---------- M4: product creation, sizes, categories, New Arrivals, images ----------
const onOff = z.enum(['on', 'off']).default('off').transform(v => v === 'on');
const direction = z.enum(['up', 'down']);
export const sku = z.string().trim().toUpperCase().regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'Use capital letters, digits and single hyphens, e.g. KTS-TOP-023.').min(3).max(40);
export const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens.').min(2).max(80);
/** Store URL slug from a product name (used when the slug field is left blank). */
export const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** Size labels become part of the SKU (product SKU + '-' + size), so they are short and simple. */
export const sizeLabel = z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, 'Use 1–8 letters or digits, e.g. XS, M, 32, FREE.').transform(v => v.toUpperCase());
export const createProductInput = z.object({
  name: z.string().trim().min(2, 'Enter a product name.').max(120),
  sku,
  slug: z.string().trim().max(80).optional().transform(v => v || undefined).pipe(slug.optional()),
  categoryId,
  subcategoryId: categoryId.optional().or(z.literal('').transform(() => undefined)),
  price: priceInput,
  description: z.string().trim().max(4000).default(''),
  colourLabel: z.string().trim().max(80).transform(v => v || null).default(''),
  /** 2026-10-01: sizes created with the product, each with its opening stock (sizes[] / qtys[] rows; empty rows ignored). */
  sizes: z.array(z.string().trim().max(20)).max(30).optional().transform(v => v ?? []),
  qtys: z.array(z.string().trim().max(7)).max(30).optional().transform(v => v ?? []),
}).transform((v, ctx) => {
  const { sizes: labels, qtys, ...rest } = v;
  const sizes: { size: string; qty: number }[] = [];
  for (const [i, raw] of labels.entries()) {
    if (!raw) continue;
    const size = sizeLabel.safeParse(raw);
    if (!size.success) { ctx.addIssue({ code: 'custom', path: ['sizes'], message: `Size "${raw}": use 1–8 letters or digits, e.g. XS, M, 32, FREE.` }); return z.NEVER; }
    const q = (qtys[i] ?? '').trim() === '' ? 0 : Number(qtys[i]);
    if (!Number.isInteger(q) || q < 0 || q > 100000) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: `Size ${size.data}: enter a whole quantity (0 or more).` }); return z.NEVER; }
    if (sizes.some(x => x.size === size.data)) { ctx.addIssue({ code: 'custom', path: ['sizes'], message: `Size ${size.data} is listed twice.` }); return z.NEVER; }
    sizes.push({ size: size.data, qty: q });
  }
  return { ...rest, sizes };
});

export const newArrivalInput = z.object({ productId, member: onOff });
export const moveNewArrivalInput = z.object({ productId, direction });

export const addVariantInput = z.object({ productId, size: sizeLabel });
/** '' = no override (use the product price); otherwise the same rules and messages as priceInput. */
const optionalPrice = z.string().max(20).transform((v, ctx): number | null => {
  if (v.trim() === '') return null;
  const r = priceInput.safeParse(v);
  if (!r.success) { ctx.addIssue({ code: 'custom', message: r.error.issues[0]?.message ?? 'Enter a valid amount.' }); return z.NEVER; }
  return r.data;
});
export const updateVariantInput = z.object({
  variantId: uuid,
  isActive: onOff,
  price: optionalPrice,                                            // '' = use the product price
  reorderLevel: z.string().max(10).transform((v, ctx) => {                 // '' = use the default from settings
    const s = v.trim();
    if (s === '') return null;
    if (!/^\d{1,6}$/.test(s) || Number(s) > 100_000) { ctx.addIssue({ code: 'custom', message: 'Enter a whole number from 0 to 100,000, or leave it blank.' }); return z.NEVER; }
    return Number(s);
  }),
  /** Version token of the size row when the form was opened (refused if it changed since). */
  expectedVersion: z.string().regex(/^\d{1,20}$/),
});
export const moveVariantInput = z.object({ variantId: uuid, direction });

export const categorySlug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens.').min(2).max(40);
export const createCategoryInput = z.object({
  parentId: categoryId.optional().or(z.literal('').transform(() => undefined)),
  slug: categorySlug,
  label: z.string().trim().min(1, 'Enter a name.').max(60),
  description: z.string().trim().max(300).default(''),
});
export const updateCategoryInput = z.object({
  categoryId, label: z.string().trim().min(1, 'Enter a name.').max(60), description: z.string().trim().max(300).default(''),
  expectedLabel: z.string().max(60),
});
export const setCategoryActiveInput = z.object({ categoryId, active: z.enum(['true', 'false']).transform(v => v === 'true'), expectedActive: z.enum(['true', 'false']).transform(v => v === 'true') });
export const moveCategoryInput = z.object({ categoryId, direction });

/* Product attributes (store filters). Ids/slugs are fixed once created: the store uses them in links (?fabric=cotton). */
export const attributeId = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use 2–40 lower-case letters, digits or hyphens, starting with a letter.');
const attrLabel = z.string().trim().min(1, 'Enter a name.').max(60);
/** Single choice (e.g. Fit) or several values per product (e.g. Colour). */
export const attributeSelection = z.enum(['single', 'multi']).default('multi');
/** The id is optional: when empty it is made from the name (staff never have to type ids). */
export const createAttributeInput = z.object({ id: attributeId.optional().or(z.literal('').transform(() => undefined)), label: attrLabel,
  description: z.string().trim().max(300).default(''), selection: attributeSelection });
export const updateAttributeInput = z.object({ attributeId, label: attrLabel, description: z.string().trim().max(300).default(''), expectedLabel: z.string().max(60),
  selection: attributeSelection });
export const setAttributeActiveInput = z.object({ attributeId, active: z.enum(['true', 'false']).transform(v => v === 'true'), expectedActive: z.enum(['true', 'false']).transform(v => v === 'true') });
export const moveAttributeInput = z.object({ attributeId, direction });
/** Optional colour swatch for colour values: #rrggbb (the colour picker's format). */
const swatch = z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, 'Choose a colour.').optional().or(z.literal('').transform(() => undefined));
export const addAttributeValueInput = z.object({ attributeId, label: attrLabel, slug: categorySlug.optional().or(z.literal('').transform(() => undefined)), swatch });
export const attributeValueRef = z.object({ attributeId, slug: categorySlug });
export const renameAttributeValueInput = attributeValueRef.extend({ label: attrLabel, swatch });
export const setAttributeValueActiveInput = attributeValueRef.extend({ active: z.enum(['true', 'false']).transform(v => v === 'true') });
export const moveAttributeValueInput = attributeValueRef.extend({ direction });
/** The product form sends one checkbox per value, named attr:<attributeId>:<slug>. */
export const setProductAttributesInput = z.object({ productId, values: z.array(z.object({ attributeId, slug: categorySlug })).max(200) });

export type CreateAttributeInput = z.infer<typeof createAttributeInput>;
export type UpdateAttributeInput = z.infer<typeof updateAttributeInput>;
export type SetAttributeActiveInput = z.infer<typeof setAttributeActiveInput>;
export type AddAttributeValueInput = z.infer<typeof addAttributeValueInput>;
export type RenameAttributeValueInput = z.infer<typeof renameAttributeValueInput>;
export type SetAttributeValueActiveInput = z.infer<typeof setAttributeValueActiveInput>;
export type SetProductAttributesInput = z.infer<typeof setProductAttributesInput>;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const imageMetaInput = z.object({ productId, alt: z.string().trim().max(200).default('') });
export const imageIdInput = z.object({ imageId: uuid });
export const updateImageInput = z.object({ imageId: uuid, alt: z.string().trim().max(200).default('') });
export const moveImageInput = z.object({ imageId: uuid, direction });

export type CreateProductInput = z.infer<typeof createProductInput>;
export type UpdateVariantInput = z.infer<typeof updateVariantInput>;
export type CreateCategoryInput = z.infer<typeof createCategoryInput>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryInput>;
export type SetCategoryActiveInput = z.infer<typeof setCategoryActiveInput>;

export type ProductListQuery = z.infer<typeof productListQuery>;
export type UpdateProductInput = z.infer<typeof updateProductInput>;
export type SetProductStatusInput = z.infer<typeof setProductStatusInput>;
export type UpdatePriceInput = z.infer<typeof updatePriceInput>;
export type StockListQuery = z.infer<typeof stockListQuery>;
export type AdjustStockInput = z.infer<typeof adjustStockInput>;

export type LoginInput = z.infer<typeof loginInput>;
export type InviteStaffInput = z.infer<typeof inviteStaffInput>;
export type UpdateStaffInput = z.infer<typeof updateStaffInput>;
export type SetStaffRolesInput = z.infer<typeof setStaffRolesInput>;
export type SetStaffStatusInput = z.infer<typeof setStaffStatusInput>;
export type CreateRoleInput = z.infer<typeof createRoleInput>;
export type UpdateRoleInput = z.infer<typeof updateRoleInput>;
export type AuditQuery = z.infer<typeof auditQuery>;

/** Form-friendly result for server actions: field errors are keyed by input name. */
export type ActionState = { ok?: boolean; message?: string; fieldErrors?: Record<string, string> };
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) { const k = String(issue.path[0] ?? 'form'); out[k] ??= issue.message; }
  return out;
}

// ======================= customers (M6) =======================
// Shape checks only: every customer operation is scoped to the signed-in customer on the server.

export const signupInput = z.object({ fullName, email, password: newPassword, confirm: z.string() })
  .refine(v => v.password === v.confirm, confirmMatches);
export const verifyEmailInput = z.object({ token: oneTimeToken });

/** Indian mobile number, stored as the 10 digits (an optional +91 / 0 prefix and spaces or hyphens are accepted). */
export const indianMobile = z.string().trim().transform(v => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number.'));
const optionalMobile = z.string().trim().max(20).transform(v => v === '' ? null : v)
  .pipe(z.union([z.null(), indianMobile]));
export const customerProfileInput = z.object({ fullName, phone: optionalMobile.default('') });

import { INDIAN_STATES } from './constants.ts';   // zod-free, also importable alone (@kitsyuu/contracts/constants)
export { INDIAN_STATES };
const optionalLine = z.string().trim().max(200).transform(v => v === '' ? null : v);
export const addressInput = z.object({
  addressId: uuid.optional(),                            // present when editing
  fullName,
  phone: indianMobile,
  line1: z.string().trim().min(3, 'Enter the house number and street.').max(200),
  line2: optionalLine.default(''),
  city: z.string().trim().min(2, 'Enter the city or town.').max(80),
  state: z.enum(INDIAN_STATES, { message: 'Choose a state or union territory.' }),
  pin: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit PIN code.'),
  isDefault: onOff,
});
export const addressIdInput = z.object({ addressId: uuid });
export const sessionIdInput = z.object({ sessionId: uuid });
export const orderNumberInput = z.object({ orderNumber: z.string().trim().regex(/^[A-Z0-9-]{4,40}$/, 'Unknown order.') });

export type SignupInput = z.infer<typeof signupInput>;
export type CustomerProfileInput = z.infer<typeof customerProfileInput>;
export type AddressInput = z.infer<typeof addressInput>;

// ======================= commerce (M7) =======================
// The browser only ever sends WHAT it wants (product, size, quantity, which saved address): prices, stock, discounts, tax
// and totals are always resolved on the server. expectedTotalPaise is only compared, so a customer is never charged an
// amount different from the one they were shown.
/** Units of one size per order line: the existing limit of the store and of order_items (qty between 1 and 10). */
export const MAX_QTY_PER_LINE = 10;
/** Technical cap on lines accepted in one request (not a business rule). */
export const MAX_LINES_PER_REQUEST = 100;
const size = z.string().trim().min(1, 'Choose a size.').max(20, 'Unknown size.');
const qty = z.coerce.number({ message: 'Enter a quantity.' }).int('Enter a whole number.')
  .min(1, 'The quantity must be at least 1.').max(MAX_QTY_PER_LINE, `At most ${MAX_QTY_PER_LINE} per size.`);
/** Third pass: the colour of the size (a Colour value), for products that come in colours; omitted = a product without colours. */
const colourKey = z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40).optional().or(z.literal('').transform(() => undefined)).or(z.null().transform(() => undefined));
export const cartLineInput = z.object({ productId, size, qty, colour: colourKey });
export const cartLineKey = z.object({ productId, size, colour: colourKey });
export const wishlistInput = z.object({ productId });
/** Guest (browser) cart / wishlist merged after login. Invalid lines are dropped, not fatal. */
export const guestMergeInput = z.object({
  cart: z.array(z.unknown()).max(MAX_LINES_PER_REQUEST).default([]),
  wishlist: z.array(z.unknown()).max(MAX_LINES_PER_REQUEST).default([]),
});
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Reload the checkout page and try again.');
export const placeOrderInput = z.object({
  idempotencyKey,
  addressId: z.union([uuid, z.literal('').transform(() => undefined)]).optional()
    .refine(v => v !== undefined, 'Choose a delivery address.'),
  expectedTotalPaise: z.coerce.number().int().min(0),
  /** Client change request: the delivery option chosen at checkout (a zone rate), and a billing address other than the
      delivery address (unticked 'same as delivery'). Both optional: omitted = as before. */
  deliveryRateId: z.union([uuid, z.literal('').transform(() => undefined)]).optional(),
  billingSame: z.union([z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')]).optional().transform(v => v === undefined || v === 'on' || v === 'true'),
  billingAddressId: z.union([uuid, z.literal('').transform(() => undefined)]).optional(),
  /** Second pass: how the customer pays (cash on delivery when the business offers it) and whether to use loyalty points.
      Omitted = online payment, no points (as before). The server decides whether either is possible and what it costs. */
  paymentMethod: z.union([z.enum(['online', 'cod']), z.literal('').transform(() => 'online' as const)]).optional().transform(v => v ?? 'online'),
  usePoints: z.union([z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')]).optional().transform(v => v === 'on' || v === 'true'),
}).superRefine((v, ctx) => { if (!v.billingSame && !v.billingAddressId) ctx.addIssue({ code: 'custom', path: ['billingAddressId'], message: 'Choose the billing address.' }); });
/** What the payment provider's browser widget reported. Provider-specific fields are checked by that provider (signature
    and read-back); here only the shape is limited. */
export const paymentResultInput = z.object({
  orderNumber: orderNumberInput.shape.orderNumber,
  result: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().max(300))
    .refine(r => Object.keys(r).length <= 12, 'We could not verify this payment.'),
});

export type CartLineInput = z.infer<typeof cartLineInput>;
export type PlaceOrderInput = z.infer<typeof placeOrderInput>;
export type PaymentResultInput = z.infer<typeof paymentResultInput>;

// ======================= M8: admin operations =======================
const page = z.coerce.number().int().min(1).max(10_000).default(1);
const searchText = z.string().trim().max(80).optional().transform(v => v || undefined);
const requiredNote = (what: string) => z.string().trim().min(3, `Give a reason; it is kept in the ${what}.`).max(500, 'Keep it under 500 characters.');

/** Customer list filters (2026-10-01: segments, channel, payment method, order count, spend, points, dates, subscription,
    city / state, sort). Every filter is optional and they combine (AND). Empty or malformed values are ignored. */
const optInt = z.string().trim().max(9).optional().transform(v => (v && /^\d+$/.test(v) ? Number(v) : undefined));
const optDate = z.string().trim().max(10).optional().transform(v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined));
export const customerListQuery = z.object({
  q: searchText,
  status: z.enum(['all', 'active', 'disabled']).default('all'),
  verified: z.enum(['all', 'verified', 'unverified']).default('all'),
  orders: z.enum(['all', 'with', 'without']).default('all'),
  segment: z.enum(['all', 'new', 'existing']).catch('all').default('all'),
  channel: z.enum(['all', 'online', 'offline']).catch('all').default('all'),
  payment: z.enum(['all', 'cod', 'online']).catch('all').default('all'),
  minOrders: optInt, maxOrders: optInt, minSpend: optInt, minPoints: optInt, maxPoints: optInt,
  lastOrderFrom: optDate, lastOrderTo: optDate, joinedFrom: optDate, joinedTo: optDate,
  subscribed: z.enum(['all', 'yes', 'no']).catch('all').default('all'),
  place: z.string().trim().max(60).optional().transform(v => v || undefined),
  sort: z.enum(['newest', 'spend', 'orders', 'last_order', 'points']).catch('newest').default('newest'),
  page,
});
export const customerIdInput = z.object({ customerId: uuid });
export const setCustomerStatusInput = z.object({
  customerId: uuid,
  status: z.enum(['active', 'disabled'], { message: 'Choose a status.' }),
  /** The status the staff member saw: the change is refused if it changed since. */
  expectedStatus: z.enum(['active', 'disabled']),
  note: requiredNote('audit log'),
}).refine(v => v.status !== v.expectedStatus, { path: ['status'], message: 'The account already has this status.' });
/** Contact details staff may correct. The email is the login identity and is not editable here. */
export const updateCustomerContactInput = z.object({ customerId: uuid, fullName, phone: optionalMobile.default('') });

export const PAYMENT_EXCEPTION_KINDS = ['captured_after_cancel', 'amount_mismatch', 'duplicate_capture', 'paid_without_capture'] as const;
export type PaymentExceptionKind = typeof PAYMENT_EXCEPTION_KINDS[number];
export const paymentListQuery = z.object({
  q: searchText,
  status: z.enum(['all', 'created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded']).default('all'),
  provider: z.string().trim().regex(/^(all|[a-z][a-z0-9_]{1,31})$/).default('all'),
  // Exceptions of a payment row (orders marked paid without any capture are listed in the exceptions queue).
  exception: z.enum(['all', 'any', 'captured_after_cancel', 'amount_mismatch', 'duplicate_capture']).default('all'),
  page,
});
export const paymentEventListQuery = z.object({
  q: searchText,
  provider: z.string().trim().regex(/^(all|[a-z][a-z0-9_]{1,31})$/).default('all'),
  outcome: z.string().trim().regex(/^(all|[a-z_]{1,40})$/).default('all'),
  page,
});
/** Records that money received for an already-cancelled order must be refunded manually (payment exception only). */
export const recordManualRefundInput = z.object({ paymentId: uuid, note: requiredNote('audit log') });

export const settingUpdateInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*)+$/, 'Unknown setting.'),
  value: z.string().max(500),
});

export const PACKING_STATES = ['not_started', 'packing', 'packed'] as const;
export const packingStateInput = z.object({ orderId: uuid, packingState: z.enum(PACKING_STATES, { message: 'Choose a packing state.' }) });
export const shipmentTrackingInput = z.object({
  orderId: uuid,
  carrierCode: updateOrderStatusInput.shape.carrierCode,
  trackingNumber: updateOrderStatusInput.shape.trackingNumber,
});

export type CustomerListQuery = z.infer<typeof customerListQuery>;
export type SetCustomerStatusInput = z.infer<typeof setCustomerStatusInput>;
export type UpdateCustomerContactInput = z.infer<typeof updateCustomerContactInput>;
export type PaymentListQuery = z.infer<typeof paymentListQuery>;
export type PaymentEventListQuery = z.infer<typeof paymentEventListQuery>;
export type RecordManualRefundInput = z.infer<typeof recordManualRefundInput>;
export type SettingUpdateInput = z.infer<typeof settingUpdateInput>;
export type PackingStateInput = z.infer<typeof packingStateInput>;
export type ShipmentTrackingInput = z.infer<typeof shipmentTrackingInput>;

// ---------- M11: collections, "Complete the look", bulk product status ----------
export const collectionId = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single hyphens.').min(2).max(40);
const groupRef = z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/).optional().or(z.literal('').transform(() => undefined)).transform(v => v ?? null);
const seoText = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`).optional().transform(v => v || null);
/** The id is optional: when empty it is made from the name. */
export const createCollectionInput = z.object({ id: collectionId.optional().or(z.literal('').transform(() => undefined)), label: z.string().trim().min(1, 'Enter a name.').max(60),
  groupId: groupRef });
export const updateCollectionInput = z.object({ collectionId, label: z.string().trim().min(1, 'Enter a name.').max(60), expectedLabel: z.string().max(60),
  groupId: groupRef, seoTitle: seoText(70), seoDescription: seoText(160) });
export const createCollectionGroupInput = z.object({ label: z.string().trim().min(1, 'Enter a name.').max(40) });
/** The collections a product is in (the product page's collection picker): the full set, by id. */
export const productCollectionsInput = z.object({ productId, collectionIds: z.array(collectionId).max(100).optional().transform(v => v ?? []) });
export const setCollectionActiveInput = z.object({ collectionId, active: z.enum(['true', 'false']).transform(v => v === 'true'), expectedActive: z.enum(['true', 'false']).transform(v => v === 'true') });
export const moveCollectionInput = z.object({ collectionId, direction: z.enum(['up', 'down']) });
export const collectionMemberInput = z.object({ collectionId, productId });
export const moveCollectionMemberInput = collectionMemberInput.extend({ direction: z.enum(['up', 'down']) });
export const relatedProductInput = z.object({ productId, relatedId: productId });
export const moveRelatedProductInput = relatedProductInput.extend({ direction: z.enum(['up', 'down']) });
export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;
export const bulkProductStatusInput = z.object({ productIds: z.array(productId).min(1, 'Select at least one product.').max(200), status: z.enum(PRODUCT_STATUSES) });
export type CreateCollectionInput = z.infer<typeof createCollectionInput>;
export type UpdateCollectionInput = z.infer<typeof updateCollectionInput>;
export type ProductCollectionsInput = z.infer<typeof productCollectionsInput>;
export type SetCollectionActiveInput = z.infer<typeof setCollectionActiveInput>;
export type BulkProductStatusInput = z.infer<typeof bulkProductStatusInput>;

// ---------- M12: reviews ----------
export const submitReviewInput = z.object({
  orderItemId: uuid,
  rating: z.coerce.number({ message: 'Choose a rating.' }).int().min(1, 'Choose a rating.').max(5),
  title: z.string().trim().max(80, 'Keep the title under 80 characters.').transform(v => v || null),
  body: z.string().trim().min(10, 'Write at least a sentence (10 characters).').max(2000, 'Keep it under 2000 characters.'),
  displayName: z.string().trim().min(1, 'Enter the name to show.').max(40),
});
export const moderateReviewInput = z.object({
  reviewId: uuid,
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(300).optional().transform(v => v || null),
  expectedStatus: z.enum(['pending', 'approved', 'rejected']),
});
export type SubmitReviewInput = z.infer<typeof submitReviewInput>;
export type ModerateReviewInput = z.infer<typeof moderateReviewInput>;

// ---------- M13: vendors, materials, purchasing ----------
const optText = (max: number) => z.string().trim().max(max).optional().transform(v => v || null);
/** A quantity of material, up to 3 decimals (numeric(14,3) in the database). */
const materialQty = z.string().trim().regex(/^-?\d{1,10}(\.\d{1,3})?$/, 'Enter a number, up to 3 decimals.').transform(Number);
export const vendorInput = z.object({
  vendorId: uuid.optional().or(z.literal('').transform(() => undefined)),
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  contact: optText(120),
  email: z.string().trim().toLowerCase().max(254).optional().transform(v => v || null).pipe(z.email('Enter a valid email.').nullable()),
  phone: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^[+0-9 ()-]{6,20}$/, 'Digits, spaces and + ( ) - only.').nullable()),
  gstin: z.string().trim().toUpperCase().optional().transform(v => v || null).pipe(z.string().regex(/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/, 'A GSTIN has 15 characters.').nullable()),
  address: optText(400),
  notes: optText(1000),
});
/** The finished products a vendor supplies (2026-10-01), chosen several at once. */
export const vendorProductsInput = z.object({ vendorId: uuid, productIds: z.array(productId).max(500).optional().transform(v => v ?? []) });
export const setVendorActiveInput = z.object({ vendorId: uuid, active: z.enum(['true', 'false']).transform(v => v === 'true') });
export const materialInput = z.object({
  materialId: uuid.optional().or(z.literal('').transform(() => undefined)),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/, 'Use 2–40 capital letters, digits or hyphens.').optional(),
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  unit: z.string().trim().min(1, 'Enter the unit (m, kg, pcs…).').max(20),
  reorderLevel: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Enter a number, up to 3 decimals.').transform(Number).nullable()),
  notes: optText(1000),
});
export const adjustMaterialInput = z.object({
  materialId: uuid,
  reason: z.enum(['correction', 'damage']),
  delta: materialQty.refine(n => n !== 0, 'Enter a change other than zero.'),
  note: z.string().trim().min(1, 'Give a short reason.').max(300),
});
export const createPurchaseOrderInput = z.object({
  vendorId: uuid,
  expectedOn: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.').nullable()),
  notes: optText(1000),
});
/** One purchase order for ONE vendor with SEVERAL materials at once (client change request): a row per material; rows
    with no quantity are left out. Costs are optional (taken only from staff with costs.read). */
export const purchaseOrderWithLinesInput = z.object({
  vendorId: uuid,
  expectedOn: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.').nullable()),
  notes: optText(1000),
  /** 2026-10-01: where product lines are received (empty = the online stock). */
  locationId: uuid.optional().or(z.literal('').transform(() => undefined)),
  materialIds: z.array(uuid).max(200).optional().transform(v => v ?? []),
  /** 2026-10-01: one entry per row, "v:<product size id>" or "m:<material id>" (replaces materialIds when present). */
  items: z.array(z.string().regex(/^[vm]:[0-9a-f-]{36}$/i, 'Reload the page and try again.')).max(400).optional().transform(v => v ?? []),
  qtys: z.array(z.string().trim().max(20)).max(400).optional().transform(v => v ?? []),
  costs: z.array(z.string().trim().max(20)).max(400).optional().transform(v => v ?? []),
}).transform((v, ctx) => {
  const ids = v.items.length ? v.items : v.materialIds.map(id => `m:${id}`);
  if (ids.length !== v.qtys.length || ids.length !== v.costs.length) { ctx.addIssue({ code: 'custom', message: 'Reload the page and try again.' }); return z.NEVER; }
  const lines: { materialId?: string; variantId?: string; qty: number; unitCostPaise: number | null }[] = [];
  for (const [i, item] of ids.entries()) {
    if (!v.qtys[i]) continue;
    const isProduct = item.startsWith('v:'), id = item.slice(2);
    const qty = Number(v.qtys[i]), cost = v.costs[i] ? Number(v.costs[i].replace(/[₹,\s]/g, '')) : null;
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9 || Math.round(qty * 1000) !== qty * 1000) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Quantities must be numbers above 0 (up to 3 decimals).' }); return z.NEVER; }
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) { ctx.addIssue({ code: 'custom', path: ['costs'], message: 'Enter unit prices in rupees.' }); return z.NEVER; }
    if (isProduct && !Number.isInteger(qty)) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Products are ordered in whole pieces.' }); return z.NEVER; }
    lines.push({ ...(isProduct ? { variantId: id } : { materialId: id }), qty, unitCostPaise: cost === null ? null : Math.round(cost * 100) });
  }
  if (!lines.length) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Enter a quantity for at least one product or material.' }); return z.NEVER; }
  if (new Set(lines.map(l => l.variantId ?? l.materialId)).size !== lines.length) { ctx.addIssue({ code: 'custom', message: 'An item is listed twice.' }); return z.NEVER; }
  return { vendorId: v.vendorId, expectedOn: v.expectedOn, notes: v.notes, locationId: v.locationId ?? null, lines };
});
export const poLineInput = z.object({
  purchaseOrderId: uuid,
  /** "v:<product size id>" or "m:<material id>" (2026-10-01); materialId alone still works. */
  item: z.string().regex(/^[vm]:[0-9a-f-]{36}$/i).optional(),
  materialId: uuid.optional(),
  qty: materialQty.refine(n => n > 0, 'Enter a quantity above zero.'),
  unitCost: z.string().trim().optional(),
}).transform(({ unitCost, item, materialId, ...rest }) => ({ ...rest, ...(item?.startsWith('v:') ? { variantId: item.slice(2) } : { materialId: item ? item.slice(2) : materialId }),
  unitCostPaise: unitCost ? Math.round(Number(unitCost.replace(/[₹,\s]/g, '')) * 100) : null }))
  .refine(v => v.unitCostPaise === null || (Number.isInteger(v.unitCostPaise) && v.unitCostPaise >= 0), { message: 'Enter the unit cost in rupees.', path: ['unitCost'] });
export const removePoLineInput = z.object({ purchaseOrderId: uuid, lineId: uuid });
export const poStatusInput = z.object({
  purchaseOrderId: uuid,
  status: z.enum(['approved', 'ordered', 'cancelled', 'closed', 'draft']),
  expectedStatus: z.enum(['draft', 'approved', 'ordered', 'partially_received', 'received', 'closed', 'cancelled']),
  note: optText(300),
});
export const receiveGoodsInput = z.object({
  purchaseOrderId: uuid,
  lines: z.array(z.object({ lineId: uuid, qty: materialQty.refine(n => n > 0, 'Quantities must be above zero.') })).max(200),
  note: optText(500),
  /** The vendor's delivery note / invoice number (2026-10-01). */
  vendorRef: optText(60),
});
export type VendorInputT = z.infer<typeof vendorInput>;

// ---------- M14: production and quality control ----------
const wholeQty = (msg: string) => z.coerce.number({ message: msg }).int(msg).min(0, msg).max(100000);
export const createProductionOrderInput = z.object({
  variantId: uuid,
  qty: z.coerce.number({ message: 'Enter how many pieces.' }).int('Enter whole pieces.').min(1, 'Enter how many pieces.').max(100000),
  dueOn: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.').nullable()),
  notes: z.string().trim().max(1000).optional().transform(v => v || null),
});
/** Several sizes at once (2026-10-01): items[] "v:<size id>" with qtys[] (costs[] from the shared row picker is ignored). */
export const createProductionBatchInput = z.object({
  items: z.array(z.string().regex(/^v:[0-9a-f-]{36}$/i, 'Reload the page and try again.')).max(400).optional().transform(v => v ?? []),
  qtys: z.array(z.string().trim().max(10)).max(400).optional().transform(v => v ?? []),
  dueOn: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.').nullable()),
  notes: z.string().trim().max(1000).optional().transform(v => v || null),
  batchRef: z.string().trim().max(40).optional().transform(v => v || null),
}).transform((v, ctx) => {
  if (v.items.length !== v.qtys.length) { ctx.addIssue({ code: 'custom', message: 'Reload the page and try again.' }); return z.NEVER; }
  const lines = [];
  for (const [i, item] of v.items.entries()) {
    if (!v.qtys[i]) continue;
    const qty = Number(v.qtys[i]);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Enter whole pieces (1 or more).' }); return z.NEVER; }
    lines.push({ variantId: item.slice(2), qty });
  }
  if (!lines.length) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Enter how many pieces for at least one size.' }); return z.NEVER; }
  return { lines, dueOn: v.dueOn, notes: v.notes, batchRef: v.batchRef };
});
export const linkProductionPoInput = z.object({
  productionOrderIds: z.array(uuid).min(1, 'Select at least one production order.').max(200),
  purchaseOrderId: z.string().uuid({ message: 'Choose a purchase order.' }),
});
export const productionInputInput = z.object({
  productionOrderId: uuid, materialId: uuid,
  qtyPlanned: z.string().trim().optional().transform(v => v || null).pipe(z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Enter a number, up to 3 decimals.').transform(Number).nullable()),
});
export const consumeMaterialInput = z.object({
  productionOrderId: uuid, materialId: uuid,
  qty: z.string().trim().regex(/^\d{1,10}(\.\d{1,3})?$/, 'Enter a number, up to 3 decimals.').transform(Number).refine(n => n > 0, 'Enter a quantity above zero.'),
});
export const productionStatusInput = z.object({
  productionOrderId: uuid,
  status: z.enum(['in_progress', 'cancelled']),
  expectedStatus: z.enum(['planned', 'in_progress', 'completed', 'cancelled']),
  note: z.string().trim().max(300).optional().transform(v => v || null),
});
export const qualityCheckInput = z.object({
  productionOrderId: uuid,
  passed: wholeQty('Enter the pieces that passed (0 or more).'),
  rejected: wholeQty('Enter the rejected pieces (0 or more).'),
  rejectReason: z.string().trim().max(300).optional().transform(v => v || null),
  note: z.string().trim().max(500).optional().transform(v => v || null),
});

// ---------- M15: stock counts and stock value ----------
export const openStockCountInput = z.object({ note: z.string().trim().max(300).optional().transform(v => v || null),
  locationId: uuid.optional().or(z.literal('').transform(() => undefined)) });   // third pass: counts are per location
export const stockCountIdInput = z.object({ stockCountId: uuid });
export const variantCostInput = z.object({ variantId: uuid, unitCost: z.string().trim().optional() })
  .transform(({ variantId, unitCost }) => ({ variantId, unitCostPaise: unitCost ? Math.round(Number(unitCost.replace(/[₹,\s]/g, '')) * 100) : null }))
  .refine(v => v.unitCostPaise === null || (Number.isInteger(v.unitCostPaise) && v.unitCostPaise >= 0 && v.unitCostPaise <= 100_000_000), { message: 'Enter the cost in rupees.', path: ['unitCost'] });

// ---------- M17: store content and customer notes ----------
export const announcementInput = z.object({
  text: z.string().trim().min(1, 'Write the announcement.').max(140, 'Keep it under 140 characters.'),
  href: z.string().trim().optional().transform(v => v || null)
    .pipe(z.string().regex(/^(\/[^\s]*|https:\/\/[^\s]+)$/, 'The link must start with / (a store page) or https://.').nullable()),
  publish: z.enum(['yes', 'no']).default('no').transform(v => v === 'yes'),
});
export const customerNoteInput = z.object({ customerId: uuid, body: z.string().trim().min(1, 'Write the note.').max(1000, 'Keep notes under 1000 characters.') });

// ERP modules 1–8 (pricing, shipping, returns, marketing, support, finance, carts, notifications).
export * from './erp.ts';

// ======================= client change request, second pass =======================
// Shape only; permissions and every business check are in @kitsyuu/core (cod.ts, loyalty.ts, order-edit.ts).
const reqNote = (max: number) => z.string().trim().min(1, 'Give a reason; it is kept in the history.').max(max);
const optNote = (max: number) => z.string().trim().max(max).optional().transform(v => v || null);
const amountInRupees = z.string().trim().max(20).transform((v, ctx) => {
  const p = rupeesToPaise(v);
  if (p === null) { ctx.addIssue({ code: 'custom', message: 'Enter an amount in rupees, e.g. 1299 or 1299.50.' }); return z.NEVER; }
  return p;
});
const checked = z.union([z.literal('on'), z.literal('true'), z.literal('false'), z.literal('')]).optional().transform(v => v === 'on' || v === 'true');

export const codCollectInput = z.object({ orderId: uuid, amount: amountInRupees, reference: optNote(100), note: optNote(300) });
export const codCancelInput = z.object({ orderId: uuid, kind: z.enum(['cancel', 'refused']), note: reqNote(300), restock: checked });

export const loyaltyAdjustInput = z.object({
  customerId: uuid,
  points: z.string().trim().regex(/^-?\d{1,7}$/, 'Enter a whole number of points, e.g. 100 or -50.').transform(Number).refine(n => n !== 0, 'Enter a number other than 0.'),
  reason: reqNote(300),
});
export const loyaltyImportInput = z.object({ text: z.string().max(200_000), reason: reqNote(300) });
export const loyaltyListQuery = z.object({ q: z.string().trim().max(80).optional().transform(v => v || undefined), page: z.coerce.number().int().min(1).max(10_000).default(1) });

/** Staff edit of an order before it ships: every line's size and quantity (0 removes the line), optionally a new
    delivery address, and the reason. expectedTotalPaise is the total the page showed (refused if the order changed). */
export const orderEditInput = z.object({
  orderId: uuid, expectedTotalPaise: z.coerce.number().int().min(0), note: reqNote(500),
  itemIds: z.array(uuid).max(100).optional().transform(v => v ?? []),
  variantIds: z.array(uuid).max(100).optional().transform(v => v ?? []),
  qtys: z.array(z.string().trim().max(3)).max(100).optional().transform(v => v ?? []),
  changeAddress: checked,
  fullName: z.string().trim().max(120).optional(), phone: z.string().trim().max(20).optional(), line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(), city: z.string().trim().max(80).optional(), state: z.string().trim().max(60).optional(), pin: z.string().trim().max(10).optional(),
  /** 2026-10-01: a size added, the delivery option, contact details and the staff discount. */
  addVariantId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  addQty: z.string().trim().max(3).optional(),
  deliveryRateId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  changeContact: checked,
  contactName: z.string().trim().max(120).optional(), contactEmail: z.string().trim().toLowerCase().max(254).optional(), contactPhone: z.string().trim().max(20).optional(),
  staffDiscountPercent: z.string().trim().max(6).optional(), staffDiscountReason: z.string().trim().max(200).optional(),
}).transform((v, ctx) => {
  if (v.itemIds.length !== v.variantIds.length || v.itemIds.length !== v.qtys.length || !v.itemIds.length) { ctx.addIssue({ code: 'custom', message: 'Reload the order and try again.' }); return z.NEVER; }
  const lines = v.itemIds.map((itemId, i) => ({ itemId, variantId: v.variantIds[i], qty: Number(v.qtys[i]) }));
  if (lines.some(l => !Number.isInteger(l.qty) || l.qty < 0 || l.qty > 10)) { ctx.addIssue({ code: 'custom', path: ['qtys'], message: 'Quantities are whole numbers from 0 (remove) to 10.' }); return z.NEVER; }
  let address = null;
  if (v.changeAddress) {
    const a = addressInput.omit({ addressId: true, isDefault: true }).safeParse({ fullName: v.fullName ?? '', phone: v.phone ?? '', line1: v.line1 ?? '', line2: v.line2 ?? '', city: v.city ?? '', state: v.state ?? '', pin: v.pin ?? '' });
    if (!a.success) { for (const i of a.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message }); return z.NEVER; }
    address = a.data;
  }
  const add = [];
  if (v.addVariantId) {
    const q = Number(v.addQty || '1');
    if (!Number.isInteger(q) || q < 1 || q > 10) { ctx.addIssue({ code: 'custom', path: ['addQty'], message: 'Enter a quantity from 1 to 10.' }); return z.NEVER; }
    add.push({ variantId: v.addVariantId, qty: q });
  }
  let contact = null;
  if (v.changeContact) {
    const email = v.contactEmail || null, phone = v.contactPhone || null;
    if (email && !z.email().safeParse(email).success) { ctx.addIssue({ code: 'custom', path: ['contactEmail'], message: 'Enter a valid email address.' }); return z.NEVER; }
    if (phone && !/^(\+91[\s-]?)?[6-9]\d{9}$/.test(phone.replace(/\s/g, ''))) { ctx.addIssue({ code: 'custom', path: ['contactPhone'], message: 'Enter a 10-digit Indian mobile number.' }); return z.NEVER; }
    if (!email && !phone) { ctx.addIssue({ code: 'custom', path: ['contactEmail'], message: 'Keep an email or a mobile number.' }); return z.NEVER; }
    contact = { name: v.contactName || null, email, phone };
  }
  let staffDiscount = null;
  if (v.staffDiscountPercent) {
    const pct = Number(v.staffDiscountPercent);
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(v.staffDiscountPercent) || pct >= 100) { ctx.addIssue({ code: 'custom', path: ['staffDiscountPercent'], message: 'Enter a % from 0 (remove) to 99.' }); return z.NEVER; }
    if (pct > 0 && !v.staffDiscountReason) { ctx.addIssue({ code: 'custom', path: ['staffDiscountReason'], message: 'Give the reason for the discount.' }); return z.NEVER; }
    staffDiscount = { bp: Math.round(pct * 100), reason: v.staffDiscountReason || '' };
  }
  return { orderId: v.orderId, expectedTotalPaise: v.expectedTotalPaise, note: v.note, lines, address, add, deliveryRateId: v.deliveryRateId ?? null, contact, staffDiscount };
});
export type OrderEditInput = z.infer<typeof orderEditInput>;
export const orderEditRefundInput = z.object({ editId: uuid, mode: z.enum(['provider', 'manual']), reference: optNote(100) })
  .superRefine((v, ctx) => { if (v.mode === 'manual' && !v.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the bank or UPI reference of the refund.' }); });

// Third pass: locations, transfers, colour variants.
export * from './third-pass.ts';
export * from './workflows.ts';
