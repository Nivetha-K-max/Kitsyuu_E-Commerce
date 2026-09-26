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

export const loginInput = z.object({ email, password: z.string().min(1, 'Enter your password.').max(128) });

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
  status: z.enum(['all', 'active', 'inactive']).default('all'),
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
  features: z.string().max(4000).transform(v => v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(160, 'Keep each feature under 160 characters.')).max(20, 'At most 20 features.')),
  isFeatured: z.enum(['on', 'off']).default('off').transform(v => v === 'on'),
});

export const setProductStatusInput = z.object({ productId, status: z.enum(['active', 'draft', 'archived']) });
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
});
export const updateOrderStatusInput = z.object({
  orderId: uuid,
  toStatus: z.enum(ORDER_STATUSES, { message: 'Choose the new status.' }),
  /** The status the person saw when they opened the order: the change is refused if it has changed since. */
  expectedStatus: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500, 'Keep the note under 500 characters.').transform(v => v || null),
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

export const createProductInput = z.object({
  name: z.string().trim().min(2, 'Enter a product name.').max(120),
  sku,
  slug: z.string().trim().max(80).optional().transform(v => v || undefined).pipe(slug.optional()),
  categoryId,
  subcategoryId: categoryId.optional().or(z.literal('').transform(() => undefined)),
  price: priceInput,
  description: z.string().trim().max(4000).default(''),
  colourLabel: z.string().trim().max(80).transform(v => v || null).default(''),
});

export const newArrivalInput = z.object({ productId, member: onOff });
export const moveNewArrivalInput = z.object({ productId, direction });

/** Size labels become part of the SKU (product SKU + '-' + size), so they are short and simple. */
export const sizeLabel = z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, 'Use 1–8 letters or digits, e.g. XS, M, 32, FREE.').transform(v => v.toUpperCase());
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
