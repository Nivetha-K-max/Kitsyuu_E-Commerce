// ======================= commerce workflows (2026-10-01) =======================
// Draft orders, staff-created (assisted / offline) orders and staff discounts. Shape only; permissions, stock, limits and
// every business check are in @kitsyuu/core (draft-orders.ts).
import { z } from 'zod';

const uuid = z.uuid();
const optText = (max: number) => z.string().trim().max(max).optional().transform(v => v || null);

export const draftCreateInput = z.object({
  channel: z.enum(['online', 'retail'], { message: 'Choose online (delivered) or in a branch.' }),
  customerId: uuid.optional().or(z.literal('').transform(() => undefined)),
  locationId: uuid.optional().or(z.literal('').transform(() => undefined)),
  contactName: optText(120), contactPhone: optText(20), contactEmail: z.string().trim().toLowerCase().max(254).optional()
    .transform(v => v || null).pipe(z.email('Enter a valid email address.').nullable()),
  note: optText(1000),
});

export const draftItemInput = z.object({
  draftId: uuid,
  variantId: uuid,
  qty: z.coerce.number({ message: 'Enter a quantity.' }).int('Enter a whole number.').min(0).max(10, 'At most 10 of one size.'),
});

const addr = { name: optText(120), phone: optText(20), line1: optText(200), line2: optText(200), city: optText(80), state: optText(80), pin: optText(6) };
const addrOf = (v: Record<string, string | null>, p: 'ship' | 'bill') =>
  ({ name: v[p + 'Name'], phone: v[p + 'Phone'], line1: v[p + 'Line1'], line2: v[p + 'Line2'], city: v[p + 'City'], state: v[p + 'State'], pin: v[p + 'Pin'], country: 'India' });
export const draftAddressesInput = z.object({
  draftId: uuid,
  shipName: addr.name, shipPhone: addr.phone, shipLine1: addr.line1, shipLine2: addr.line2, shipCity: addr.city, shipState: addr.state, shipPin: addr.pin,
  billingSame: z.enum(['on']).optional().transform(v => v === 'on'),
  billName: addr.name, billPhone: addr.phone, billLine1: addr.line1, billLine2: addr.line2, billCity: addr.city, billState: addr.state, billPin: addr.pin,
}).transform(({ draftId, billingSame, ...rest }) => ({ draftId, billingSame, shipping: addrOf(rest, 'ship'), billing: billingSame ? null : addrOf(rest, 'bill') }));

export const draftDiscountInput = z.object({
  draftId: uuid,
  percent: z.string().trim().max(6).optional().transform((v, ctx) => {
    if (!v) return 0;
    const n = Number(v.replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100 || !/^\d{1,3}(\.\d{1,2})?%?$/.test(v)) { ctx.addIssue({ code: 'custom', message: 'Enter a percentage, e.g. 10 or 7.5.' }); return z.NEVER; }
    return n;
  }),
  reason: optText(200),
});

export const draftNoteInput = z.object({ draftId: uuid, note: optText(1000) });
export const draftIdInput = z.object({ draftId: uuid });
export const draftConfirmInput = z.object({
  draftId: uuid,
  payment: z.enum(['online', 'cod', 'cash', 'card', 'upi'], { message: 'Choose how the customer pays.' }),
  expectedTotalPaise: z.coerce.number().int().min(0),
});

export const productMinPriceInput = z.object({
  productId: z.string().trim().min(1).max(40),
  minPrice: z.string().trim().max(20).optional().transform((v, ctx) => {
    if (!v) return null;
    const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(v.replace(/^₹\s*/, '').replace(/,/g, ''));
    if (!m) { ctx.addIssue({ code: 'custom', message: 'Enter an amount in rupees, e.g. 4500.' }); return z.NEVER; }
    return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  }),
});
